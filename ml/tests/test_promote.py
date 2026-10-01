"""promote.py against a throwaway SQLite registry and temporary Helm values files."""

import json
from datetime import UTC, datetime

import pytest
from mlflow import MlflowClient

import promote
from common import CANDIDATE_ALIAS, DEEP_SCAN_MODEL_NAME, PRODUCTION_ALIAS, QUICK_SCAN_MODEL_NAME

FLOORS = {"min_recall": 0.75, "min_pr_auc": 0.78, "min_precision": 0.85}


def report(recall=0.80, precision=0.90, pr_auc=0.82, passed=True, floors=FLOORS, quick="3", deep="3", sha="abc"):
    return {
        "headline": {"recall": recall, "precision": precision, "pr_auc": pr_auc},
        "gates": {**floors, "passed": passed, "failures": [] if passed else ["recall 0.70 < 0.75"]},
        "quick_scan": {"model": f"models:/{QUICK_SCAN_MODEL_NAME}/{quick}"},
        "deep_scan": {"model": f"models:/{DEEP_SCAN_MODEL_NAME}/{deep}"},
        "cascade": {"deep_scan_traffic_pct": 6.1},
        "dataset_sha256": sha,
    }


@pytest.fixture
def registry(tmp_path, monkeypatch):
    """Both models with versions 1-3; production = 2, candidate = 3."""
    uri = f"sqlite:///{(tmp_path / 'registry.db').as_posix()}"
    monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)
    client = MlflowClient(tracking_uri=uri, registry_uri=uri)
    for name in (QUICK_SCAN_MODEL_NAME, DEEP_SCAN_MODEL_NAME):
        client.create_registered_model(name)
        for _ in range(3):
            client.create_model_version(name, source=tmp_path.as_uri())
        client.set_registered_model_alias(name, PRODUCTION_ALIAS, "2")
        client.set_registered_model_alias(name, CANDIDATE_ALIAS, "3")
    return client


def write_values(directory, quick_line="  MODEL_URI: models:/fraudguard-quick-scan/2"):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "values-quick-scan-service.yaml").write_text(
        f'config:\n  PORT: "8001"\n{quick_line}\n  LOG_LEVEL: INFO\n', encoding="utf-8"
    )
    (directory / "values-deep-scan-service.yaml").write_text(
        "config:\n  MODEL_URI: models:/fraudguard-deep-scan@production\n", encoding="utf-8"
    )
    return directory


# ---- resolve -------------------------------------------------------------------------------------


def test_resolve_takes_the_candidate_alias_and_reports_production(registry):
    r = promote.resolve(registry, {"quick": None, "deep": None})
    assert r["quick"] == {"candidate": "3", "production": "2"}
    assert r["deep"] == {"candidate": "3", "production": "2"}
    assert r["same"] is False


def test_resolve_explicit_versions_and_same(registry):
    r = promote.resolve(registry, {"quick": "2", "deep": "2"})
    assert r["same"] is True


def test_resolve_without_production_yet(registry):
    for name in (QUICK_SCAN_MODEL_NAME, DEEP_SCAN_MODEL_NAME):
        registry.delete_registered_model_alias(name, PRODUCTION_ALIAS)
    r = promote.resolve(registry, {"quick": None, "deep": None})
    assert r["quick"]["production"] is None


def test_resolve_cli_fails_on_a_missing_version(registry, tmp_path):
    out = tmp_path / "out.txt"
    assert promote.main(["resolve", "--quick", "9", "--github-output", str(out)]) == 2
    assert not out.exists()


def test_resolve_cli_writes_github_outputs(registry, tmp_path):
    out = tmp_path / "out.txt"
    assert promote.main(["resolve", "--github-output", str(out)]) == 0
    lines = dict(line.split("=", 1) for line in out.read_text().splitlines())
    assert lines == {
        "quick_candidate": "3",
        "deep_candidate": "3",
        "quick_production": "2",
        "deep_production": "2",
        "has_production": "true",
        "same": "false",
    }


def test_registry_commands_refuse_to_run_without_a_tracking_uri(monkeypatch):
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    assert promote.main(["apply", "--quick", "3", "--deep", "3"]) == 2


# ---- decide --------------------------------------------------------------------------------------


def test_decide_promotes_a_candidate_that_passes_and_does_not_regress():
    d = promote.decide(report(recall=0.80), report(recall=0.779, quick="2", deep="2"), 0.01, False)
    assert d.promote and d.reasons == []


def test_decide_rejects_a_candidate_below_a_floor():
    d = promote.decide(report(passed=False), report(quick="2", deep="2"), 0.01, False)
    assert not d.promote
    assert any("floor" in r for r in d.reasons)


def test_decide_rejects_a_regression_beyond_the_tolerance_but_allows_noise():
    production = report(recall=0.80, pr_auc=0.82, quick="2", deep="2")
    assert promote.decide(report(recall=0.795), production, 0.01, False).promote  # within tolerance
    worse = promote.decide(report(recall=0.78), production, 0.01, False)
    assert not worse.promote
    assert any("regression: recall" in r for r in worse.reasons)


