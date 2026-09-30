"""Metric helpers shared by training and evaluation.

Accuracy is deliberately absent: with ~0.17% fraud, a model that approves everything
is 99.8% accurate. Everything here is recall/precision/PR-AUC based.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
from sklearn.metrics import average_precision_score, confusion_matrix, precision_recall_curve, roc_auc_score

TIERS = ("LOW", "MEDIUM", "HIGH", "CRITICAL")


@dataclass(frozen=True)
class QuickThreshold:
    threshold: float
    flag_rate: float
    recall: float
    target_recall: float
    max_flag_rate: float
    target_met: bool


def select_quick_threshold(
    scores: np.ndarray, y: np.ndarray, target_recall: float, max_flag_rate: float
) -> QuickThreshold:
    """Pick the anomaly-score threshold for quick-scan (flag when score >= threshold).

    Rule: the smallest flag rate whose recall reaches `target_recall`, as long as that
    flag rate stays within `max_flag_rate`. If the target is out of reach, take the
    best recall available at `max_flag_rate` and report target_met=False.
    """
    if y.sum() == 0:
        raise ValueError("validation labels contain no fraud; cannot choose a threshold")
    order = np.argsort(-scores, kind="stable")
    sorted_scores, sorted_y = scores[order], y[order]
    n, positives = len(y), y.sum()

    recall_at_k = np.cumsum(sorted_y) / positives  # recall when flagging the top k+1 rows
    max_k = max(1, int(np.floor(max_flag_rate * n)))
    reaching = np.flatnonzero(recall_at_k[:max_k] >= target_recall)
    target_met = reaching.size > 0
    k = int(reaching[0]) if target_met else max_k - 1

    threshold = float(sorted_scores[k])
    flagged = scores >= threshold  # ties at the threshold are flagged too
    return QuickThreshold(
        threshold=threshold,
        flag_rate=float(flagged.mean()),
        recall=float(y[flagged].sum() / positives),
        target_recall=target_recall,
        max_flag_rate=max_flag_rate,
        target_met=target_met,
    )


def assign_tiers(probabilities: np.ndarray, thresholds: dict[str, float]) -> np.ndarray:
    """Map deep-scan probabilities to tiers (docs/contracts.md §6.1). Boundaries are inclusive."""
    validate_tier_thresholds(thresholds)
    tiers = np.full(probabilities.shape, "LOW", dtype=object)
    tiers[probabilities >= thresholds["medium"]] = "MEDIUM"
    tiers[probabilities >= thresholds["high"]] = "HIGH"
    tiers[probabilities >= thresholds["critical"]] = "CRITICAL"
    return tiers


def validate_tier_thresholds(t: dict[str, float]) -> None:
    if not 0 < t["medium"] < t["high"] < t["critical"] < 1:
        raise ValueError(f"tier thresholds must satisfy 0 < medium < high < critical < 1, got {t}")


def binary_metrics(y: np.ndarray, predicted: np.ndarray) -> dict[str, float]:
    tp = int(np.sum(predicted & (y == 1)))
    fp = int(np.sum(predicted & (y == 0)))
    fn = int(np.sum(~predicted & (y == 1)))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn}


def score_metrics(y: np.ndarray, scores: np.ndarray) -> dict[str, float]:
    """Threshold-free ranking quality. PR-AUC (average precision) is the headline metric."""
    return {"pr_auc": float(average_precision_score(y, scores)), "roc_auc": float(roc_auc_score(y, scores))}


def best_f1_threshold(y: np.ndarray, scores: np.ndarray) -> tuple[float, float]:
    precision, recall, thresholds = precision_recall_curve(y, scores)
    f1 = np.divide(
        2 * precision * recall, precision + recall, out=np.zeros_like(precision), where=precision + recall > 0
    )
    best = int(np.argmax(f1[:-1]))  # the last PR point has no threshold
    return float(thresholds[best]), float(f1[best])


def deep_scan_metrics(y: np.ndarray, proba: np.ndarray, tier_thresholds: dict[str, float]) -> dict[str, float]:
    metrics = score_metrics(y, proba)
    metrics["brier"] = float(np.mean((proba - y) ** 2))
    for name, thr in tier_thresholds.items():
        for key, value in binary_metrics(y, proba >= thr).items():
            if key in ("precision", "recall", "f1"):
                metrics[f"{key}_at_{name}"] = value
    thr, f1 = best_f1_threshold(y, proba)
    metrics["best_f1"], metrics["best_f1_threshold"] = f1, thr
    return metrics


@dataclass(frozen=True)
class CascadeResult:
    """End-to-end behaviour of quick-scan -> deep-scan on one dataset split."""

    rows: int
    fraud: int
    deep_scan_traffic_pct: float  # share of all transactions sent to deep-scan
    quick_recall: float  # share of fraud that quick-scan flags
    deep_recall_on_flagged: float  # share of flagged fraud that deep-scan marks non-LOW
    recall: float  # fraud ending in any non-LOW tier (some action beyond logging)
    precision: float
    f1: float
    recall_high_plus: float  # fraud that is stopped (OTP step-up or block)
    precision_high_plus: float
    tier_counts: dict
    tier_fraud_counts: dict

    def as_flat_metrics(self, prefix: str = "cascade") -> dict[str, float]:
        flat = {f"{prefix}.{k}": v for k, v in asdict(self).items() if not isinstance(v, dict)}
        flat.update({f"{prefix}.tier_count.{k}": v for k, v in self.tier_counts.items()})
        flat.update({f"{prefix}.tier_fraud.{k}": v for k, v in self.tier_fraud_counts.items()})
        return flat


def cascade_metrics(
    y: np.ndarray, quick_flagged: np.ndarray, deep_proba: np.ndarray, tier_thresholds: dict[str, float]
) -> CascadeResult:
    """Evaluate the cascade. `deep_proba` is only consulted where quick-scan flagged.

    A transaction quick-scan does not flag is APPROVED with tier LOW (docs/contracts.md flow).
    """
    tiers = np.full(y.shape, "LOW", dtype=object)
    tiers[quick_flagged] = assign_tiers(deep_proba[quick_flagged], tier_thresholds)

    detected = tiers != "LOW"
    stopped = np.isin(tiers, ["HIGH", "CRITICAL"])
    overall, stop = binary_metrics(y, detected), binary_metrics(y, stopped)
    flagged_fraud = int(np.sum(quick_flagged & (y == 1)))

    return CascadeResult(
        rows=len(y),
        fraud=int(y.sum()),
        deep_scan_traffic_pct=float(100 * quick_flagged.mean()),
        quick_recall=float(flagged_fraud / y.sum()) if y.sum() else 0.0,
        deep_recall_on_flagged=float(np.sum(detected & (y == 1)) / flagged_fraud) if flagged_fraud else 0.0,
        recall=overall["recall"],
        precision=overall["precision"],
        f1=overall["f1"],
        recall_high_plus=stop["recall"],
        precision_high_plus=stop["precision"],
        tier_counts={t: int(np.sum(tiers == t)) for t in TIERS},
        tier_fraud_counts={t: int(np.sum((tiers == t) & (y == 1))) for t in TIERS},
    )


# ---- plots (matplotlib, headless) ----


def pr_curve_figure(y: np.ndarray, scores: np.ndarray, title: str, marker_threshold: float | None = None):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    precision, recall, thresholds = precision_recall_curve(y, scores)
    fig, ax = plt.subplots(figsize=(6, 4.5))
    ax.plot(recall, precision, lw=2, label=f"PR-AUC = {average_precision_score(y, scores):.3f}")
    ax.axhline(y.mean(), color="grey", ls="--", lw=1, label=f"base rate = {y.mean():.4f}")
    if marker_threshold is not None and len(thresholds):
        i = min(int(np.searchsorted(thresholds, marker_threshold)), len(thresholds) - 1)
        ax.scatter([recall[i]], [precision[i]], color="crimson", zorder=3, label=f"threshold {marker_threshold:.3f}")
    ax.set(xlabel="Recall", ylabel="Precision", title=title, xlim=(0, 1), ylim=(0, 1.02))
    ax.legend(loc="upper right")
    fig.tight_layout()
    return fig


def confusion_matrix_figure(y: np.ndarray, predicted: np.ndarray, title: str):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    cm = confusion_matrix(y, predicted, labels=[0, 1])
    fig, ax = plt.subplots(figsize=(4.5, 4))
    ax.imshow(cm, cmap="Blues")
    for (i, j), v in np.ndenumerate(cm):
        ax.text(j, i, f"{v:,}", ha="center", va="center", color="white" if v > cm.max() / 2 else "black")
    ax.set(
        xticks=[0, 1],
        yticks=[0, 1],
        xticklabels=["legit", "fraud"],
        yticklabels=["legit", "fraud"],
        xlabel="Predicted",
        ylabel="Actual",
        title=title,
    )
    fig.tight_layout()
    return fig
