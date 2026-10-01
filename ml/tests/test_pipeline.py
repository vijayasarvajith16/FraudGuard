"""End-to-end sanity test on a tiny synthetic dataset: train both models, register them,
and run the evaluation gate. Checks the plumbing, not model quality."""

import json

import mlflow
import numpy as np
import pytest
from mlflow import MlflowClient

import data
import evaluate
import train_deep_scan
import train_quick_scan
from common import CANDIDATE_ALIAS, DEEP_SCAN_MODEL_NAME, QUICK_SCAN_MODEL_NAME, sha256_file
from conftest import isolate, make_synthetic


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    """Train both tiny models once for the whole module."""
    base = tmp_path_factory.mktemp("pipeline")
    synthetic_csv = base / "creditcard.csv"
    make_synthetic().to_csv(synthetic_csv, index=False)
    with pytest.MonkeyPatch.context() as mp:
        artifacts = isolate(base, mp)
        yield from _train(synthetic_csv, artifacts)


def _train(synthetic_csv, artifacts):
    assert data.main(["--data", str(synthetic_csv)]) == 0
    assert train_quick_scan.main(["--data", str(synthetic_csv), "--no-grid", "--n-estimators", "50"]) == 0
    assert (
        train_deep_scan.main(["--data", str(synthetic_csv), "--n-estimators", "60", "--early-stopping-rounds", "10"])
        == 0
    )
    yield synthetic_csv, artifacts


def test_models_are_registered_with_candidate_alias_and_metadata(trained):
    client = MlflowClient()
    quick = client.get_model_version_by_alias(QUICK_SCAN_MODEL_NAME, CANDIDATE_ALIAS)
    deep = client.get_model_version_by_alias(DEEP_SCAN_MODEL_NAME, CANDIDATE_ALIAS)

    assert float(quick.tags["threshold"]) > 0
    quick_meta = mlflow.models.get_model_info(f"models:/{QUICK_SCAN_MODEL_NAME}@{CANDIDATE_ALIAS}").metadata
    assert quick_meta["threshold"] == pytest.approx(float(quick.tags["threshold"]))
    deep_meta = mlflow.models.get_model_info(f"models:/{DEEP_SCAN_MODEL_NAME}@{CANDIDATE_ALIAS}").metadata
    assert deep_meta["tier_thresholds"] == {"medium": 0.3, "high": 0.7, "critical": 0.9}
    assert deep.tags["dataset_sha256"] == quick.tags["dataset_sha256"]


def test_no_pickle_formats_are_used(trained):
    _, artifacts = trained
    quick_files = {p.name for p in (artifacts / "quick_scan" / "model").iterdir()}
    deep_files = {p.name for p in (artifacts / "deep_scan" / "model").iterdir()}

    assert "model.skops" in quick_files
    assert "model.json" in deep_files
    assert not any(name.endswith((".pkl", ".pickle")) for name in quick_files | deep_files)


def test_registry_and_local_models_score_identically(trained):
    csv, artifacts = trained
    X = data.load_splits(csv).test.X
    local = mlflow.xgboost.load_model(str(artifacts / "deep_scan" / "model"))
    registry = mlflow.xgboost.load_model(f"models:/{DEEP_SCAN_MODEL_NAME}@{CANDIDATE_ALIAS}")
    np.testing.assert_allclose(local.predict_proba(X), registry.predict_proba(X))


def test_evaluate_reports_cascade_and_passes_lenient_gates(trained, tmp_path, capsys):
    csv, _ = trained
    out = tmp_path / "report.json"

    code = evaluate.main(["--data", str(csv), "--min-recall", "0.1", "--min-pr-auc", "0.1", "--output", str(out)])

    assert code == 0
    report = json.loads(out.read_text())
    cascade = report["cascade"]
    assert 0 < cascade["deep_scan_traffic_pct"] < 100
    assert sum(cascade["tier_counts"].values()) == report["rows"]
    assert report["gates"]["passed"] is True
    assert "deep-scan traffic" in capsys.readouterr().out


def test_evaluate_fails_gate_with_exit_code_1(trained):
    csv, _ = trained
    assert evaluate.main(["--data", str(csv), "--min-recall", "1.01"]) == 1


def test_evaluate_reads_models_from_registry_and_logs_run(trained):
    csv, _ = trained
    code = evaluate.main(
        [
            "--data", str(csv),
            "--quick-model", f"models:/{QUICK_SCAN_MODEL_NAME}@{CANDIDATE_ALIAS}",
            "--deep-model", f"models:/{DEEP_SCAN_MODEL_NAME}@{CANDIDATE_ALIAS}",
            "--log-to-mlflow",
        ]
    )  # fmt: skip
    assert code == 0
    runs = mlflow.search_runs(filter_string="tags.`model.role` = 'evaluation'")
    assert len(runs) == 1
    assert runs.iloc[0]["metrics.cascade.deep_scan_traffic_pct"] > 0


def test_evaluate_refuses_a_dataset_with_an_unexpected_sha256(trained, caplog):
    csv, _ = trained
    assert evaluate.main(["--data", str(csv), "--expect-sha256", "0" * 64]) == 2
    assert "wrong or incomplete file" in caplog.text


def test_evaluate_accepts_the_expected_sha256(trained):
    csv, _ = trained
    assert evaluate.main(["--data", str(csv), "--min-recall", "0.1", "--expect-sha256", sha256_file(csv)]) == 0


def test_evaluate_refuses_registry_models_trained_on_other_data(trained, tmp_path, caplog):
    # A download cut at a row boundary still parses: only the hash tells it apart.
    csv, _ = trained
    lines = csv.read_text().splitlines(keepends=True)
    partial = tmp_path / "partial.csv"
    partial.write_text("".join(lines[: len(lines) // 2]))
    code = evaluate.main(
        [
            "--data", str(partial),
            "--quick-model", f"models:/{QUICK_SCAN_MODEL_NAME}@{CANDIDATE_ALIAS}",
            "--deep-model", f"models:/{DEEP_SCAN_MODEL_NAME}@{CANDIDATE_ALIAS}",
        ]
    )  # fmt: skip
    assert code == 2
    assert "was trained on dataset" in caplog.text


def test_evaluate_returns_2_on_missing_model(synthetic_csv, isolated_mlflow):
    data.main(["--data", str(synthetic_csv)])
    assert evaluate.main(["--data", str(synthetic_csv), "--mode", "quick"]) == 2
