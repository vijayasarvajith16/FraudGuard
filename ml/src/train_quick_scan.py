"""Train the quick-scan model: an Isolation Forest that flags anomalous transactions.

Unsupervised: the forest is fitted on the (mostly normal, ~0.17% fraud) training split
without labels. Labels are used only on the validation split to choose the flag threshold:
the lowest flag rate reaching --target-recall, capped at --max-flag-rate.

Usage:
    python src/train_quick_scan.py --data data/creditcard.csv [--target-recall 0.9 --max-flag-rate 0.1]

Registers the model as `fraudguard-quick-scan` (skops format, no pickle), with the
threshold stored in the model metadata and as a version tag, and sets alias `candidate`.
Also saves a local copy to artifacts/quick_scan/model for offline evaluation.
"""

from __future__ import annotations

import argparse
import itertools
import json
import shutil
import time

import mlflow
import numpy as np
import skops.io as sio
from mlflow import MlflowClient
from mlflow.models import infer_signature
from sklearn.ensemble import IsolationForest

from common import (
    ARTIFACTS_DIR,
    CANDIDATE_ALIAS,
    DEFAULT_SEED,
    QUICK_SCAN_MODEL_NAME,
    configure_mlflow,
    log,
    log_figure,
    log_run_context,
    pip_requirements,
    setup_logging,
    single_row_latency_ms,
)
from data import load_splits
from metrics import confusion_matrix_figure, pr_curve_figure, score_metrics, select_quick_threshold

# skops refuses to load types it does not know are safe. This is the complete allowlist
# for an IsolationForest; anything else appearing means the model changed and needs review.
SKOPS_TRUSTED_TYPES = ["sklearn.tree._tree.Tree"]

LATENCY_WARN_MS = 15

# max_features stays 1.0: subsampling features makes scoring ~50% slower (per-tree column
# selection) without a reliable recall gain in experiments.
SEARCH_GRID = {"max_samples": [256, 1024, 4096, 8192]}


def anomaly_scores(model: IsolationForest, X) -> np.ndarray:
    """Higher = more anomalous. The serving contract uses the same definition (docs/contracts.md §4)."""
    return -model.score_samples(X)


def fit_forest(X, params: dict, seed: int) -> IsolationForest:
    # contamination only affects predict(); we choose our own threshold, so leave it "auto".
    model = IsolationForest(random_state=seed, n_jobs=-1, contamination="auto", **params).fit(X)
    # Fit in parallel, but serve single-threaded: the service scores one transaction per
    # request, and a thread pool per call costs more than the scoring itself (~30 ms vs ~3 ms).
    return model.set_params(n_jobs=1)


def search(splits, args) -> tuple[dict, list[dict]]:
    """Small grid search. Objective: lowest flag rate reaching the target recall on validation,
    tie-broken by recall at the flag-rate cap."""
    grid = [dict(zip(SEARCH_GRID, values, strict=True)) for values in itertools.product(*SEARCH_GRID.values())]
    if not args.grid:
        grid = [{"max_samples": args.max_samples}]
    results = []
    for params in grid:
        params = {"n_estimators": args.n_estimators, **params}
        model = fit_forest(splits.train.X, params, args.seed)
        choice = select_quick_threshold(
            anomaly_scores(model, splits.val.X), splits.val.y, args.target_recall, args.max_flag_rate
        )
        results.append(
            {"params": params, "flag_rate": choice.flag_rate, "recall": choice.recall, "met": choice.target_met}
        )
        log.info(
            "grid %s -> flag_rate=%.4f recall=%.4f target_met=%s",
            params,
            choice.flag_rate,
            choice.recall,
            choice.target_met,
        )
    best = min(results, key=lambda r: (not r["met"], r["flag_rate"] if r["met"] else -r["recall"]))
    return best["params"], results


