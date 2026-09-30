# deep-scan-service

XGBoost fraud probability and risk tier for transactions quick-scan flagged (docs/contracts.md §5, §6.1). It consumes `transactions.flagged` and publishes `transactions.scored`, and also serves `POST /score` for debugging.

| Route | Purpose |
|---|---|
| `POST /score` | `{transactionId?, features}` → `{probability, riskTier, thresholds, modelName, modelVersion}` |
| `GET /health` | readiness: the model is loaded **and** the RabbitMQ consumer is connected |
| `GET /health/live`, `GET /metrics` | liveness; Prometheus (`scan_requests_total`, `scan_latency_seconds`, `risk_tier_total`, `model_version_info`, `queue_messages_consumed_total{result}`, `queue_processing_latency_seconds`) |

Internal only: the gateway never routes here.

## Queue consumer (docs/contracts.md §3.5)

`app/queue/consumer.py`, using aio-pika's robust connection, which restores the channel and consumer after a reconnect:

1. Validate the envelope (`transaction.flagged` v1, the exact 30 features). A malformed message is **rejected without requeue → `transactions.flagged.dlq`**, with no retries for poison.
2. Score and map to a tier, then publish `transaction.scored` (persistent, `mandatory`, publisher-confirmed; an unroutable message raises).
3. **Ack only after the publish is confirmed.**
4. On failure: republish to `fraudguard.retry` with `x-retry-count + 1` (redelivered after 5 s by the retry queue's TTL), then ack. After `MAX_RETRIES` (3) → dead-letter. If the retry publish itself fails → nack with requeue (the quorum queue's `x-delivery-limit` of 10 is the backstop).

The consumer is stateless and idempotent: the scored `eventId` is UUIDv5(`<transactionId>:scored`), so a redelivery produces the same event id and downstream deduplicates. The topology in `app/queue/topology.py` mirrors transaction-service's `topology.js` argument for argument (RabbitMQ rejects mismatched redeclarations).

## Risk tiers

`LOW < TIER_MEDIUM_MIN (0.30) <= MEDIUM < TIER_HIGH_MIN (0.70) <= HIGH < TIER_CRITICAL_MIN (0.90) <= CRITICAL`, with inclusive lower bounds. The thresholds are policy and live in env vars, not in the model; startup fails unless `0 < medium < high < critical < 1`.

## Model loading

Same rules as quick-scan (pinned version download, exit on any failure). The model is XGBoost native JSON loaded as a `Booster`, and must be a `binary:logistic` model with the contract's feature order. **Scoring uses `iteration_range=(0, best_iteration + 1)`**: the saved file contains every trained tree, but early stopping selected only the first `best_iteration + 1`. Scoring with all trees would shift probabilities by up to 0.084 on the production model. `best_iteration` must be in the model metadata and match the booster's own attribute.

The image installs `xgboost-cpu` (the same 3.4.1 release as training, without the ~350 MB NVIDIA NCCL dependency), which halves the image size.

## Develop

```bash
python -m venv .venv && .venv/Scripts/activate
pip install -r requirements-dev.txt
pytest                 # trains a tiny early-stopped booster in test setup; consumer rules use fake deliveries
make test-integration  # (repo root) real-broker tests in a throwaway vhost; needs the compose stack
ruff check . && ruff format --check .
python -m app          # needs MLFLOW_TRACKING_URI (see .env.example)
```
