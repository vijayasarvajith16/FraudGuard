import numpy as np
import pytest

from metrics import assign_tiers, binary_metrics, cascade_metrics, select_quick_threshold

TIERS = {"medium": 0.3, "high": 0.7, "critical": 0.9}


def test_quick_threshold_picks_lowest_flag_rate_reaching_target():
    # 10 rows, 2 fraud ranked 1st and 3rd by score.
    scores = np.array([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0])
    y = np.array([1, 0, 1, 0, 0, 0, 0, 0, 0, 0])

    choice = select_quick_threshold(scores, y, target_recall=1.0, max_flag_rate=0.5)

    assert choice.target_met
    assert choice.threshold == pytest.approx(0.7)
    assert choice.flag_rate == pytest.approx(0.3)
    assert choice.recall == 1.0


def test_quick_threshold_falls_back_to_cap_when_target_unreachable():
    scores = np.array([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0])
    y = np.array([1, 0, 0, 0, 0, 0, 0, 0, 0, 1])  # second fraud ranked last

    choice = select_quick_threshold(scores, y, target_recall=1.0, max_flag_rate=0.2)

    assert not choice.target_met
    assert choice.flag_rate == pytest.approx(0.2)
    assert choice.recall == pytest.approx(0.5)


def test_quick_threshold_requires_fraud_in_labels():
    with pytest.raises(ValueError, match="no fraud"):
        select_quick_threshold(np.array([0.1, 0.2]), np.array([0, 0]), 0.9, 0.5)


def test_tiers_use_inclusive_lower_bounds():
    proba = np.array([0.0, 0.2999, 0.3, 0.6999, 0.7, 0.8999, 0.9, 1.0])
    assert list(assign_tiers(proba, TIERS)) == [
        "LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH", "CRITICAL", "CRITICAL",
    ]  # fmt: skip


@pytest.mark.parametrize(
    "bad", [{"medium": 0.7, "high": 0.3, "critical": 0.9}, {"medium": 0, "high": 0.5, "critical": 0.9}]
)
def test_invalid_tier_thresholds_are_rejected(bad):
    with pytest.raises(ValueError):
        assign_tiers(np.array([0.5]), bad)


def test_binary_metrics_handles_no_predictions():
    m = binary_metrics(np.array([1, 0]), np.array([False, False]))
    assert m == {"precision": 0.0, "recall": 0.0, "f1": 0.0, "tp": 0, "fp": 0, "fn": 1}


def test_cascade_ignores_deep_scores_for_unflagged_rows():
    y = np.array([1, 1, 1, 0, 0, 0])
    flagged = np.array([True, True, False, True, False, False])
    # Row 2 (fraud) has a high deep score but quick-scan approved it: it must stay LOW.
    # Row 4 (legit, unflagged) has a high deep score: also LOW.
    proba = np.array([0.95, 0.1, 0.99, 0.75, 0.99, 0.0])

    result = cascade_metrics(y, flagged, proba, TIERS)

    assert result.tier_counts == {"LOW": 4, "MEDIUM": 0, "HIGH": 1, "CRITICAL": 1}
    assert result.deep_scan_traffic_pct == pytest.approx(50.0)
    assert result.quick_recall == pytest.approx(2 / 3)
    assert result.deep_recall_on_flagged == pytest.approx(1 / 2)
    assert result.recall == pytest.approx(1 / 3)  # only row 0 detected
    assert result.precision == pytest.approx(1 / 2)  # rows 0 and 3 detected
    assert result.tier_fraud_counts["CRITICAL"] == 1
    flat = result.as_flat_metrics()
    assert flat["cascade.tier_count.HIGH"] == 1
