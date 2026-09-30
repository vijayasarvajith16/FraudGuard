"""The single-row fast path must equal scikit-learn's score_samples (see app/scorer.py)."""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from conftest import TRAIN, save_model_dir
from sklearn.ensemble import IsolationForest

from app import scorer as scorer_module
from app.model_loader import ModelArtifact, ModelLoadError
from app.scorer import QuickScanScorer


def build(tmp_path, **params):
    model = IsolationForest(random_state=0, **params).fit(TRAIN)
    save_model_dir(tmp_path, model, {"threshold": 0.5})
    artifact = ModelArtifact(Path(tmp_path), "fraudguard-quick-scan", "1", None, "local", {"threshold": 0.5})
    return model, QuickScanScorer(artifact)


@pytest.mark.parametrize(
    "params",
    [
        {"n_estimators": 100, "max_samples": 256},
        {"n_estimators": 30, "max_samples": 1024},
        {"n_estimators": 40, "max_features": 0.5},  # per-tree feature subsets
        {"n_estimators": 20, "max_samples": 1},  # degenerate single-sample trees
    ],
)
def test_fast_path_matches_score_samples(tmp_path, params):
    model, scorer = build(tmp_path, **params)
    rows = pd.DataFrame(
        np.vstack([TRAIN.sample(200, random_state=1).to_numpy(), np.full((5, 30), 25.0), np.zeros((5, 30))]),
        columns=TRAIN.columns,
    )

    expected = -model.score_samples(rows)
    actual = np.array([scorer.score(list(r)).score for r in rows.to_numpy()])

    np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-12)


def test_startup_refuses_to_serve_if_fast_path_deviates(tmp_path, monkeypatch):
    original = scorer_module._SingleRowForest.anomaly_score
    monkeypatch.setattr(scorer_module._SingleRowForest, "anomaly_score", lambda self, x: original(self, x) + 1e-6)

    with pytest.raises(ModelLoadError, match="deviates from scikit-learn"):
        build(tmp_path, n_estimators=10)


def test_missing_internals_are_a_load_error(tmp_path, monkeypatch):
    def broken_init(self, model):
        raise AttributeError("'IsolationForest' object has no attribute '_decision_path_lengths'")

    monkeypatch.setattr(scorer_module._SingleRowForest, "__init__", broken_init)
    with pytest.raises(ModelLoadError, match="unsupported IsolationForest internals"):
        build(tmp_path, n_estimators=10)
