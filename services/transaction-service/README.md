# transaction-service

Wallets and transfers, and the entry point of the fraud-scoring cascade (docs/contracts.md §2, §3).

| Route                                         | Auth                       | Purpose                                                       |
| --------------------------------------------- | -------------------------- | ------------------------------------------------------------- |
| `GET /wallet`, `POST /wallet/deposit`         | Bearer                     | balance / held / frozen; add funds                            |
| `POST /transactions`                          | Bearer + `Idempotency-Key` | create a transfer: hold → quick-scan → approve or flag        |
| `GET /transactions`, `GET /transactions/{id}` | Bearer                     | own transactions (cursor pagination); admins can read any     |
| `PATCH /internal/transactions/{id}/status`    | `X-Service-Token`          | status changes from alerting-service (state machine enforced) |
| `POST /internal/accounts/{userId}/unfreeze`   | `X-Service-Token`          | unfreeze a wallet                                             |
| `GET /health`, `/health/live`, `/metrics`     | none                       | readiness requires MongoDB; RabbitMQ is reported only         |

## How a transfer flows

1. **One MongoDB transaction:** insert the idempotency record, move `amount` from `balance` to `held` (guarded: enough funds, not frozen), and insert the `PENDING` transaction.
2. Call quick-scan with a 300 ms budget. **Any error, timeout or malformed answer counts as flagged** (fail toward review).
3. Clean → `APPROVED` / tier `LOW`, settled in one database transaction (sender `held -= amount`, recipient `balance += amount`, status change).
4. Flagged → `UNDER_REVIEW`, with the `transaction.flagged` event written to a **transactional outbox** in the same database transaction, then published with publisher confirms and `mandatory`.

## Guarantees and how they are enforced

- **Money and status never disagree.** MongoDB runs as a single-node replica set, and every money movement commits in the same multi-document transaction as the status change that causes it (`src/services/transferService.js` `applyTransition`). A failed wallet guard aborts the whole thing (tested by corrupting a hold).
- **State machine.** `src/domain/stateMachine.js` lists every allowed transition and its money effect (settle / release / freeze / unfreeze). Transitions are conditional on the current status and idempotent: repeating one is a no-op `200`.
- **Idempotency.** `Idempotency-Key` is scoped per user and kept 24 h. A replay returns the original (`200`, `Idempotent-Replayed: true`); the same key with a different body gets `409`. Concurrent duplicates create exactly one transfer (tested with 6 parallel requests).
- **No lost events.** If RabbitMQ is down, the transfer is still accepted and its event stays in the outbox. `src/queue/outboxRelay.js` republishes it every `OUTBOX_RELAY_INTERVAL_MS`. amqplib's built-in recovery reconnects and redeclares the topology.
- **No stuck transfers.** A transfer left `PENDING` by a crash is moved to `UNDER_REVIEW` and published after `PENDING_RECOVERY_SECONDS`.

## Develop

```bash
npm ci
npm test                # Jest + supertest on an in-memory MongoDB replica set, fake publisher, stubbed HTTP
npm run lint
make test-integration   # (repo root) real RabbitMQ in a throwaway vhost; needs the compose stack running
```

`src/middleware/jwtAuth.js` is a verbatim copy of auth-service's; keep them identical. `src/queue/topology.js` must match `services/deep-scan-service/app/queue/topology.py` argument for argument.
