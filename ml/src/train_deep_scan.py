"""Train the deep-scan model: an XGBoost classifier producing a fraud probability.

Class imbalance (~1 fraud per 580 legit rows) is handled with scale_pos_weight, and
the model is judged on PR-AUC and on precision/recall/F1 at the risk-tier thresholds,
never on accuracy. Early stopping monitors validation PR-AUC.

Usage:
    python src/train_deep_scan.py --data data/creditcard.csv [--scale-pos-weight balanced|sqrt|<float>]

Registers the model as `fraudguard-deep-scan` in XGBoost's native JSON format (no pickle),
sets alias `candidate`, and saves a local copy to artifacts/deep_scan/model.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import time

import mlflow
import mlflow.xgboost
import numpy as np
from mlflow import MlflowClient
from mlflow.models import infer_signature
from xgboost import XGBClassifier

from common import (
    ARTIFACTS_DIR,
    CANDIDATE_ALIAS,
    DEEP_SCAN_MODEL_NAME,
    DEFAULT_SEED,
    DEFAULT_TIER_THRESHOLDS,
    configure_mlflow,
    log,
    log_figure,
    log_run_context,
    pip_requirements,
    setup_logging,
    single_row_latency_ms,
)
from data import load_splits
from metrics import TIERS, assign_tiers, confusion_matrix_figure, deep_scan_metrics, pr_curve_figure


def resolve_scale_pos_weight(value: str, y: np.ndarray) -> float:
    ratio = float((y == 0).sum() / max((y == 1).sum(), 1))
    if value == "balanced":
        return ratio
    if value == "sqrt":  # softer weighting: less inflated probabilities, often better precision
        return math.sqrt(ratio)
    return float(value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--scale-pos-weight", default="balanced", help="balanced | sqrt | <float>")
    parser.add_argument("--n-estimators", type=int, default=2000, help="upper bound; early stopping picks the rest")
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--max-depth", type=int, default=5)
    parser.add_argument("--min-child-weight", type=float, default=1.0)
    parser.add_argument("--subsample", type=float, default=0.8)
    parser.add_argument("--colsample-bytree", type=float, default=0.8)
    parser.add_argument("--early-stopping-rounds", type=int, default=100)
    parser.add_argument("--register", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args(argv)
    setup_logging()

    splits = load_splits(args.data, args.seed)
    configure_mlflow()
    tier_thresholds = dict(DEFAULT_TIER_THRESHOLDS)

    params = {
        "n_estimators": args.n_estimators,
        "learning_rate": args.learning_rate,
        "max_depth": args.max_depth,
        "min_child_weight": args.min_child_weight,
        "subsample": args.subsample,
        "colsample_bytree": args.colsample_bytree,
        "scale_pos_weight": resolve_scale_pos_weight(args.scale_pos_weight, splits.train.y),
        "tree_method": "hist",
        "objective": "binary:logistic",
        "eval_metric": "aucpr",
        "early_stopping_rounds": args.early_stopping_rounds,
        "random_state": args.seed,
        "n_jobs": -1,
    }

    with mlflow.start_run(run_name="deep-scan-xgboost") as run:
        log_run_context(splits.dataset_sha256, splits.metadata)
        mlflow.set_tag("model.role", "deep-scan")
        mlflow.log_params({f"model.{k}": v for k, v in params.items()})
        mlflow.log_param("scale_pos_weight_mode", args.scale_pos_weight)
        mlflow.log_params({f"tier.{k}": v for k, v in tier_thresholds.items()})

        model = XGBClassifier(**params)
        started = time.perf_counter()
        model.fit(splits.train.X, splits.train.y, eval_set=[(splits.val.X, splits.val.y)], verbose=False)
        mlflow.log_metric("train_seconds", time.perf_counter() - started)
        mlflow.log_metric("best_iteration", model.best_iteration)
        log.info("early stopping at iteration %d", model.best_iteration)

        val_proba = model.predict_proba(splits.val.X)[:, 1]
        val_metrics = {f"val.{k}": v for k, v in deep_scan_metrics(splits.val.y, val_proba, tier_thresholds).items()}
        tiers = assign_tiers(val_proba, tier_thresholds)
        val_metrics.update({f"val.tier_count.{t}": float(np.sum(tiers == t)) for t in TIERS})

        val_metrics.update(single_row_latency_ms(model.predict_proba, splits.val.X.iloc[[0]]))
        mlflow.log_metrics(val_metrics)

        log_figure(
            pr_curve_figure(splits.val.y, val_proba, "Deep-scan PR curve (validation)", tier_thresholds["medium"]),
            "plots/pr_curve_val.png",
        )
        log_figure(
            confusion_matrix_figure(
                splits.val.y, val_proba >= tier_thresholds["medium"], "Deep-scan at MEDIUM threshold (validation)"
            ),
            "plots/confusion_matrix_val.png",
        )
        importance = dict(zip(splits.train.X.columns, map(float, model.feature_importances_), strict=True))
        mlflow.log_dict(dict(sorted(importance.items(), key=lambda kv: -kv[1])), "feature_importance.json")

        metadata = {
            "tier_thresholds": tier_thresholds,
            "best_iteration": int(model.best_iteration),
            "scale_pos_weight": params["scale_pos_weight"],
            "dataset_sha256": splits.dataset_sha256,
        }
        input_example = splits.val.X.head(3)
        signature = infer_signature(input_example, model.predict_proba(input_example)[:, 1])
        info = mlflow.xgboost.log_model(
            model,
            name="model",
            model_format="json",
            metadata=metadata,
            pip_requirements=pip_requirements("xgboost"),
            signature=signature,
            input_example=input_example,
            registered_model_name=DEEP_SCAN_MODEL_NAME if args.register else None,
        )

        local_path = ARTIFACTS_DIR / "deep_scan" / "model"
        shutil.rmtree(local_path, ignore_errors=True)
        local_path.parent.mkdir(parents=True, exist_ok=True)
        mlflow.xgboost.save_model(
            model,
            path=str(local_path),
            model_format="json",
            metadata=metadata,
            pip_requirements=pip_requirements("xgboost"),
            signature=signature,
            input_example=input_example,
        )

        summary = {"run_id": run.info.run_id, "local_model_path": str(local_path), **val_metrics}
        if args.register:
            version = str(info.registered_model_version)
            client = MlflowClient()
            client.set_model_version_tag(DEEP_SCAN_MODEL_NAME, version, "dataset_sha256", splits.dataset_sha256)
            client.set_registered_model_alias(DEEP_SCAN_MODEL_NAME, CANDIDATE_ALIAS, version)
            summary["registered_version"] = version
            log.info("registered %s version %s as @%s", DEEP_SCAN_MODEL_NAME, version, CANDIDATE_ALIAS)

    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
