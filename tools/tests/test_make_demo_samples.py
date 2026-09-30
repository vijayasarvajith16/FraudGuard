import json

import pytest
from conftest import FRAUD_MARKER, JsonHandler

import make_demo_samples as mds
from creditcard import FEATURES


def quick_handler(version="2"):
    class Handler(JsonHandler):
        def do_POST(self):
            features = self.read_json()["features"]
            # Flag fraud rows and normal rows whose V2 >= 0.10 (fixture rows 10 and 11).
            flagged = features["V1"] == FRAUD_MARKER or features["V2"] >= 0.10
            self.reply(200, {"score": 0.5, "threshold": 0.4, "flagged": flagged, "modelVersion": version})

    return Handler


def deep_handler():
    class Handler(JsonHandler):
        def do_POST(self):
            features = self.read_json()["features"]
            if features["V1"] == FRAUD_MARKER:
                # fixture fraud rows: Time 100..103 -> CRITICAL, CRITICAL, HIGH, MEDIUM
                tier = {100: "CRITICAL", 101: "CRITICAL", 102: "HIGH"}.get(int(features["Time"]), "MEDIUM")
            else:
                tier = "LOW"
            self.reply(200, {"probability": 0.5, "riskTier": tier, "modelVersion": "2"})

    return Handler


def test_generates_the_three_categories_by_the_contract_rules(dataset, serve, tmp_path):
    out = tmp_path / "sampleFeatures.json"
    quick, deep = serve(quick_handler()), serve(deep_handler())

    code = mds.main(
        [str(dataset), "--quick-url", quick.url, "--deep-url", deep.url, "--per-category", "5", "--out", str(out)]
    )

    assert code == 0
    assert b"\r\n" not in out.read_bytes()  # committed file: LF even when generated on Windows
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["models"] == {"quickScan": "2", "deepScan": "2"}
    assert doc["source"] == "creditcard.csv"
    cats = doc["categories"]
    # normal: label 0 and not flagged (rows 0..9; 10 and 11 are flagged, deep LOW -> no category)
    assert len(cats["normal"]) == 5 and all(r["V2"] < 0.10 and r["V1"] == 0 for r in cats["normal"])
    assert sorted(r["Time"] for r in cats["suspicious"]) == [102.0, 103.0]
    assert sorted(r["Time"] for r in cats["fraud"]) == [100.0, 101.0]
    for rows in cats.values():
        for r in rows:
            assert list(r) == list(FEATURES)  # features only: no label
            assert r["Amount"] > 0


def test_refuses_to_write_when_a_category_is_empty(dataset, serve, tmp_path):
    class NeverFlag(JsonHandler):
        def do_POST(self):
            self.read_json()
            self.reply(200, {"flagged": False, "modelVersion": "2"})

    out = tmp_path / "s.json"
    quick = serve(NeverFlag)
    assert mds.main([str(dataset), "--quick-url", quick.url, "--deep-url", quick.url, "--out", str(out)]) == 1
    assert not out.exists()


def test_mixed_model_versions_abort(dataset, serve):
    first = serve(quick_handler("2"))
    second = serve(quick_handler("3"))
    row = {"V1": 0.0, "V2": 0.0}
    results = [mds.ScanClient(first.url).score(row), mds.ScanClient(second.url).score(row)]
    with pytest.raises(RuntimeError, match="several model versions"):
        mds.single_version(results, "quick-scan")


def test_scan_client_reports_http_errors(serve):
    class Broken(JsonHandler):
        def do_POST(self):
            self.read_json()
            self.reply(503, {"error": {"code": "MODEL_NOT_LOADED"}})

    with pytest.raises(RuntimeError, match="HTTP 503"):
        mds.ScanClient(serve(Broken).url).score({})
