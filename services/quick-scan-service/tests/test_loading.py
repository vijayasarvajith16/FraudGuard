"""Model loading rules (docs/contracts.md §4.1): pinned registry versions, fail loudly, explicit fallback."""

from pathlib import Path

import pandas as pd
import pytest
from conftest import TRAIN, save_model_dir, settings_for
from fastapi.testclient import TestClient
from sklearn.ensemble import IsolationForest

from app import model_loader
from app.config import load_settings
from app.main import create_app
from app.model_loader import ModelArtifact, ModelLoadError, fetch_model
from app.scorer import QuickScanScorer


def artifact(path, metadata=None):
    return ModelArtifact(Path(path), "fraudguard-quick-scan", "7", "production", "registry", metadata or {})


def test_startup_fails_loudly_without_registry_or_fallback():
    app = create_app(load_settings({}))
    with pytest.raises(ModelLoadError, match="MLFLOW_TRACKING_URI is not set"), TestClient(app):
        pass


def test_registry_failure_without_fallback_aborts(monkeypatch, model_dir):
    def boom(*_):
        raise ConnectionError("registry down")

    monkeypatch.setattr(model_loader, "fetch_from_registry", boom)
    settings = load_settings({"MLFLOW_TRACKING_URI": "https://example.invalid"})
    with pytest.raises(ModelLoadError, match="registry down"):
        fetch_model(settings, "fraudguard-quick-scan")


def test_registry_failure_uses_local_fallback_only_when_allowed(monkeypatch, model_dir):
    monkeypatch.setattr(model_loader, "fetch_from_registry", lambda *_: (_ for _ in ()).throw(OSError("down")))
    settings = settings_for(model_dir, MLFLOW_TRACKING_URI="https://example.invalid")

    loaded = fetch_model(settings, "fraudguard-quick-scan")
    assert loaded.source == "local"


def test_alias_is_resolved_to_a_version_and_that_version_is_downloaded(monkeypatch, model_dir):
    calls = {}

    class FakeClient:
        def __init__(self, tracking_uri):
            calls["tracking_uri"] = tracking_uri

        def get_model_version_by_alias(self, name, alias):
            calls["alias"] = (name, alias)
            return type("MV", (), {"version": "12"})()

    import mlflow

    monkeypatch.setattr(mlflow, "MlflowClient", FakeClient)
    monkeypatch.setattr(mlflow, "set_tracking_uri", lambda uri: None)
    monkeypatch.setattr(
        mlflow.artifacts, "download_artifacts", lambda uri: calls.setdefault("download", uri) and str(model_dir)
    )

    loaded = model_loader.fetch_from_registry("https://tracking", "models:/fraudguard-quick-scan@production")

    assert calls["alias"] == ("fraudguard-quick-scan", "production")
    assert calls["download"] == "models:/fraudguard-quick-scan/12"  # pinned version, not the alias
    assert (loaded.version, loaded.alias, loaded.source) == ("12", "production", "registry")
    assert loaded.metadata["threshold"] > 0


class FakeRegistry:
    """MlflowClient stand-in: one model version whose training run logged val.flag_rate."""

    def __init__(self, tracking_uri, metrics=None, fail=False):
        self.metrics = {"val.flag_rate": 0.0596} if metrics is None else metrics
        self.fail = fail

    def get_model_version(self, name, version):
        if self.fail:
            raise ConnectionError("registry down")
        return type("MV", (), {"run_id": "run-1"})()

    def get_run(self, run_id):
        return type("Run", (), {"data": type("Data", (), {"metrics": self.metrics})()})()


@pytest.mark.parametrize(
    ("client_kwargs", "expected"),
    [({}, 0.0596), ({"metrics": {}}, None), ({"fail": True}, None)],
)
def test_training_metric_is_read_from_the_versions_run_best_effort(monkeypatch, model_dir, client_kwargs, expected):
    import mlflow

    monkeypatch.setattr(mlflow, "MlflowClient", lambda tracking_uri: FakeRegistry(tracking_uri, **client_kwargs))
    assert model_loader.training_metric("https://tracking", artifact(model_dir), "val.flag_rate") == expected


