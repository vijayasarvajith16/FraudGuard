"""Load the Kaggle Credit Card Fraud CSV and produce a reproducible stratified split.

Usage:
    python src/data.py --data data/creditcard.csv

Writes artifacts/split_metadata.json (row counts, fraud counts, dataset hash, seed),
never the data itself. The split is a pure function of (dataset, seed, fractions),
so every training/evaluation script recomputes it and verifies it against the metadata.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

from common import ARTIFACTS_DIR, DEFAULT_SEED, FEATURE_COLUMNS, LABEL_COLUMN, log, setup_logging, sha256_file

VAL_FRACTION = 0.20
TEST_FRACTION = 0.20
SPLIT_METADATA_PATH = ARTIFACTS_DIR / "split_metadata.json"


@dataclass(frozen=True)
class Split:
    X: pd.DataFrame
    y: np.ndarray


@dataclass(frozen=True)
class Splits:
    train: Split
    val: Split
    test: Split
    metadata: dict
    dataset_sha256: str


def load_dataset(path: str | Path) -> pd.DataFrame:
    """Read the CSV, validate its schema, and drop exact duplicate rows.

    The public dataset contains ~1,000 exact duplicates. Keeping them would let an
    identical row land in both train and test, inflating test metrics.
    """
    df = pd.read_csv(path)
    missing = [c for c in [*FEATURE_COLUMNS, LABEL_COLUMN] if c not in df.columns]
    if missing:
        raise ValueError(f"dataset is missing columns: {missing}")
    df = df[[*FEATURE_COLUMNS, LABEL_COLUMN]]
    if df.isna().any().any():
        raise ValueError("dataset contains missing values")
    if not set(df[LABEL_COLUMN].unique()) <= {0, 1}:
        raise ValueError(f"{LABEL_COLUMN} must be binary 0/1")
    before = len(df)
    df = df.drop_duplicates().reset_index(drop=True)
    log.info(
        "loaded %d rows (%d exact duplicates dropped), %d fraud", len(df), before - len(df), df[LABEL_COLUMN].sum()
    )
    return df


def split_dataset(df: pd.DataFrame, seed: int = DEFAULT_SEED) -> tuple[Split, Split, Split]:
    """Stratified 60/20/20 train/validation/test split."""
    X, y = df[FEATURE_COLUMNS], df[LABEL_COLUMN].to_numpy()
    X_trainval, X_test, y_trainval, y_test = train_test_split(
        X, y, test_size=TEST_FRACTION, stratify=y, random_state=seed
    )
    val_share = VAL_FRACTION / (1 - TEST_FRACTION)
    X_train, X_val, y_train, y_val = train_test_split(
        X_trainval, y_trainval, test_size=val_share, stratify=y_trainval, random_state=seed
    )
    return Split(X_train, y_train), Split(X_val, y_val), Split(X_test, y_test)


def build_metadata(dataset_sha256: str, seed: int, splits: dict[str, Split]) -> dict:
    return {
        "dataset_sha256": dataset_sha256,
        "seed": seed,
        "fractions": {"train": 1 - VAL_FRACTION - TEST_FRACTION, "val": VAL_FRACTION, "test": TEST_FRACTION},
        "deduplicated": True,
        "features": FEATURE_COLUMNS,
        "splits": {
            name: {
                "rows": len(s.y),
                "fraud": int(s.y.sum()),
                "fraud_rate": round(float(s.y.mean()), 6),
            }
            for name, s in splits.items()
        },
    }


def load_splits(data_path: str | Path, seed: int = DEFAULT_SEED, verify: bool = True) -> Splits:
    """Recompute the split and, if split metadata exists, check it describes the same split."""
    dataset_sha256 = sha256_file(data_path)
    train, val, test = split_dataset(load_dataset(data_path), seed)
    metadata = build_metadata(dataset_sha256, seed, {"train": train, "val": val, "test": test})
    if verify and SPLIT_METADATA_PATH.exists():
        saved = json.loads(SPLIT_METADATA_PATH.read_text())
        if (saved["dataset_sha256"], saved["seed"], saved["splits"]) != (
            metadata["dataset_sha256"],
            metadata["seed"],
            metadata["splits"],
        ):
            raise RuntimeError(
                f"split differs from {SPLIT_METADATA_PATH} (different dataset or seed). "
                "Re-run src/data.py if this is intended."
            )
    return Splits(train, val, test, metadata, dataset_sha256)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True, help="path to creditcard.csv")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", default=str(SPLIT_METADATA_PATH), help="where to write split metadata")
    args = parser.parse_args(argv)
    setup_logging()

    splits = load_splits(args.data, args.seed, verify=False)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(splits.metadata, indent=2))
    for name, info in splits.metadata["splits"].items():
        log.info("%-5s rows=%-7d fraud=%-4d rate=%.4f%%", name, info["rows"], info["fraud"], 100 * info["fraud_rate"])
    log.info("split metadata written to %s", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
