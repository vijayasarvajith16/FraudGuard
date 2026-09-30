"""Shared constants and helpers for the FraudGuard ML pipeline."""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import subprocess
from pathlib import Path

# Feature order is part of the contract (docs/contracts.md §0.8) and of the model signature.
FEATURE_COLUMNS: list[str] = ["Time", *[f"V{i}" for i in range(1, 29)], "Amount"]
LABEL_COLUMN = "Class"

QUICK_SCAN_MODEL_NAME = "fraudguard-quick-scan"
DEEP_SCAN_MODEL_NAME = "fraudguard-deep-scan"
CANDIDATE_ALIAS = "candidate"

# Risk tier thresholds on the deep-scan probability (docs/contracts.md §6.1).
DEFAULT_TIER_THRESHOLDS = {"medium": 0.30, "high": 0.70, "critical": 0.90}

ML_ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS_DIR = ML_ROOT / "artifacts"
DEFAULT_SEED = 42

log = logging.getLogger("fraudguard.ml")


def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Quiet noisy third-party loggers.
    for name in ("mlflow", "urllib3", "alembic"):
        logging.getLogger(name).setLevel(logging.WARNING)
    os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")


def sha256_file(path: str | Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def configure_mlflow(experiment: str | None = None) -> str:
    """Point MLflow at the tracking server from the environment.

    MLFLOW_TRACKING_URI (plus MLFLOW_TRACKING_USERNAME / MLFLOW_TRACKING_PASSWORD for
    DagsHub) come from env vars only. Without a URI, fall back to a local SQLite store
    so the pipeline still runs offline (tests, smoke runs).
    """
    import mlflow

    uri = os.environ.get("MLFLOW_TRACKING_URI")
    if not uri:
        ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        uri = f"sqlite:///{(ARTIFACTS_DIR / 'mlflow.db').as_posix()}"
        log.warning("MLFLOW_TRACKING_URI not set; using local store %s", uri)
    mlflow.set_tracking_uri(uri)
    mlflow.set_experiment(experiment or os.environ.get("MLFLOW_EXPERIMENT_NAME", "fraudguard"))
    return uri


def library_versions() -> dict[str, str]:
    import mlflow
    import numpy
    import pandas
    import sklearn
    import skops
    import xgboost

    return {
        "python": platform.python_version(),
        "numpy": numpy.__version__,
        "pandas": pandas.__version__,
        "scikit-learn": sklearn.__version__,
        "xgboost": xgboost.__version__,
        "mlflow": mlflow.__version__,
        "skops": skops.__version__,
    }


def pip_requirements(*packages: str) -> list[str]:
    """Exact pins for the logged model's environment, taken from the training environment.

    Passing these explicitly is faster and more deterministic than MLflow's inference.
    """
    versions = library_versions()
    return [f"{name}=={versions[name]}" for name in ("mlflow", "numpy", *packages)]


def single_row_latency_ms(predict, row, calls: int = 300) -> dict[str, float]:
    """p50/p95 latency of scoring one row, the way a service calls the model per request."""
    import time

    import numpy as np

    predict(row)  # warm-up
    timings = []
    for _ in range(calls):
        started = time.perf_counter()
        predict(row)
        timings.append((time.perf_counter() - started) * 1000)
    return {"latency_ms_p50": float(np.percentile(timings, 50)), "latency_ms_p95": float(np.percentile(timings, 95))}


def log_figure(fig, artifact_path: str) -> None:
    """Log a matplotlib figure to the active run and free it."""
    import matplotlib.pyplot as plt
    import mlflow

    mlflow.log_figure(fig, artifact_path)
    plt.close(fig)


def git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=ML_ROOT, capture_output=True, text=True, check=True, timeout=5
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def log_run_context(dataset_sha256: str, split_meta: dict) -> None:
    """Log what is needed to reproduce a run: library versions, data identity, code version."""
    import mlflow

    mlflow.log_params({f"lib.{k}": v for k, v in library_versions().items()})
    mlflow.log_params(
        {
            "data.sha256": dataset_sha256,
            "split.seed": split_meta["seed"],
            "split.train_rows": split_meta["splits"]["train"]["rows"],
            "split.val_rows": split_meta["splits"]["val"]["rows"],
            "split.test_rows": split_meta["splits"]["test"]["rows"],
        }
    )
    mlflow.log_dict(split_meta, "split_metadata.json")
    commit = git_commit()
    if commit:
        mlflow.set_tag("git.commit", commit)