def test_training_metric_is_none_for_a_local_model(model_dir):
    local = ModelArtifact(Path(model_dir), "fraudguard-quick-scan", "local", None, "local", {})
    assert model_loader.training_metric("https://tracking", local, "val.flag_rate") is None


def test_the_expected_flag_rate_is_exported_per_model_version(monkeypatch, model_dir):
    import app.main

    monkeypatch.setattr(app.main, "training_metric", lambda uri, art, key: 0.0596)
    scorer = QuickScanScorer(artifact(model_dir, {"threshold": 0.5}))
    settings = load_settings({"MLFLOW_TRACKING_URI": "https://tracking"})
    with TestClient(create_app(settings, scorer=scorer)) as client:
        assert 'model_expected_flag_rate{version="7"} 0.0596' in client.get("/metrics").text


def test_missing_threshold_fails(tmp_path, trained_forest):
    save_model_dir(tmp_path, trained_forest, {})
    with pytest.raises(ModelLoadError, match="threshold"):
        QuickScanScorer(artifact(tmp_path))


def test_threshold_override_wins(model_dir):
    scorer = QuickScanScorer(artifact(model_dir, {"threshold": 0.5}), threshold_override=0.42)
    assert scorer.threshold == 0.42


def test_feature_order_mismatch_fails(tmp_path):
    reordered = TRAIN[list(reversed(TRAIN.columns))]
    save_model_dir(tmp_path, IsolationForest(n_estimators=5, random_state=0).fit(reordered), {"threshold": 0.5})
    with pytest.raises(ModelLoadError, match="do not match the contract order"):
        QuickScanScorer(artifact(tmp_path, {"threshold": 0.5}))


def test_types_outside_the_allowlist_are_refused(monkeypatch, model_dir):
    import skops.io as sio

    monkeypatch.setattr(sio, "get_untrusted_types", lambda **_: ["sklearn.tree._tree.Tree", "builtins.eval"])
    with pytest.raises(ModelLoadError, match=r"outside the allowlist: \['builtins.eval'\]"):
        QuickScanScorer(artifact(model_dir, {"threshold": 0.5}))


def test_a_model_that_is_not_an_isolation_forest_is_refused(tmp_path):
    # A Pipeline only contains default-trusted scikit-learn types, so the allowlist alone would accept it.
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    pipe = make_pipeline(StandardScaler(), IsolationForest(n_estimators=5, random_state=0)).fit(pd.DataFrame(TRAIN))
    save_model_dir(tmp_path, pipe, {"threshold": 0.5})
    with pytest.raises(ModelLoadError, match="expected an IsolationForest, got Pipeline"):
        QuickScanScorer(artifact(tmp_path, {"threshold": 0.5}))


def test_missing_model_file_fails(tmp_path):
    (tmp_path / "MLmodel").write_text("metadata: {threshold: 0.5}\n")
    with pytest.raises(ModelLoadError, match=r"model\.skops"):
        QuickScanScorer(artifact(tmp_path))


def test_not_an_mlflow_dir_fails(tmp_path):
    with pytest.raises(ModelLoadError, match="MLmodel"):
        model_loader.fetch_local(str(tmp_path), "fraudguard-quick-scan")


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({"MODEL_URI": "s3://bucket/model"}, "MODEL_URI"),
        ({"ALLOW_LOCAL_MODEL_FALLBACK": "true"}, "LOCAL_MODEL_PATH is required"),
        ({"PORT": "0"}, "PORT"),
        ({"LOG_LEVEL": "LOUD"}, "LOG_LEVEL"),
    ],
)
def test_invalid_config_is_rejected(env, message):
    with pytest.raises(RuntimeError, match=message):
        load_settings(env)
