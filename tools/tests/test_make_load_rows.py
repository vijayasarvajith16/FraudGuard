import json

from conftest import FRAUD_MARKER

import make_load_rows as mlr
from creditcard import FEATURES


def test_writes_only_normal_rows_as_compact_arrays(dataset, tmp_path):
    out = tmp_path / "rows.json"

    assert mlr.main([str(dataset), "--count", "50", "--out", str(out)]) == 0

    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["columns"] == list(FEATURES)
    rows = [dict(zip(doc["columns"], r, strict=True)) for r in doc["rows"]]
    # The fixture's 12 normal rows with Amount > 0: no fraud rows, no zero amounts.
    assert len(rows) == 12
    assert all(r["V1"] != FRAUD_MARKER for r in rows)
    assert all(r["Amount"] > 0 for r in rows)
    assert b"\r\n" not in out.read_bytes()


def test_respects_count_and_max_amount(dataset, tmp_path):
    out = tmp_path / "rows.json"

    assert mlr.main([str(dataset), "--count", "3", "--max-amount", "15", "--out", str(out)]) == 0

    rows = json.loads(out.read_text(encoding="utf-8"))["rows"]
    amount = list(FEATURES).index("Amount")
    assert len(rows) == 3
    assert all(r[amount] <= 15 for r in rows)


def test_refuses_output_over_the_configmap_budget(dataset, tmp_path, monkeypatch):
    out = tmp_path / "rows.json"
    monkeypatch.setattr(mlr, "MAX_BYTES", 100)

    assert mlr.main([str(dataset), "--out", str(out)]) == 1
    assert not out.exists()
