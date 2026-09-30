"""Generate frontend/src/demo/sampleFeatures.json: real dataset rows for the transfer form's
Risk profile selector (docs/contracts.md §0.8).

    python tools/make_demo_samples.py ml/data/creditcard.csv

Offline developer tooling: it scores candidate rows by calling the scan services' /score
directly on their compose host ports. No client does this; the frontend only ever sends the
chosen features through POST /api/transactions.

Categories (scored at the row's own Amount):
    normal      label 0, quick-scan not flagged                     -> approved immediately
    suspicious  quick-scan flagged, deep-scan MEDIUM or HIGH         -> notify / OTP step-up
    fraud       label 1, quick-scan flagged, deep-scan CRITICAL      -> account frozen
"""

from __future__ import annotations

import argparse
import http.client
import json
import logging
import random
import sys
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

from creditcard import FEATURES, Row, collect

log = logging.getLogger("make_demo_samples")
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "frontend" / "src" / "demo" / "sampleFeatures.json"
CATEGORIES = ("normal", "suspicious", "fraud")


class ScanClient:
    """POST /score over one keep-alive connection per thread.

    A new TCP connection per request exhausts ephemeral ports (TIME_WAIT) when tens of
    thousands of rows are scored, notably on Windows.
    """

    def __init__(self, base_url: str, timeout: float = 5.0) -> None:
        parts = urllib.parse.urlsplit(base_url)
        if parts.scheme != "http" or not parts.hostname:
            raise ValueError(f"expected an http:// base URL, got {base_url!r}")
        self.base_url = base_url.rstrip("/")
        self.host, self.port = parts.hostname, parts.port or 80
        self.path = parts.path.rstrip("/") + "/score"
        self.timeout = timeout
        self._local = threading.local()

    def _connection(self) -> http.client.HTTPConnection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._local.conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        return conn

    def score(self, features: dict[str, float]) -> dict:
        body = json.dumps({"features": features})
        for attempt in (1, 2):  # one reconnect if the server closed an idle keep-alive connection
            conn = self._connection()
            try:
                conn.request("POST", self.path, body=body, headers={"Content-Type": "application/json"})
                res = conn.getresponse()
                payload = res.read()
            except (ConnectionError, http.client.HTTPException):
                conn.close()
                self._local.conn = None
                if attempt == 2:
                    raise
                continue
            if res.status != 200:
                raise RuntimeError(f"{self.base_url}/score -> HTTP {res.status}: {payload[:300]!r}")
            return json.loads(payload)
        raise AssertionError("unreachable")


def score_all(client: ScanClient, rows: list[Row], workers: int) -> list[dict]:
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda r: client.score(r.features), rows))


def single_version(results: list[dict], service: str) -> str:
    versions = {r["modelVersion"] for r in results}
    if len(versions) != 1:
        raise RuntimeError(f"{service} served several model versions during generation: {sorted(versions)}")
    return versions.pop()


def categorize(rows: list[Row], quick: list[dict], deep: dict[int, dict]) -> dict[str, list[Row]]:
    """Assign rows to categories; `deep` maps a row index to its deep-scan result (flagged rows only)."""
    buckets: dict[str, list[Row]] = {c: [] for c in CATEGORIES}
    for i, (row, q) in enumerate(zip(rows, quick, strict=True)):
        if not q["flagged"]:
            if row.label == 0:
                buckets["normal"].append(row)
            continue
        tier = deep[i]["riskTier"]
        if tier in ("MEDIUM", "HIGH"):
            buckets["suspicious"].append(row)
        elif tier == "CRITICAL" and row.label == 1:
            buckets["fraud"].append(row)
    return buckets


def build_document(chosen: dict[str, list[Row]], quick_version: str, deep_version: str) -> dict:
    return {
        "generatedAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "source": "creditcard.csv",
        "models": {"quickScan": quick_version, "deepScan": deep_version},
        "categories": {c: [{k: r.features[k] for k in FEATURES} for r in chosen[c]] for c in CATEGORIES},
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("csv", help="path to the Kaggle creditcard.csv")
    p.add_argument("--quick-url", default="http://127.0.0.1:8001", help="quick-scan base URL (compose host port)")
    p.add_argument("--deep-url", default="http://127.0.0.1:8002", help="deep-scan base URL (compose host port)")
    p.add_argument("--per-category", type=int, default=12, help="samples per category (default 12)")
    p.add_argument("--normal-candidates", type=int, default=3000, help="normal rows to score (default 3000)")
    p.add_argument("--max-amount", type=float, default=500.0, help="skip rows above this amount (demo wallets)")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--workers", type=int, default=8, help="parallel scoring requests")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    rng = random.Random(args.seed)

    pools = collect(args.csv, args.normal_candidates, rng, max_amount=args.max_amount)
    rows = pools.fraud + pools.normal
    log.info(
        "candidates: %d fraud + %d normal rows (skipped %d with Amount 0)",
        len(pools.fraud),
        len(pools.normal),
        pools.skipped_zero_amount,
    )

    quick_client, deep_client = ScanClient(args.quick_url), ScanClient(args.deep_url)
    quick = score_all(quick_client, rows, args.workers)
    flagged = [i for i, q in enumerate(quick) if q["flagged"]]
    deep_results = score_all(deep_client, [rows[i] for i in flagged], args.workers)
    deep = dict(zip(flagged, deep_results, strict=True))
    quick_version = single_version(quick, "quick-scan")
    deep_version = single_version(deep_results, "deep-scan") if deep_results else "unknown"
    log.info("quick-scan v%s flagged %d rows; deep-scan v%s scored them", quick_version, len(flagged), deep_version)

    buckets = categorize(rows, quick, deep)
    chosen: dict[str, list[Row]] = {}
    for category in CATEGORIES:
        available = buckets[category]
        if not available:
            log.error("no rows qualify for category %r; nothing written", category)
            return 1
        if len(available) < args.per_category:
            log.warning("category %r: only %d rows qualify", category, len(available))
        chosen[category] = rng.sample(available, min(args.per_category, len(available)))
        log.info("%-10s %3d qualifying, %2d chosen", category, len(available), len(chosen[category]))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    doc = build_document(chosen, quick_version, deep_version)
    args.out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8", newline="\n")  # LF on Windows too
    log.info("wrote %s", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
