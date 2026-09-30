"""Fixtures: a tiny Isolation Forest trained in test setup, saved in the registry's layout."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
import skops.io as sio
import yaml
from fastapi.testclient import TestClient
from sklearn.ensemble import IsolationForest

from app.config import load_settings
from app.main import create_app
from app.schemas import FEATURE_COLUMNS

rng = np.random.default_rng(0)
TRAIN = pd.DataFrame(rng.normal(size=(2000, 30)), columns=FEATURE_COLUMNS).assign(
    Time=lambda d: d.Time.abs() * 1000, Amount=lambda d: d.Amount.abs() * 50
)


def normal_features() -> dict:
    return {name: float(TRAIN[name].median()) for name in FEATURE_COLUMNS}


def anomalous_features() -> dict:
    features = normal_features()
    features.update({f"V{i}": 12.0 for i in range(1, 11)})
    return features


def save_model_dir(path, model, metadata: dict) -> None:
    """Write the same files the MLflow registry serves: MLmodel (with metadata) + model.skops."""
    path.mkdir(parents=True, exist_ok=True)
    sio.dump(model, path / "model.skops")
    (path / "MLmodel").write_text(yaml.safe_dump({"flavors": {"sklearn": {}}, "metadata": metadata}))


@pytest.fixture(scope="session")
def trained_forest():
    return IsolationForest(n_estimators=50, random_state=0).fit(TRAIN)


@pytest.fixture(scope="session")
def model_dir(tmp_path_factory, trained_forest):
    threshold = float(np.quantile(-trained_forest.score_samples(TRAIN), 0.95))
    path = tmp_path_factory.mktemp("quick_model")
    save_model_dir(path, trained_forest, {"threshold": threshold})
    return path


def settings_for(model_dir, **overrides):
    env = {"ALLOW_LOCAL_MODEL_FALLBACK": "true", "LOCAL_MODEL_PATH": str(model_dir), **overrides}
    return load_settings(env)


@pytest.fixture
def client(model_dir):
    with TestClient(create_app(settings_for(model_dir))) as c:
        yield c
