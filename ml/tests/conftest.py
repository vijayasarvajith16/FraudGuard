"""Shared fixtures: a small synthetic dataset with the real schema, and an isolated MLflow store."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from common import FEATURE_COLUMNS, LABEL_COLUMN

N_ROWS = 6000
FRAUD_RATE = 0.02  # higher than the real 0.17% so tiny splits still contain fraud


def make_synthetic(n_rows: int = N_ROWS, fraud_rate: float = FRAUD_RATE, seed: int = 0) -> pd.DataFrame:
    """Normal rows ~ N(0, 1); fraud rows shifted on a few components, like the real PCA features."""
    rng = np.random.default_rng(seed)
    n_fraud = int(n_rows * fraud_rate)
    X = rng.normal(size=(n_rows, len(FEATURE_COLUMNS)))
    X[:n_fraud, 1:6] += rng.normal(3.0, 0.8, size=(n_fraud, 5))  # V1..V5 shifted
    df = pd.DataFrame(X, columns=FEATURE_COLUMNS)
    df["Time"] = rng.uniform(0, 172_800, size=n_rows)
    df["Amount"] = np.abs(rng.lognormal(3, 1.2, size=n_rows))
    df[LABEL_COLUMN] = 0
    df.loc[: n_fraud - 1, LABEL_COLUMN] = 1
    return df.sample(frac=1, random_state=seed).reset_index(drop=True)


@pytest.fixture
def synthetic_csv(tmp_path):
    path = tmp_path / "creditcard.csv"
    make_synthetic().to_csv(path, index=False)
    return path


def isolate(base, monkeypatch):
    """Point MLflow and the artifacts dir at `base` so tests never touch real state."""
    import common
    import data
    import evaluate
    import train_deep_scan
    import train_quick_scan

    artifacts = base / "artifacts"
    for module in (common, data, train_quick_scan, train_deep_scan):
        monkeypatch.setattr(module, "ARTIFACTS_DIR", artifacts, raising=False)
    monkeypatch.setattr(data, "SPLIT_METADATA_PATH", artifacts / "split_metadata.json")
    monkeypatch.setattr(evaluate, "DEFAULT_QUICK_MODEL", str(artifacts / "quick_scan" / "model"))
    monkeypatch.setattr(evaluate, "DEFAULT_DEEP_MODEL", str(artifacts / "deep_scan" / "model"))
    monkeypatch.setenv("MLFLOW_TRACKING_URI", f"sqlite:///{(base / 'mlflow.db').as_posix()}")
    monkeypatch.setenv("MLFLOW_EXPERIMENT_NAME", "fraudguard-tests")
    return artifacts


@pytest.fixture
def isolated_mlflow(tmp_path, monkeypatch):
    return isolate(tmp_path, monkeypatch)
