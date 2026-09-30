import json

import numpy as np
import pandas as pd
import pytest

import data
from common import FEATURE_COLUMNS
from conftest import make_synthetic


def test_load_dataset_drops_duplicates_and_orders_columns(tmp_path):
    df = make_synthetic(n_rows=500)
    df = pd.concat([df, df.head(10)])[["Class", *reversed(FEATURE_COLUMNS)]]  # dupes + shuffled columns
    path = tmp_path / "d.csv"
    df.to_csv(path, index=False)

    loaded = data.load_dataset(path)

    assert len(loaded) == 500
    assert list(loaded.columns) == [*FEATURE_COLUMNS, "Class"]


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda df: df.drop(columns=["V7"]), "missing columns"),
        (lambda df: df.assign(V3=np.nan), "missing values"),
        (lambda df: df.assign(Class=2), "binary"),
    ],
)
def test_load_dataset_rejects_bad_data(tmp_path, mutate, message):
    path = tmp_path / "d.csv"
    mutate(make_synthetic(n_rows=200)).to_csv(path, index=False)
    with pytest.raises(ValueError, match=message):
        data.load_dataset(path)


def test_split_is_stratified_disjoint_and_deterministic():
    df = make_synthetic()
    train, val, test = data.split_dataset(df, seed=7)

    assert len(train.y) + len(val.y) + len(test.y) == len(df)
    assert set(train.X.index).isdisjoint(val.X.index)
    assert set(train.X.index).isdisjoint(test.X.index)
    assert set(val.X.index).isdisjoint(test.X.index)
    for split in (train, val, test):
        assert split.y.mean() == pytest.approx(df["Class"].mean(), abs=0.004)
    assert len(test.y) == pytest.approx(0.2 * len(df), abs=1)

    again = data.split_dataset(df, seed=7)
    assert list(again[2].X.index) == list(test.X.index)


def test_metadata_describes_split_without_data(synthetic_csv, isolated_mlflow):
    assert data.main(["--data", str(synthetic_csv)]) == 0
    meta = json.loads((isolated_mlflow / "split_metadata.json").read_text())

    assert len(meta["dataset_sha256"]) == 64
    assert meta["splits"]["test"]["fraud"] > 0
    assert set(meta) == {"dataset_sha256", "seed", "fractions", "deduplicated", "features", "splits"}


def test_load_splits_detects_a_different_dataset(synthetic_csv, isolated_mlflow, tmp_path):
    data.main(["--data", str(synthetic_csv)])
    other = tmp_path / "other.csv"
    make_synthetic(seed=99).to_csv(other, index=False)

    with pytest.raises(RuntimeError, match="split differs"):
        data.load_splits(other)
