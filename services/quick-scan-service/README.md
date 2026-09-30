# quick-scan-service

Synchronous Isolation Forest scoring for **every** transaction (docs/contracts.md §4). Flags the anomalous ~6% for deep-scan.

| Route | Purpose |
|---|---|
| `POST /score` | `{transactionId?, features}` → `{score, threshold, flagged, modelName, modelVersion}` |
| `GET /health` | readiness, including the loaded model (`name`, `version`, `alias`, `source`) |
| `GET /health/live`, `GET /metrics` | liveness; Prometheus (`scan_requests_total`, `scan_latency_seconds`, `scan_flagged_total`, `model_version_info`) |

Internal only: the gateway never routes here.

## Model loading

At startup: resolve `MODEL_URI` (default `models:/fraudguard-quick-scan@production`) to a version, download that exact version, and load `model.skops` with the service's own allowlist (`sklearn.tree._tree.Tree`). The threshold comes from the model metadata (`QUICK_SCAN_THRESHOLD` overrides it). **Any failure exits the process** (code 3, `critical` log): the service never serves a default model. `ALLOW_LOCAL_MODEL_FALLBACK` + `LOCAL_MODEL_PATH` exist for tests only.

## Performance

scikit-learn's `score_samples` dispatches each tree through joblib, which dominates the cost of scoring one row. `app/scorer.py` does the same arithmetic directly (~1 ms for 100 trees). At startup it checks itself against `score_samples` on 256 probe rows and refuses to start if they differ by more than 1e-12. On the production model, the maximum difference over the 56,746-row test split is 0.0. Scoring runs inline on the event loop (no GIL contention between threads). Measured results: [docs/ml-results.md](../../docs/ml-results.md).

## Develop

```bash
python -m venv .venv && .venv/Scripts/activate      # .venv/bin/activate on Linux/macOS
pip install -r requirements-dev.txt
pytest                 # trains a tiny Isolation Forest in test setup
ruff check . && ruff format --check .
python -m app          # needs MLFLOW_TRACKING_URI (see .env.example)
```

`scikit-learn`, `skops` and `numpy` are pinned to the training versions in `ml/requirements.txt`; change them together.
