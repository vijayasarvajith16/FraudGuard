"""Fixtures: a tiny XGBoost model trained with early stopping in test setup, saved in the registry's layout."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
import xgboost as xgb
import yaml
from fastapi.testclient import TestClient

from app.config import load_settings
from app.main import create_app
from app.schemas import FEATURE_COLUMNS

rng = np.random.default_rng(0)
N, N_FRAUD = 4000, 200
_X = rng.normal(size=(N, 30))
_X[:N_FRAUD, 1:6] += 4.0  # fraud: V1..V5 shifted, as in the real PCA features
TRAIN = pd.DataFrame(_X, columns=FEATURE_COLUMNS).assign(
    Time=lambda d: d.Time.abs() * 1000, Amount=lambda d: d.Amount.abs() * 50
)
LABELS = np.r_[np.ones(N_FRAUD), np.zeros(N - N_FRAUD)]


def normal_features() -> dict:
    return {name: float(TRAIN.iloc[N_FRAUD:][name].median()) for name in FEATURE_COLUMNS}


def fraud_features() -> dict:
    features = normal_features()
    features.update({f"V{i}": 6.0 for i in range(1, 6)})
    return features


def train_booster(n_rounds: int = 300) -> xgb.Booster:
    """Early stopping on a validation split, like the real training (sets best_iteration)."""
    idx = rng.permutation(N)
    train, val = idx[: N * 3 // 4], idx[N * 3 // 4 :]
    dtrain = xgb.DMatrix(TRAIN.iloc[train], label=LABELS[train])
    dval = xgb.DMatrix(TRAIN.iloc[val], label=LABELS[val])
    return xgb.train(
        {"objective": "binary:logistic", "eval_metric": "aucpr", "max_depth": 3, "eta": 0.3, "seed": 0},
        dtrain,
        num_boost_round=n_rounds,
        evals=[(dval, "val")],
        early_stopping_rounds=10,
        verbose_eval=False,
    )


def save_model_dir(path, booster: xgb.Booster, metadata: dict) -> None:
    """Write the same files the MLflow registry serves: MLmodel (with metadata) + model.json."""
    path.mkdir(parents=True, exist_ok=True)
    booster.save_model(path / "model.json")
    (path / "MLmodel").write_text(yaml.safe_dump({"flavors": {"xgboost": {}}, "metadata": metadata}))


@pytest.fixture(scope="session")
def booster():
    return train_booster()


@pytest.fixture(scope="session")
def model_dir(tmp_path_factory, booster):
    path = tmp_path_factory.mktemp("deep_model")
    save_model_dir(path, booster, {"best_iteration": booster.best_iteration})
    return path


def settings_for(model_dir, **overrides):
    env = {
        "ALLOW_LOCAL_MODEL_FALLBACK": "true",
        "LOCAL_MODEL_PATH": str(model_dir),
        "CONSUMER_ENABLED": "false",  # HTTP-only; the consumer has its own tests
        **overrides,
    }
    return load_settings(env)


@pytest.fixture
def client(model_dir):
    with TestClient(create_app(settings_for(model_dir))) as c:
        yield c