def test_allow_regression_skips_the_comparison_but_never_the_floors():
    production = report(recall=0.90, quick="2", deep="2")
    assert promote.decide(report(recall=0.78), production, 0.01, True).promote
    assert not promote.decide(report(passed=False), production, 0.01, True).promote


def test_decide_rejects_a_candidate_evaluated_without_floors():
    floors = {"min_recall": None, "min_pr_auc": 0.78, "min_precision": None}
    d = promote.decide(report(floors=floors), None, 0.01, False)
    assert not d.promote
    assert "recall, precision" in d.reasons[0]


def test_decide_rejects_reports_from_different_datasets():
    d = promote.decide(report(sha="aaa"), report(sha="bbb", quick="2", deep="2"), 0.01, False)
    assert not d.promote


def test_decide_without_production_needs_only_the_floors():
    assert promote.decide(report(), None, 0.01, False).promote


def test_decide_cli_writes_the_decision_and_a_summary(tmp_path):
    candidate, production = tmp_path / "c.json", tmp_path / "p.json"
    candidate.write_text(json.dumps(report(recall=0.82)))
    production.write_text(json.dumps(report(recall=0.779, quick="2", deep="2")))
    out, summary = tmp_path / "out.txt", tmp_path / "summary.md"
    code = promote.main(
        ["decide", "--candidate", str(candidate), "--production", str(production),
         "--github-output", str(out), "--summary", str(summary)]
    )  # fmt: skip
    assert code == 0
    assert out.read_text() == "decision=promote\n"
    text = summary.read_text()
    assert "**promote**" in text
    assert "| Cascade recall | 77.9% | 82.0% | 75.0% |" in text
    assert "| Sent to deep-scan | 6.1% | 6.1% | |" in text


# ---- pin-values ----------------------------------------------------------------------------------


def test_pin_values_rewrites_only_the_model_uri_lines(tmp_path):
    values = write_values(tmp_path / "values")
    changed = promote.pin_values(values, {"quick": "3", "deep": "3"})
    assert len(changed) == 2
    quick = (values / "values-quick-scan-service.yaml").read_text()
    assert quick == 'config:\n  PORT: "8001"\n  MODEL_URI: models:/fraudguard-quick-scan/3\n  LOG_LEVEL: INFO\n'
    deep = (values / "values-deep-scan-service.yaml").read_text()
    assert deep == "config:\n  MODEL_URI: models:/fraudguard-deep-scan/3\n"
    assert promote.pin_values(values, {"quick": "3", "deep": "3"}) == []  # idempotent


def test_pin_values_accepts_a_quoted_uri(tmp_path):
    values = write_values(tmp_path / "values", '  MODEL_URI: "models:/fraudguard-quick-scan@production"')
    promote.pin_values(values, {"quick": "4", "deep": "4"})
    assert "  MODEL_URI: models:/fraudguard-quick-scan/4\n" in (values / "values-quick-scan-service.yaml").read_text()


@pytest.mark.parametrize(
    "quick_line",
    [
        "  LOG_LEVEL: DEBUG",
        "  MODEL_URI: models:/fraudguard-quick-scan/2\n  MODEL_URI: models:/fraudguard-quick-scan/1",
    ],
)
def test_pin_values_refuses_a_file_without_exactly_one_line(tmp_path, quick_line):
    values = write_values(tmp_path / "values", quick_line)
    with pytest.raises(RuntimeError, match="exactly one MODEL_URI"):
        promote.pin_values(values, {"quick": "3", "deep": "3"})


def test_pin_values_from_the_repository_files_is_a_no_op_at_the_current_version():
    current = {}
    for role, filename in promote.VALUES_FILES.items():
        text = (promote.DEFAULT_VALUES_DIR / filename).read_text(encoding="utf-8")
        current[role] = promote._MODEL_URI_LINE.search(text).group(0).rsplit("/", 1)[1]
    assert promote.pin_values(promote.DEFAULT_VALUES_DIR, current) == []


# ---- apply ---------------------------------------------------------------------------------------


def test_apply_moves_production_and_records_the_promotion(registry):
    now = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
    promote.apply(registry, {"quick": "3", "deep": "3"}, report(recall=0.81), "https://ci/run/1", now)
    for name in (QUICK_SCAN_MODEL_NAME, DEEP_SCAN_MODEL_NAME):
        version = registry.get_model_version_by_alias(name, PRODUCTION_ALIAS)
        assert str(version.version) == "3"
        assert version.tags["promotion.run"] == "https://ci/run/1"
        assert version.tags["promotion.promoted_at"] == "2026-10-01T12:00:00+00:00"
        assert version.tags["promotion.test.recall"] == "0.810000"


def test_apply_refuses_a_version_that_does_not_exist(registry):
    with pytest.raises(Exception):  # noqa: B017 (MLflow raises its own exception type)
        promote.apply(registry, {"quick": "9", "deep": "3"}, None, None, datetime.now(UTC))
    assert str(registry.get_model_version_by_alias(QUICK_SCAN_MODEL_NAME, PRODUCTION_ALIAS).version) == "2"
