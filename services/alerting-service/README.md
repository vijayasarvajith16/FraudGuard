# alerting-service

Turns deep-scan risk tiers into mitigations (docs/contracts.md §6.2, §7): consumes `transactions.scored`, applies the tier policy, runs OTP step-up and the manual review queue, and asks transaction-service to move the transaction through its state machine.

| Tier (default policy) | Action             | Effect                                             | Transaction becomes                       |
| --------------------- | ------------------ | -------------------------------------------------- | ----------------------------------------- |
| LOW                   | `LOG`              | audit-only alert (not shown to the user)           | `APPROVED`                                |
| MEDIUM                | `NOTIFY`           | user alert                                         | `APPROVED`                                |
| HIGH                  | `OTP_STEP_UP`      | OTP challenge (5 min, 3 attempts); funds stay held | `AWAITING_OTP` → `APPROVED` / `BLOCKED`   |
| CRITICAL              | `BLOCK_AND_FREEZE` | account frozen, manual review case                 | `ACCOUNT_FROZEN` → `APPROVED` / `BLOCKED` |

## API (via the gateway at `/api/alerts/*`)

| Route                                                                                         | Auth                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `GET /alerts`                                                                                 | Bearer: own user-visible alerts, cursor pagination |
| `POST /alerts/otp/verify` `{transactionId, code}`                                             | Bearer                                             |
| `GET /alerts/admin/reviews?status=OPEN\|RESOLVED`, `POST /alerts/admin/reviews/{id}/decision` | admin                                              |
| `POST /alerts/admin/accounts/{userId}/unfreeze`                                               | admin                                              |
| `GET /alerts/admin/config/tier-actions`, `POST /alerts/admin/config/reload`                   | admin                                              |
| `GET /health` (mongo, policy, rabbitmq), `/health/live`, `/metrics`                           | internal only                                      |

## Policy without redeploys

`src/config/tierActions.json` (`TIER_ACTIONS_PATH`) is validated strictly: each action has exactly one consistent resulting status, OTP and block actions must notify, and a review case is required for block and only allowed there. It is reloaded when its **content hash** changes (`TIER_ACTIONS_POLL_SECONDS`, 10 s in compose) or on `POST /alerts/admin/config/reload`. An invalid file is rejected and the last good policy stays active; an invalid file at startup is fatal. In docker-compose the folder is bind-mounted, so editing the file on the host changes behaviour live.

## Reliability

- **Idempotent processing.** Every side effect is create-if-absent and keyed by the transaction (one alert, OTP challenge and review case per transaction), and `processed_events` (7-day TTL) short-circuits duplicates. A redelivered or retried message therefore never duplicates anything.
- **Stable OTPs.** The code is `HMAC(OTP_SECRET, transactionId)` → 6 digits, so a retry cannot show a different code than the stored one. Only an HMAC of the code is stored, and it is compared in constant time.
- **Consumer rules** (as in deep-scan): poison → DLQ; transaction-service `409` → already final, ack; `404`/other `4xx` → DLQ; `5xx`/timeout → retry queue (5 s TTL) up to `MAX_RETRIES`, then DLQ.
- **OTP sweeper** (every `OTP_SWEEP_INTERVAL_SECONDS`): blocks transactions whose challenge expired or ran out of attempts, including ones whose block call failed while transaction-service was down.

## Develop

```bash
npm ci
npm test                 # in-memory MongoDB + fake transaction-service: 50 tests
npm run lint
make test-integration    # (repo root) real RabbitMQ in a throwaway vhost, including the retry-queue round trip
```

`src/middleware/jwtAuth.js` and `src/queue/topology.js` are verbatim copies shared with the other Node services.