def save_local_copy(model, metadata: dict, signature, input_example) -> str:
    path = ARTIFACTS_DIR / "quick_scan" / "model"
    shutil.rmtree(path, ignore_errors=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    mlflow.sklearn.save_model(
        model,
        path=str(path),
        serialization_format="skops",
        skops_trusted_types=SKOPS_TRUSTED_TYPES,
        metadata=metadata,
        pip_requirements=pip_requirements("scikit-learn", "skops"),
        signature=signature,
        input_example=input_example,
    )
    return str(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--target-recall", type=float, default=0.90)
    parser.add_argument("--max-flag-rate", type=float, default=0.10)
    # Scoring cost is linear in trees (~0.08 ms each): 100 keeps p95 well inside the
    # contract's 20 ms budget (docs/contracts.md §4) once HTTP overhead is added.
    parser.add_argument("--n-estimators", type=int, default=100)
    parser.add_argument("--max-samples", type=int, default=1024, help="used with --no-grid")
    parser.add_argument(
        "--grid", action=argparse.BooleanOptionalAction, default=True, help="small hyperparameter search"
    )
    parser.add_argument("--register", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args(argv)
    setup_logging()

    splits = load_splits(args.data, args.seed)
    configure_mlflow()

    with mlflow.start_run(run_name="quick-scan-isolation-forest") as run:
        log_run_context(splits.dataset_sha256, splits.metadata)
        mlflow.set_tag("model.role", "quick-scan")
        mlflow.log_params(
            {"target_recall": args.target_recall, "max_flag_rate": args.max_flag_rate, "grid_search": args.grid}
        )

        best_params, grid_results = search(splits, args)
        mlflow.log_dict({"results": grid_results}, "grid_search.json")
        mlflow.log_params({f"model.{k}": v for k, v in best_params.items()})

        started = time.perf_counter()
        model = fit_forest(splits.train.X, best_params, args.seed)
        mlflow.log_metric("train_seconds", time.perf_counter() - started)

        val_scores = anomaly_scores(model, splits.val.X)
        choice = select_quick_threshold(val_scores, splits.val.y, args.target_recall, args.max_flag_rate)
        if not choice.target_met:
            log.warning(
                "target recall %.2f not reachable within flag rate %.2f; using best recall %.4f",
                args.target_recall,
                args.max_flag_rate,
                choice.recall,
            )

        latency = single_row_latency_ms(lambda x: anomaly_scores(model, x), splits.val.X.iloc[[0]])
        if latency["latency_ms_p95"] > LATENCY_WARN_MS:
            log.warning("single-row p95 latency %.1f ms exceeds %d ms", latency["latency_ms_p95"], LATENCY_WARN_MS)

        val_metrics = {
            **{f"val.{k}": v for k, v in score_metrics(splits.val.y, val_scores).items()},
            "val.recall": choice.recall,
            "val.flag_rate": choice.flag_rate,
            "val.target_met": float(choice.target_met),
            "threshold": choice.threshold,
            **latency,
        }
        mlflow.log_metrics(val_metrics)
        log_figure(
            pr_curve_figure(splits.val.y, val_scores, "Quick-scan PR curve (validation)", choice.threshold),
            "plots/pr_curve_val.png",
        )
        log_figure(
            confusion_matrix_figure(
                splits.val.y, val_scores >= choice.threshold, "Quick-scan at threshold (validation)"
            ),
            "plots/confusion_matrix_val.png",
        )

        untrusted = sio.get_untrusted_types(data=sio.dumps(model))
        if not set(untrusted) <= set(SKOPS_TRUSTED_TYPES):
            raise RuntimeError(f"model contains types outside the skops allowlist: {untrusted}")

        metadata = {
            "threshold": choice.threshold,
            "score_definition": "-IsolationForest.score_samples(x); flag when score >= threshold",
            "target_recall": args.target_recall,
            "max_flag_rate": args.max_flag_rate,
            "val_recall": choice.recall,
            "val_flag_rate": choice.flag_rate,
            "dataset_sha256": splits.dataset_sha256,
        }
        input_example = splits.val.X.head(3)
        signature = infer_signature(input_example, model.predict(input_example))
        info = mlflow.sklearn.log_model(
            model,
            name="model",
            serialization_format="skops",
            skops_trusted_types=SKOPS_TRUSTED_TYPES,
            metadata=metadata,
            pip_requirements=pip_requirements("scikit-learn", "skops"),
            signature=signature,
            input_example=input_example,
            registered_model_name=QUICK_SCAN_MODEL_NAME if args.register else None,
        )
        local_path = save_local_copy(model, metadata, signature, input_example)

        summary = {"run_id": run.info.run_id, "local_model_path": local_path, **val_metrics, "params": best_params}
        if args.register:
            version = str(info.registered_model_version)
            client = MlflowClient()
            client.set_model_version_tag(QUICK_SCAN_MODEL_NAME, version, "threshold", repr(choice.threshold))
            client.set_model_version_tag(QUICK_SCAN_MODEL_NAME, version, "dataset_sha256", splits.dataset_sha256)
            client.set_registered_model_alias(QUICK_SCAN_MODEL_NAME, CANDIDATE_ALIAS, version)
            summary["registered_version"] = version
            log.info("registered %s version %s as @%s", QUICK_SCAN_MODEL_NAME, version, CANDIDATE_ALIAS)

    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
