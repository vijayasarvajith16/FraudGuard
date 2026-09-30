# deep-scan-service

XGBoost fraud probability and risk tier for transactions quick-scan flagged (docs/contracts.md §5, §6.1). The RabbitMQ consumer (`transactions.flagged` → `transactions.scored`) arrives in Phase 5.

| Route | Purpose |
|---|---|
| `POST /score` | `{transactionId?, features}` → `{probability, riskTier, thresholds, modelName, modelVersion}` |
| `GET /health` | readiness, including the loaded model |
| `GET /health/live`, `GET /metrics` | liveness; Prometheus (`scan_requests_total`, `scan_latency_seconds`, `risk_tier_total`, `model_version_info`) |

Internal only: the gateway never routes here.

## Risk tiers

`LOW < TIER_MEDIUM_MIN (0.30) <= MEDIUM < TIER_HIGH_MIN (0.70) <= HIGH < TIER_CRITICAL_MIN (0.90) <= CRITICAL`, with inclusive lower bounds. The thresholds are policy and live in env vars, not in the model; startup fails unless `0 < medium < high < critical < 1`.

## Model loading

Same rules as quick-scan (pinned version download, exit on any failure). The model is XGBoost native JSON loaded as a `Booster`, and must be a `binary:logistic` model with the contract's feature order. **Scoring uses `iteration_range=(0, best_iteration + 1)`**: the saved file contains every trained tree, but early stopping selected only the first `best_iteration + 1`. Scoring with all trees would shift probabilities by up to 0.084 on the production model. `best_iteration` must be in the model metadata and match the booster's own attribute.

The image installs `xgboost-cpu` (the same 3.4.1 release as training, without the ~350 MB NVIDIA NCCL dependency), which halves the image size.

## Develop

```bash
python -m venv .venv && .venv/Scripts/activate
pip install -r requirements-dev.txt
pytest                 # trains a tiny early-stopped booster in test setup
ruff check . && ruff format --check .
python -m app          # needs MLFLOW_TRACKING_URI (see .env.example)
```
