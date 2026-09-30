"""Streaming reader for the Kaggle Credit Card Fraud CSV, shared by the demo tools.

The file has ~285k rows; the tools never hold it in memory. They keep every fraud row
(~490) and a seeded reservoir sample of the normal rows they need.
"""

from __future__ import annotations

import csv
import math
import random
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

FEATURES = ("Time", *(f"V{i}" for i in range(1, 29)), "Amount")
LABEL = "Class"


@dataclass(frozen=True)
class Row:
    features: dict[str, float]
    label: int  # 1 = fraud. Used only for local bookkeeping; never sent to a service.

    @property
    def amount(self) -> float:
        return self.features["Amount"]


def read_rows(path: str | Path) -> Iterator[Row]:
    """Yield validated rows. Raises ValueError on a missing column or a non-finite value."""
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in (*FEATURES, LABEL) if c not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"{path}: missing columns {missing}")
        for line_no, record in enumerate(reader, start=2):
            try:
                features = {name: float(record[name]) for name in FEATURES}
                label = int(float(record[LABEL].strip('"')))
            except (TypeError, ValueError) as err:
                raise ValueError(f"{path}:{line_no}: {err}") from err
            if not all(math.isfinite(v) for v in features.values()) or label not in (0, 1):
                raise ValueError(f"{path}:{line_no}: invalid values")
            yield Row(features, label)


@dataclass
class Pools:
    fraud: list[Row]
    normal: list[Row]  # the reservoir sample
    seen_normal: int  # usable normal rows in the file (for the natural fraud rate)
    skipped_zero_amount: int


def collect(path: str | Path, normal_sample: int, rng: random.Random, max_amount: float | None = None) -> Pools:
    """All fraud rows plus a uniform reservoir sample of `normal_sample` normal rows.

    Rows with Amount 0 are skipped (a transfer must be > 0), as are rows above `max_amount`.
    """
    fraud: list[Row] = []
    normal: list[Row] = []
    seen_normal = 0
    skipped = 0
    for row in read_rows(path):
        if row.amount <= 0:
            skipped += 1
            continue
        if max_amount is not None and row.amount > max_amount:
            continue
        if row.label == 1:
            fraud.append(row)
            continue
        seen_normal += 1
        if len(normal) < normal_sample:
            normal.append(row)
        else:
            j = rng.randrange(seen_normal)
            if j < normal_sample:
                normal[j] = row
    return Pools(fraud, normal, seen_normal, skipped)
