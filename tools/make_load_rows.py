"""Generate tests/load/data/rows.json: the feature vectors the k6 load test sends (docs/performance.md).

    python tools/make_load_rows.py ml/data/creditcard.csv

Only normal (label 0) rows are used, sampled uniformly. With the production models about 6% of them
are flagged by quick-scan, so deep-scan sees its natural share of traffic, and none scores above LOW
(tools/README.md): the load never freezes the test accounts. The output is derived from the dataset,
so it is gitignored like the dataset itself. Columns are listed once and rows are arrays, which keeps
the file under the 1 MiB ConfigMap limit.
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from datetime import UTC, datetime
from pathlib import Path

from creditcard import FEATURES, collect

log = logging.getLogger("make_load_rows")
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "tests" / "load" / "data" / "rows.json"
MAX_BYTES = 900_000  # headroom under Kubernetes' 1 MiB ConfigMap limit


def build_document(rows: list[dict[str, float]], source: str) -> dict:
    return {
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": source,
        "columns": list(FEATURES),
        "rows": [[r[c] for c in FEATURES] for r in rows],
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("csv", help="path to the Kaggle creditcard.csv")
    p.add_argument("--count", type=int, default=1200, help="rows to write (default 1200)")
    p.add_argument("--max-amount", type=float, default=500.0, help="skip rows above this amount")
    p.add_argument("--seed", type=int, default=13)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    pools = collect(args.csv, args.count, random.Random(args.seed), max_amount=args.max_amount)
    if len(pools.normal) < args.count:
        log.warning("only %d normal rows qualify", len(pools.normal))
    doc = build_document([r.features for r in pools.normal], Path(args.csv).name)
    text = json.dumps(doc, separators=(",", ":")) + "\n"
    if len(text.encode()) > MAX_BYTES:
        log.error("%d bytes is over the %d-byte ConfigMap budget; lower --count", len(text.encode()), MAX_BYTES)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8", newline="\n")  # LF on Windows too
    log.info("wrote %d rows (%d bytes) to %s", len(doc["rows"]), len(text.encode()), args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
