# FraudGuard demo tools

Standard library only (Python 3.11+); no install needed. Both read the Kaggle `creditcard.csv`, which is
never committed (put it at `ml/data/creditcard.csv`). Contract: docs/contracts.md §0.8 and §8.2.

## `replay.py`: stream dataset rows through the gateway

```bash
python tools/replay.py ml/data/creditcard.csv --gateway http://localhost:8080 \
    --count 100 --rate 2 --fraud-ratio 0.2
```

- Registers and funds `--users` demo users (default 6), then sends each row's feature vector as a transfer
  between two of them at `--rate` per second (max 15, under the gateway's 20 req/s limit).
- The transfer amount is the row's own `Amount`, so the models score exactly the dataset row. Rows with
  `Amount = 0` are skipped.
- `--fraud-ratio` sets the share of label-1 rows (default: the natural ~0.17%). The label stays in the tool
  and is only used to split the summary.
- Retries `429`/`5xx`/network errors with the same `Idempotency-Key`. When a sender's account is frozen
  (CRITICAL), it is retired and a fresh demo user takes over.
- Waits `--wait` seconds for flagged transfers to rest, then logs outcome counts per tier split by label
  (`--report file.json` also writes them). It prints a demo login so you can open the UI and watch the
  alerts; the admin sees the frozen accounts in the review queue.

Example (40 transfers, `--fraud-ratio 0.2`, production models v2):

```
outcome by tier      total   fraud  normal
LOW (quick-scan)        32       1      31
LOW (deep-scan)          2       1       1
MEDIUM                   0       0       0
HIGH                     0       0       0
CRITICAL                 6       6       0
fraud rows escalated to MEDIUM or above: 6 of 8
```

## `make_demo_samples.py`: regenerate the UI's risk-profile samples

```bash
docker compose up -d quick-scan-service deep-scan-service
python tools/make_demo_samples.py ml/data/creditcard.csv
```

Scores candidate rows against the scan services' host ports (`127.0.0.1:8001` and `:8002`; offline developer
tooling, never a client path) and writes `frontend/src/demo/sampleFeatures.json` with the model versions used:

| Category | Rule |
|---|---|
| `normal` | label 0, quick-scan not flagged |
| `suspicious` | quick-scan flagged, deep-scan MEDIUM or HIGH |
| `fraud` | label 1, quick-scan flagged, deep-scan CRITICAL |

With models v2 the deep-scan model is very decisive: of 1,850 normal rows flagged by quick-scan, none scored
above LOW, so only **5 rows in the whole dataset** qualify as `suspicious` (4 HIGH, 1 MEDIUM), all of them
fraud rows. Re-run the script after promoting new models.

## Tests

```bash
cd tools && python -m pytest && ruff check . && ruff format --check .
```

The tests run both tools against in-process fake gateway and scan servers (no stack needed).
