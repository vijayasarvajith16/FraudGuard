import random

import pytest
from conftest import FRAUD_MARKER

from creditcard import FEATURES, collect, read_rows


def test_read_rows_parses_features_and_quoted_labels(dataset):
    rows = list(read_rows(dataset))
    assert len(rows) == 18
    assert list(rows[0].features) == list(FEATURES)
    assert {r.label for r in rows} == {0, 1}
    assert all(r.features["V1"] == FRAUD_MARKER for r in rows if r.label == 1)


def test_read_rows_rejects_a_missing_column(tmp_path):
    path = tmp_path / "bad.csv"
    path.write_text("Time,V1,Amount,Class\n0,1,2,0\n", encoding="utf-8")
    with pytest.raises(ValueError, match="missing columns"):
        list(read_rows(path))


def test_read_rows_rejects_non_finite_values(tmp_path, dataset):
    text = dataset.read_text(encoding="utf-8").splitlines()
    text[1] = text[1].replace("0.0", "nan", 1)
    path = tmp_path / "nan.csv"
    path.write_text("\n".join(text) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match=":2: invalid values"):
        list(read_rows(path))


def test_collect_keeps_every_fraud_row_and_samples_normal_rows(dataset):
    pools = collect(dataset, normal_sample=5, rng=random.Random(1))
    assert len(pools.fraud) == 4
    assert len(pools.normal) == 5
    assert pools.seen_normal == 12
    assert pools.skipped_zero_amount == 2
    assert all(r.amount > 0 for r in pools.fraud + pools.normal)


def test_collect_sample_is_reproducible_and_respects_max_amount(dataset):
    a = collect(dataset, normal_sample=5, rng=random.Random(3), max_amount=20)
    b = collect(dataset, normal_sample=5, rng=random.Random(3), max_amount=20)
    assert [r.features for r in a.normal] == [r.features for r in b.normal]
    assert all(r.amount <= 20 for r in a.normal)
    assert a.fraud == []  # fixture fraud amounts are 50+
