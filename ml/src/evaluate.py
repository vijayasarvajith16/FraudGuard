"""Evaluate FraudGuard models on the held-out test split, and act as a regression gate.

Modes:
    quick    Isolation Forest alone: recall and flag rate at its threshold, PR-AUC of the anomaly score.
    deep     XGBoost alone: PR-AUC, precision/recall/F1 at each tier threshold.
    cascade  (default) the production flow: quick-scan flags -> deep-scan tiers. Reports overall
             recall and precision, recall of the "stopped" tiers (HIGH/CRITICAL), and the
             percentage of transactions that reach deep-scan.

Models are MLflow model URIs: a registry URI such as models:/fraudguard-deep-scan@candidate,
or a local model directory (default: the copies saved by the training scripts).

Exit codes: 0 = all gates passed, 1 = a gate failed, 2 = usage or runtime error.

Examples:
    python src/evaluate.py --data data/creditcard.csv
    python src/evaluate.py --data data/creditcard.csv \\
        --quick-model models:/fraudguard-quick-scan@candidate \\
        --deep-model models:/fraudguard-deep-scan@candidate \\
        --min-recall 0.80 --min-pr-auc 0.75
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import mlflow
import mlflow.sklearn
import mlflow.xgboost
import numpy as np

from common import (
    ARTIFACTS_DIR,
    DEFAULT_SEED,
    DEFAULT_TIER_THRESHOLDS,
    configure_mlflow,
    log,
    setup_logging,
)
from data import load_splits
from metrics import (
    TIERS,
    CascadeResult,
    binary_metrics,
    cascade_metrics,
    deep_scan_metrics,
    pr_curve_figure,
    score_metrics,
    validate_tier_thresholds,
)

DEFAULT_QUICK_MODEL = str(ARTIFACTS_DIR / "quick_scan" / "model")
DEFAULT_DEEP_MODEL = str(ARTIFACTS_DIR / "deep_scan" / "model")


def model_metadata(uri: str) -> dict:
    return mlflow.models.get_model_info(uri).metadata or {}


def load_quick(uri: str, threshold_override: float | None):
    model = mlflow.sklearn.load_model(uri)
    threshold = threshold_override if threshold_override is not None else model_metadata(uri).get("threshold")
    if threshold is None:
        raise ValueError(f"no threshold in model metadata for {uri}; pass --quick-threshold")
    return model, float(threshold)


def load_deep(uri: str):
    return mlflow.xgboost.load_model(uri), model_metadata(uri).get("tier_thresholds")


def check_gates(report: dict, args) -> list[str]:
    """Return the list of failed gates (empty = pass)."""
    failures = []
    headline = report["headline"]
    for name, minimum in (("recall", args.min_recall), ("pr_auc", args.min_pr_auc), ("precision", args.min_precision)):
        if minimum is not None and headline[name] < minimum:
            failures.append(f"{name} {headline[name]:.4f} < required {minimum:.4f}")
    return failures


def evaluate(args) -> tuple[dict, CascadeResult | None, tuple[np.ndarray, np.ndarray] | None]:
    """Return (report, cascade result, (labels, deep probabilities) for plotting)."""
    splits = load_splits(args.data, args.seed)
    split = getattr(splits, args.split)
    y = split.y
    cascade, plot_data = None, None
    report: dict = {"mode": args.mode, "split": args.split, "rows": len(y), "fraud": int(y.sum())}

    if args.mode in ("quick", "cascade"):
        quick_model, quick_threshold = load_quick(args.quick_model, args.quick_threshold)
        quick_scores = -quick_model.score_samples(split.X)
        quick_flagged = quick_scores >= quick_threshold
        quick = {
            **score_metrics(y, quick_scores),
            **{k: v for k, v in binary_metrics(y, quick_flagged).items()},
            "flag_rate": float(quick_flagged.mean()),
            "threshold": quick_threshold,
        }
        report["quick_scan"] = {"model": args.quick_model, **quick}

    if args.mode in ("deep", "cascade"):
        deep_model, stored_thresholds = load_deep(args.deep_model)
        tiers = dict(stored_thresholds or DEFAULT_TIER_THRESHOLDS)
        tiers.update(
            {
                k: v
                for k, v in (("medium", args.tier_medium), ("high", args.tier_high), ("critical", args.tier_critical))
                if v is not None
            }
        )
        validate_tier_thresholds(tiers)
        deep_proba = deep_model.predict_proba(split.X)[:, 1]
        report["deep_scan"] = {
            "model": args.deep_model,
            "tier_thresholds": tiers,
            **deep_scan_metrics(y, deep_proba, tiers),
        }

    if args.mode == "quick":
        q = report["quick_scan"]
        report["headline"] = {"recall": q["recall"], "precision": q["precision"], "pr_auc": q["pr_auc"]}
    elif args.mode == "deep":
        d = report["deep_scan"]
        report["headline"] = {
            "recall": d["recall_at_medium"],
            "precision": d["precision_at_medium"],
            "pr_auc": d["pr_auc"],
        }
    else:
        cascade = cascade_metrics(y, quick_flagged, deep_proba, report["deep_scan"]["tier_thresholds"])
        report["cascade"] = cascade.__dict__
        # PR-AUC gate applies to the deep-scan model, which makes the final call.
        report["headline"] = {
            "recall": cascade.recall,
            "precision": cascade.precision,
            "pr_auc": report["deep_scan"]["pr_auc"],
        }
        plot_data = (y, deep_proba)
    return report, cascade, plot_data


def print_summary(report: dict) -> None:
    lines = [
        f"== FraudGuard evaluation: mode={report['mode']} split={report['split']} "
        f"rows={report['rows']:,} fraud={report['fraud']}"
    ]
    if "quick_scan" in report:
        q = report["quick_scan"]
        lines.append(
            f"quick-scan : threshold={q['threshold']:.4f} flag_rate={100 * q['flag_rate']:.2f}% "
            f"recall={q['recall']:.4f} precision={q['precision']:.4f} PR-AUC={q['pr_auc']:.4f}"
        )
    if "deep_scan" in report:
        d = report["deep_scan"]
        lines.append(f"deep-scan  : PR-AUC={d['pr_auc']:.4f} ROC-AUC={d['roc_auc']:.4f} brier={d['brier']:.5f}")
        for tier in ("medium", "high", "critical"):
            lines.append(
                f"             >= {tier:<8} ({d['tier_thresholds'][tier]:.2f}): "
                f"precision={d[f'precision_at_{tier}']:.4f} "
                f"recall={d[f'recall_at_{tier}']:.4f} F1={d[f'f1_at_{tier}']:.4f}"
            )
    if "cascade" in report:
        c = report["cascade"]
        lines += [
            f"cascade    : recall={c['recall']:.4f} precision={c['precision']:.4f} F1={c['f1']:.4f}",
            f"             stopped (HIGH+CRITICAL): recall={c['recall_high_plus']:.4f} "
            f"precision={c['precision_high_plus']:.4f}",
            f"             deep-scan traffic = {c['deep_scan_traffic_pct']:.2f}% of transactions "
            f"(quick recall {c['quick_recall']:.4f}, deep recall on flagged {c['deep_recall_on_flagged']:.4f})",
            "             tiers: "
            + ", ".join(f"{t}={c['tier_counts'][t]:,} ({c['tier_fraud_counts'][t]} fraud)" for t in TIERS),
        ]
    print("\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--mode", choices=["quick", "deep", "cascade"], default="cascade")
    parser.add_argument("--split", choices=["test", "val"], default="test")
    parser.add_argument("--quick-model", default=DEFAULT_QUICK_MODEL)
    parser.add_argument("--deep-model", default=DEFAULT_DEEP_MODEL)
    parser.add_argument("--quick-threshold", type=float, help="override the threshold stored with the model")
    parser.add_argument("--tier-medium", type=float)
    parser.add_argument("--tier-high", type=float)
    parser.add_argument("--tier-critical", type=float)
    parser.add_argument("--min-recall", type=float, help="gate: fail if headline recall is lower")
    parser.add_argument("--min-pr-auc", type=float, help="gate: fail if PR-AUC is lower")
    parser.add_argument("--min-precision", type=float, help="gate: fail if headline precision is lower")
    parser.add_argument("--output", help="write the full report as JSON here")
    parser.add_argument("--log-to-mlflow", action="store_true", help="record this evaluation as an MLflow run")
    args = parser.parse_args(argv)
    setup_logging()

    try:
        configure_mlflow()
        report, cascade, plot_data = evaluate(args)
    except Exception as exc:
        log.error("evaluation failed: %s", exc)
        return 2

    failures = check_gates(report, args)
    report["gates"] = {
        "min_recall": args.min_recall,
        "min_pr_auc": args.min_pr_auc,
        "min_precision": args.min_precision,
        "passed": not failures,
        "failures": failures,
    }

    print_summary(report)
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(report, indent=2))

    if args.log_to_mlflow:
        with mlflow.start_run(run_name=f"evaluate-{args.mode}-{args.split}"):
            mlflow.set_tags(
                {"model.role": "evaluation", "quick_model": args.quick_model, "deep_model": args.deep_model}
            )
            flat = {f"headline.{k}": v for k, v in report["headline"].items()}
            if cascade is not None:
                flat.update(cascade.as_flat_metrics())
            mlflow.log_metrics(flat)
            mlflow.log_dict(report, "evaluation_report.json")
            if plot_data is not None:
                mlflow.log_figure(
                    pr_curve_figure(*plot_data, f"Deep-scan PR curve ({args.split})"), "plots/pr_curve.png"
                )

    if failures:
        for failure in failures:
            log.error("GATE FAILED: %s", failure)
        return 1
    log.info("all gates passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
