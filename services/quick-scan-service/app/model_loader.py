"""Resolve and fetch a model from the MLflow registry, or a local directory in tests (docs/contracts.md §4.1).

MLflow is only used to download files. The caller loads the native model file itself.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

log = logging.getLogger(__name__)

_ALIAS_URI = re.compile(r"^models:/(?P<name>[^/@]+)@(?P<alias>[\w-]+)$")
_VERSION_URI = re.compile(r"^models:/(?P<name>[^/@]+)/(?P<version>\d+)$")


class ModelLoadError(RuntimeError):
    """The model could not be loaded. The service must not start (fail loudly)."""


@dataclass(frozen=True)
class ModelArtifact:
    path: Path
    name: str
    version: str
    alias: str | None
    source: str  # "registry" | "local"
    metadata: dict = field(default_factory=dict)

    def describe(self) -> dict:
        return {"name": self.name, "version": self.version, "alias": self.alias, "source": self.source}


def read_metadata(model_dir: Path) -> dict:
    mlmodel = model_dir / "MLmodel"
    if not mlmodel.is_file():
        raise ModelLoadError(f"{model_dir} is not an MLflow model directory (no MLmodel file)")
    return (yaml.safe_load(mlmodel.read_text(encoding="utf-8")) or {}).get("metadata") or {}


def _configure_mlflow_http() -> None:
    # Fail within seconds rather than MLflow's default multi-minute retry schedule.
    os.environ.setdefault("MLFLOW_HTTP_REQUEST_MAX_RETRIES", "2")
    os.environ.setdefault("MLFLOW_HTTP_REQUEST_TIMEOUT", "20")
    os.environ.setdefault("GIT_PYTHON_REFRESH", "quiet")
    os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")


def fetch_from_registry(tracking_uri: str, model_uri: str) -> ModelArtifact:
    """Resolve an alias to a concrete version, then download exactly that version."""
    _configure_mlflow_http()
    import mlflow
    from mlflow import MlflowClient

    mlflow.set_tracking_uri(tracking_uri)
    client = MlflowClient(tracking_uri=tracking_uri)

    if m := _ALIAS_URI.match(model_uri):
        name, alias = m["name"], m["alias"]
        version = str(client.get_model_version_by_alias(name, alias).version)
    elif m := _VERSION_URI.match(model_uri):
        name, alias, version = m["name"], None, m["version"]
    else:
        raise ModelLoadError(f"unsupported MODEL_URI {model_uri!r}")

    local_dir = Path(mlflow.artifacts.download_artifacts(f"models:/{name}/{version}"))
    return ModelArtifact(local_dir, name, version, alias, "registry", read_metadata(local_dir))


def training_metric(tracking_uri: str | None, artifact: ModelArtifact, key: str) -> float | None:
    """A metric of the training run behind a registry model version (e.g. val.flag_rate), or None.

    Best effort: it feeds monitoring only, so a missing run or metric is logged, never fatal.
    """
    if artifact.source != "registry" or not tracking_uri:
        return None
    try:
        from mlflow import MlflowClient

        client = MlflowClient(tracking_uri=tracking_uri)
        run_id = client.get_model_version(artifact.name, artifact.version).run_id
        value = client.get_run(run_id).data.metrics.get(key) if run_id else None
    except Exception as exc:
        log.warning("training metric unavailable", extra={"metric": key, "error": str(exc)})
        return None
    return None if value is None else float(value)


def fetch_local(path: str, default_name: str) -> ModelArtifact:
    model_dir = Path(path)
    if not model_dir.is_dir():
        raise ModelLoadError(f"LOCAL_MODEL_PATH {path!r} is not a directory")
    return ModelArtifact(model_dir, default_name, "local", None, "local", read_metadata(model_dir))


def fetch_model(settings, default_name: str) -> ModelArtifact:
    """Registry first. Local fallback only when explicitly allowed (tests/offline dev)."""
    if settings.tracking_uri:
        try:
            artifact = fetch_from_registry(settings.tracking_uri, settings.model_uri)
            log.info("model downloaded from registry", extra={"model": artifact.describe()})
            return artifact
        except Exception as exc:
            if not settings.allow_local_fallback:
                raise ModelLoadError(f"cannot load {settings.model_uri} from {settings.tracking_uri}: {exc}") from exc
            log.warning("registry unavailable, using local fallback model", extra={"error": str(exc)})
    elif not settings.allow_local_fallback:
        raise ModelLoadError("MLFLOW_TRACKING_URI is not set and ALLOW_LOCAL_MODEL_FALLBACK is false")

    return fetch_local(settings.local_model_path, default_name)
