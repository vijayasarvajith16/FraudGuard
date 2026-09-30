# FraudGuard Service Contracts

**Status:** authoritative. Contract version `1.5.0`.
Change this file first, then the code. Any change that breaks a consumer bumps the major version and the message `version` field.

This document defines every HTTP API, the transaction data model, the RabbitMQ topology, the risk policy, and failure behaviour. If code and this file disagree, the code is wrong.

---

## 0. Conventions shared by every service

### 0.1 Ports and hostnames (docker-compose / Kubernetes service names)

| Service | Host name | Port | Exposed through gateway |
|---|---|---|---|
| api-gateway (Nginx) | `api-gateway` | 8080 | n/a (it *is* the edge) |
| auth-service | `auth-service` | 3001 | `/api/auth/*` |
| transaction-service | `transaction-service` | 3002 | `/api/wallet/*`, `/api/transactions/*` |
| alerting-service | `alerting-service` | 3003 | `/api/alerts/*` |
| quick-scan-service | `quick-scan-service` | 8001 | **never** |
| deep-scan-service | `deep-scan-service` | 8002 | **never** |
| frontend (Nginx serving the SPA) | `frontend` | 8081 | `/` (§8.1) |
| MongoDB | `mongodb` | 27017 | never |
| RabbitMQ | `rabbitmq` | 5672 (AMQP), 15672 (management UI) | never |

MongoDB runs as a **single-node replica set** (`rs0`) so that services can use multi-document ACID transactions; a standalone server cannot. Each service owns its own database in the shared MongoDB instance and never reads another service's database:
`fraudguard_auth` (auth), `fraudguard_transactions` (transaction), `fraudguard_alerts` (alerting). The scan services are stateless.

### 0.2 Identifiers, money and time
- All entity IDs are UUID v4 strings (stored as `_id` in MongoDB). Never expose Mongo `ObjectId`s.
- Money in the API is a JSON number in **major units** with at most 2 decimal places (`12.50`). Services store integer minor units (`amountCents`) internally and convert at the boundary. Single currency: `"USD"`.
- Limits: a single deposit or transfer is `> 0` and `<= 1,000,000.00`.
- Timestamps are ISO-8601 UTC strings with milliseconds: `2026-09-30T09:15:02.123Z`.

### 0.3 Headers
| Header | Direction | Rule |
|---|---|---|
| `Authorization: Bearer <jwt>` | client → service | Required on every non-public route. |
| `X-Request-Id` | both | Gateway generates one (UUID) if absent and forwards it. Every service logs it, echoes it on the response, and forwards it on outbound HTTP calls and as an AMQP header. |
| `Idempotency-Key` | client → transaction-service | Required on `POST /transactions` (see §2.3). |
| `X-Service-Token` | service → service | Shared secret (`INTERNAL_SERVICE_TOKEN`) for `/internal/*` routes. Compared in constant time. |

### 0.4 Authentication (JWT)
- Issued by auth-service, algorithm **HS256**, secret `JWT_SECRET` (min 32 bytes), shared with services that verify tokens.
- Claims: `sub` (userId), `email`, `role` (`user` \| `admin`), `iss` = `fraudguard-auth`, `aud` = `fraudguard`, `iat`, `exp`.
- Access-token lifetime: `JWT_EXPIRES_IN` (default `15m`). The docker-compose demo stack sets `2h` so a demo is not interrupted by re-logins.
- Verifiers must check the signature, `iss`, `aud` and `exp`, and allow at most 30 s of clock skew.
- **Deliberate scope cut: there are no refresh tokens and no logout endpoint.** Tokens are stateless and short-lived; "logout" is the client discarding its token. A production system would add rotating refresh tokens (httpOnly cookie) and a server-side revocation list. These are left out to keep the prototype focused on the fraud pipeline, not because they were overlooked.

### 0.5 Error format
Every non-2xx response from every service (Node and Python) uses this envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "amount must be greater than 0",
    "details": [{ "field": "amount", "issue": "must be > 0" }],
    "requestId": "7f0c2a5e-4a3b-4a53-9a9e-2f1b8f0a0c11"
  }
}
```

`details` is optional. Common codes:

| HTTP | code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body, query or path failed validation (the Python services also use 400, overriding FastAPI's 422). |
| 401 | `UNAUTHORIZED` | Missing, invalid or expired token or service token. |
| 403 | `FORBIDDEN` | Authenticated but lacks the role. |
| 404 | `NOT_FOUND` | Resource missing, **or it belongs to another user** (no 403, to avoid leaking IDs). |
| 409 | `CONFLICT` / specific code | State conflict (see each route). |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 100 kB. |
| 429 | `RATE_LIMITED` | Includes a `Retry-After` header. |
| 500 | `INTERNAL_ERROR` | Unhandled error; message is generic, details only in logs. |
| 503 | `SERVICE_UNAVAILABLE` / `MODEL_NOT_LOADED` | Dependency down. |

### 0.6 Health and metrics (every service)
- `GET /health/live`: process is up. Always `200 {"status":"ok"}` while the event loop responds. Used for the liveness probe.
- `GET /health`: readiness. Checks the service's dependencies.
  - `200` `{"status":"ok","service":"auth-service","version":"1.0.0","uptimeSeconds":123,"checks":{"mongo":"ok"}}`
  - `503` with `"status":"degraded"` and the failing check set to `"fail"`.
  - Scan services add `"model":{"name":"fraudguard-quick-scan","version":"3","alias":"production","source":"registry"}`.
- `GET /metrics`: Prometheus text format. Not routed through the gateway; scraped in-cluster only.
  - Every HTTP service: `http_requests_total{method,route,status}`, `http_request_duration_seconds{method,route}` (histogram), plus default process metrics.
  - Service-specific metrics are listed with each service below.
  - The gateway (Nginx) exposes `stub_status` on an internal port; Prometheus reads it through `nginx-prometheus-exporter` (Phase 13).

### 0.7 Pagination
List endpoints take `?limit=` (1–100, default 20) and `?cursor=` (an opaque string from the previous response), and return `{ "items": [...], "nextCursor": "..." | null }`. Order is newest first.

### 0.8 The feature vector
The anonymized Kaggle Credit Card Fraud features. The same object is used by the scan services, the transaction model and queue messages:

```json
{ "Time": 406.0, "V1": -2.31, "V2": 1.95, "...": "...", "V28": -0.14, "Amount": 239.93 }
```

- Keys: exactly `Time`, `V1`…`V28`, `Amount` (30 keys). Unknown keys are rejected with `400`.
- All values are finite numbers. `Time >= 0`, `Amount >= 0`.
- On a transfer, transaction-service **always overwrites `Amount`** with the transaction amount.
- If a client omits `features` entirely, transaction-service builds a neutral vector: `V1..V28 = 0` (the PCA mean), `Time` = seconds since UTC midnight, `Amount` = amount. This is a demo simplification because the real features are anonymized.
- **Consequence:** a transfer without features is almost always scored normal and approved immediately. Flagged flows are demonstrated with real feature rows, supplied either by:
  1. the frontend transfer form's **Risk profile** selector (`Default`, `Normal sample`, `Suspicious sample`, `Known fraud sample`). The samples are real rows from the dataset, bundled in `frontend/src/demo/sampleFeatures.json`, which `tools/make_demo_samples.py` generates (a few dozen rows, no labels beyond the category). The form tells the user that `Default` will normally be approved; or
  2. `tools/replay.py`, which streams dataset rows through the gateway (§8.2).

  Sample categories are assigned by scoring candidate rows, at their original `Amount`, with the production models at generation time (the file records both model versions):

  | Category | Rule | Expected outcome |
  |---|---|---|
  | `normal` | label 0, quick-scan not flagged | `APPROVED` / `LOW` immediately |
  | `suspicious` | quick-scan flagged, deep-scan tier `MEDIUM` or `HIGH` (either label) | notification or OTP step-up |
  | `fraud` | label 1, quick-scan flagged, deep-scan tier `CRITICAL` | account frozen, manual review |

  Rows with `Amount = 0` are skipped (a transfer must be `> 0`). Because `Amount` is part of the vector and the server overwrites it with the transfer amount, choosing a sample pre-fills the transfer amount with the sample's `Amount`; the form warns that changing it can change the outcome. The expected outcome holds only for the recorded model versions.

  File shape: `{ "generatedAt", "source": "creditcard.csv", "models": { "quickScan": "2", "deepScan": "2" }, "categories": { "normal": [features...], "suspicious": [...], "fraud": [...] } }`.

  Either way, features always reach the server through `POST /api/transactions`. No client talks to a scan service directly.

---

## 1. auth-service

Database `fraudguard_auth`, collection `users`, with a unique index on `email`.

User document (never returned with `passwordHash`):
```json
{ "_id": "uuid", "email": "ana@example.com", "name": "Ana", "role": "user", "passwordHash": "bcrypt", "createdAt": "...", "updatedAt": "..." }
```

Admin bootstrap: on startup, if `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set and no user with that email exists, the service creates it with `role: admin`. This is the only way to create an admin.

### 1.1 Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | public | Create a `user`-role account. |
| POST | `/auth/login` | public, rate-limited | Returns an access token. |
| GET | `/auth/me` | Bearer | Current user. |
| GET | `/internal/users/lookup?email=` | `X-Service-Token` | Resolve an email to a user (used by transaction-service). |
| GET | `/health`, `/health/live`, `/metrics` | public (not routed by the gateway) | §0.6 |

**POST /auth/register**
- Body: `{ "email": string (valid, ≤254, lowercased and trimmed), "password": string (8–128 chars, at least one letter and one digit), "name": string (1–80, trimmed) }`
- `201` → `{ "user": { "id", "email", "name", "role", "createdAt" } }`
- `400 VALIDATION_ERROR`; `409 EMAIL_TAKEN`.

**POST /auth/login**
- Body: `{ "email", "password" }`
- `200` → `{ "accessToken": "jwt", "tokenType": "Bearer", "expiresIn": 900, "user": { ... } }`
- `401 INVALID_CREDENTIALS` (identical for an unknown email and a wrong password; the password check takes the same time either way); `429 RATE_LIMITED` after `LOGIN_RATE_LIMIT_MAX` (default 5) attempts per IP+email per 15 min.

**GET /auth/me** → `200 { "user": { ... } }`; `401`.

**GET /internal/users/lookup?email=x** → `200 { "user": { "id", "email", "name", "role" } }`; `404`; `401`.

Metrics: `auth_registrations_total`, `auth_logins_total{result="success|failure"}`.

---

## 2. transaction-service

Database `fraudguard_transactions`, collections `wallets`, `transactions`, `idempotency_keys` (TTL 24 h).

### 2.1 Wallet model
```json
{ "_id": "userId", "balanceCents": 10000, "heldCents": 2500, "currency": "USD", "frozen": false, "frozenReason": null, "updatedAt": "..." }
```
- A wallet is created lazily (balance 0) on first access.
- `balance` is available funds; `held` is money reserved by transfers still under review.
- Every money movement runs in **one MongoDB multi-document transaction** together with the transaction-status change that causes it, so money and status can never disagree:
  - *create*: insert the idempotency record + move `amount` from `balance` to `held` (guard `balanceCents >= amount`, wallet not frozen) + insert the `PENDING` transaction.
  - *settle* (→ `APPROVED`): sender `held -= amount` (guard `heldCents >= amount`) + recipient `balance += amount` + status change.
  - *release* (→ `BLOCKED`): sender `held -= amount`, `balance += amount` + status change.
  - *freeze* (→ `ACCOUNT_FROZEN`): sender wallet `frozen = true` + status change.
- Status changes are conditional on the expected current status (optimistic concurrency), so a transition applies at most once even under concurrent or duplicate requests.

API representation: `{ "userId", "balance": 100.00, "held": 25.00, "currency": "USD", "frozen": false, "updatedAt" }`.

### 2.2 Transaction schema (JSON Schema 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://fraudguard.local/schemas/transaction.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "userId", "recipientId", "amount", "currency", "features", "status", "riskScore", "riskTier", "quickScan", "deepScan", "action", "statusHistory", "createdAt", "updatedAt", "finalizedAt"],
  "properties": {
    "id":          { "type": "string", "format": "uuid" },
    "userId":      { "type": "string", "format": "uuid", "description": "Sender" },
    "recipientId": { "type": "string", "format": "uuid" },
    "amount":      { "type": "number", "exclusiveMinimum": 0, "maximum": 1000000, "multipleOf": 0.01 },
    "currency":    { "const": "USD" },
    "description": { "type": ["string", "null"], "maxLength": 140 },
    "features":    { "$ref": "#/$defs/features" },
    "status": {
      "enum": ["PENDING", "APPROVED", "UNDER_REVIEW", "BLOCKED", "ACCOUNT_FROZEN", "AWAITING_OTP"]
    },
    "riskScore": {
      "type": ["number", "null"], "minimum": 0, "maximum": 1,
      "description": "Deep-scan fraud probability. null if the transaction never reached deep-scan."
    },
    "riskTier": {
      "enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL", null],
      "description": "LOW when quick-scan approves. null while PENDING or UNDER_REVIEW awaiting deep-scan."
    },
    "quickScan": {
      "type": ["object", "null"],
      "properties": {
        "score":        { "type": ["number", "null"] },
        "threshold":    { "type": ["number", "null"] },
        "flagged":      { "type": "boolean" },
        "reason":       { "enum": ["NORMAL", "ANOMALY", "QUICK_SCAN_UNAVAILABLE"] },
        "modelVersion": { "type": ["string", "null"] },
        "scoredAt":     { "type": "string", "format": "date-time" }
      }
    },
    "deepScan": {
      "type": ["object", "null"],
      "properties": {
        "probability":  { "type": "number" },
        "riskTier":     { "enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
        "modelVersion": { "type": "string" },
        "scoredAt":     { "type": "string", "format": "date-time" }
      }
    },
    "action": {
      "enum": ["NONE", "LOG", "NOTIFY", "OTP_STEP_UP", "BLOCK_AND_FREEZE", null],
      "description": "Mitigation applied by alerting-service. NONE for quick-scan approvals."
    },
    "statusHistory": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["status", "at", "source"],
        "properties": {
          "status": { "type": "string" },
          "at":     { "type": "string", "format": "date-time" },
          "source": { "enum": ["transaction-service", "alerting-service", "admin", "otp"] },
          "reason": { "type": ["string", "null"] }
        }
      }
    },
    "createdAt":   { "type": "string", "format": "date-time" },
    "updatedAt":   { "type": "string", "format": "date-time" },
    "finalizedAt": { "type": ["string", "null"], "format": "date-time" }
  },
  "$defs": {
    "features": {
      "type": "object", "additionalProperties": false,
      "required": ["Time", "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11", "V12", "V13", "V14", "V15", "V16", "V17", "V18", "V19", "V20", "V21", "V22", "V23", "V24", "V25", "V26", "V27", "V28", "Amount"],
      "patternProperties": { "^(Time|Amount|V([1-9]|1[0-9]|2[0-8]))$": { "type": "number" } }
    }
  }
}
```

The `idempotencyKey` is stored on the document but not returned by the API.

### 2.3 Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/wallet` | Bearer | Own wallet. |
| POST | `/wallet/deposit` | Bearer | Add funds (demo; deposits are not fraud-scanned). |
| POST | `/transactions` | Bearer + `Idempotency-Key` | Create a transfer and run the scan cascade. |
| GET | `/transactions` | Bearer | List own transactions (`?status=` filter, pagination §0.7). |
| GET | `/transactions/{id}` | Bearer | Own transaction; admins can read any. |
| PATCH | `/internal/transactions/{id}/status` | `X-Service-Token` | Finalize or advance status (alerting-service only). |
| POST | `/internal/accounts/{userId}/unfreeze` | `X-Service-Token` | Unfreeze a wallet (admin flow via alerting-service). |
| GET | `/health`, `/health/live`, `/metrics` | public (not routed by the gateway) | §0.6; readiness requires `mongo`. `rabbitmq` is reported but does not fail readiness: the outbox absorbs broker outages (§9), so the service keeps accepting transfers. |

**POST /wallet/deposit**: body `{ "amount": number }` → `200 { "wallet": {...} }`; `400`; `423 ACCOUNT_FROZEN`.

**POST /transactions**
- Header `Idempotency-Key`: 8–128 chars `[A-Za-z0-9_-]`, scoped per user, remembered for 24 h.
- Body:
  ```json
  { "recipientEmail": "bob@example.com", "amount": 42.50, "currency": "USD", "description": "rent", "features": { "...": "optional, §0.8" } }
  ```
  `recipientEmail` is resolved through auth-service `/internal/users/lookup`.
- Responses:
  - `201 { "transaction": {...} }` with `status` `APPROVED` (tier `LOW`) or `UNDER_REVIEW`.
  - Replay with the same key and identical body: `200` with the original transaction (header `Idempotent-Replayed: true`).
  - `409 IDEMPOTENCY_KEY_REUSED`: same key, different body.
  - `400 VALIDATION_ERROR` (also for a missing `Idempotency-Key` or a transfer to yourself).
  - `404 RECIPIENT_NOT_FOUND`.
  - `422 INSUFFICIENT_FUNDS`.
  - `423 ACCOUNT_FROZEN`: the sender's wallet is frozen.
- Processing, in order:
  1. Validate; resolve the recipient; insert the transaction as `PENDING` and **move `amount` from `balance` to `held`** in the same guarded update (the transaction is not inserted if funds are insufficient).
  2. Call quick-scan `POST /score` with timeout `QUICK_SCAN_TIMEOUT_MS` (default 300 ms). No retry on the hot path.
  3. Not flagged → settle (debit held, credit recipient), then `APPROVED`, `riskTier: LOW`, `action: NONE`, `finalizedAt` set.
  4. Flagged, **or quick-scan error/timeout/non-200** → `UNDER_REVIEW`, write an outbox record, then publish `transaction.flagged` (§3). Funds stay held.
  5. **Interrupted requests:** if the process dies between steps 1 and 3/4, the transaction is left `PENDING` with funds held. The outbox relay moves any transaction `PENDING` for longer than `PENDING_RECOVERY_SECONDS` (default 30) to `UNDER_REVIEW` (`quickScan.reason = QUICK_SCAN_UNAVAILABLE`, history reason `recovered after interruption`) and publishes it, so it is reviewed instead of stuck (toward review, never approval).

**PATCH /internal/transactions/{id}/status**
- Body:
  ```json
  { "status": "AWAITING_OTP", "riskScore": 0.81, "riskTier": "HIGH", "deepScan": { "...": "..." }, "action": "OTP_STEP_UP", "source": "alerting-service", "reason": "tier HIGH" }
  ```
- Allowed transitions (anything else → `409 INVALID_TRANSITION`). Setting the current status again is a no-op `200` (idempotent).

  | From | To | Money effect |
  |---|---|---|
  | `PENDING` | `APPROVED` | settle (internal only, quick-scan path) |
  | `PENDING` | `UNDER_REVIEW` | none (stays held) |
  | `UNDER_REVIEW` | `APPROVED` | settle |
  | `UNDER_REVIEW` | `AWAITING_OTP` | none (stays held) |
  | `UNDER_REVIEW` | `ACCOUNT_FROZEN` | none (stays held); **sender wallet frozen** |
  | `UNDER_REVIEW` | `BLOCKED` | release hold back to the sender |
  | `AWAITING_OTP` | `APPROVED` | settle |
  | `AWAITING_OTP` | `BLOCKED` | release hold |
  | `ACCOUNT_FROZEN` | `APPROVED` | settle; wallet unfrozen |
  | `ACCOUNT_FROZEN` | `BLOCKED` | release hold; wallet **stays** frozen |

  `APPROVED` and `BLOCKED` are terminal and set `finalizedAt`.
- `200 { "transaction": {...} }`; `404`; `409 INVALID_TRANSITION`; `401`.

**POST /internal/accounts/{userId}/unfreeze** → `200 { "wallet": {...} }`; `404`.

Metrics: `transactions_created_total{status}`, `quick_scan_calls_total{result="ok|flagged|timeout|error"}`, `quick_scan_call_duration_seconds` (histogram), `queue_publish_total{result="ok|failed"}`, `outbox_pending` (gauge), `transactions_under_review` (gauge).

---

## 3. RabbitMQ topology

Services declare the topology idempotently at startup, using exactly the arguments below (a mismatch fails the declaration, so these arguments are part of the contract). Every service declares the full topology of each event it touches: its exchanges **and** its main, retry and dead-letter queues, whether the service publishes or consumes it. A publisher therefore never loses messages to "no queue bound yet" while its consumer is down or not yet deployed. Publishes also set `mandatory: true`, and a returned (unroutable) message counts as a failed publish.

### 3.1 Exchanges
| Name | Type | Durable | Purpose |
|---|---|---|---|
| `fraudguard.events` | topic | yes | All domain events. |
| `fraudguard.retry` | topic | yes | Delayed retries. |
| `fraudguard.dlx` | topic | yes | Dead letters. |

### 3.2 Queues
| Queue | Bound to (routing key) | Arguments | Consumer |
|---|---|---|---|
| `transactions.flagged` | `fraudguard.events` (`transaction.flagged`) | `x-dead-letter-exchange=fraudguard.dlx`, `x-dead-letter-routing-key=transaction.flagged`, `x-queue-type=quorum`, `x-delivery-limit=10` | deep-scan-service |
| `transactions.flagged.retry` | `fraudguard.retry` (`transaction.flagged`) | `x-message-ttl=5000`, `x-dead-letter-exchange=fraudguard.events`, `x-dead-letter-routing-key=transaction.flagged` | (none; TTL expiry sends it back) |
| `transactions.flagged.dlq` | `fraudguard.dlx` (`transaction.flagged`) | `x-queue-type=quorum` | ops / manual replay |
| `transactions.scored` | `fraudguard.events` (`transaction.scored`) | `x-dead-letter-exchange=fraudguard.dlx`, `x-dead-letter-routing-key=transaction.scored`, `x-queue-type=quorum`, `x-delivery-limit=10` | alerting-service |
| `transactions.scored.retry` | `fraudguard.retry` (`transaction.scored`) | `x-message-ttl=5000`, `x-dead-letter-exchange=fraudguard.events`, `x-dead-letter-routing-key=transaction.scored` | (none) |
| `transactions.scored.dlq` | `fraudguard.dlx` (`transaction.scored`) | `x-queue-type=quorum` | ops / manual replay |

All queues are durable. Consumers use `prefetch = 10` and manual acknowledgements.

### 3.3 Publishing rules
- Publisher confirms are on. A publish only counts as successful after the broker confirms it.
- Messages are persistent (`deliveryMode: 2`), with `contentType: application/json`, `messageId = eventId`, `correlationId = transactionId`, and headers `x-request-id` and `x-retry-count` (starting at 0).
- transaction-service uses a **transactional outbox**: the flagged event is written to the transaction document (`outbox: { eventId, publishedAt: null, attempts }`) before publishing. A relay loop re-publishes unpublished events every `OUTBOX_RELAY_INTERVAL_MS` (default 5000). This covers a broker outage between the database write and the publish.

### 3.4 Message envelope (all events)
```json
{
  "eventId": "uuid",
  "eventType": "transaction.flagged",
  "version": 1,
  "idempotencyKey": "3f1c...:flagged",
  "occurredAt": "2026-09-30T09:15:02.123Z",
  "producer": "transaction-service",
  "payload": { }
}
```

**`transaction.flagged` payload**
```json
{
  "transactionId": "uuid", "userId": "uuid", "recipientId": "uuid",
  "amount": 42.50, "currency": "USD",
  "features": { "Time": 0, "V1": 0, "...": "...", "Amount": 42.50 },
  "quickScan": { "score": 0.61, "threshold": 0.55, "flagged": true, "reason": "ANOMALY", "modelVersion": "3" },
  "createdAt": "..."
}
```
`idempotencyKey = "<transactionId>:flagged"`.

**`transaction.scored` payload**
```json
{
  "transactionId": "uuid", "userId": "uuid", "recipientId": "uuid",
  "amount": 42.50, "currency": "USD",
  "probability": 0.93, "riskTier": "CRITICAL",
  "thresholds": { "medium": 0.30, "high": 0.70, "critical": 0.90 },
  "modelVersion": "5",
  "quickScan": { "...": "passed through unchanged" },
  "scoredAt": "..."
}
```
`idempotencyKey = "<transactionId>:scored"`. The `eventId` of a scored event is **deterministic**: UUIDv5(namespace `6ba7b811-9dad-11d1-80b4-00c04fd430c8`, idempotencyKey). A redelivered flagged message therefore produces a scored event with the same `eventId`, `idempotencyKey` and score (only timestamps differ), and downstream dedup works without deep-scan keeping any state.

### 3.5 Consumer rules, retry and idempotency
1. Parse and validate the envelope and payload. On a **malformed or schema-invalid** message (a poison message): `nack(requeue=false)` goes straight to the DLQ, with no retries.
2. On a processing error (dependency down, timeout): if `x-retry-count < MAX_RETRIES` (default 3), publish a copy to `fraudguard.retry` with `x-retry-count + 1` and **ack the original only after the retry publish is confirmed**. Otherwise `nack(requeue=false)` sends it to the DLQ. Each retry waits 5 s (the queue TTL).
3. On success: **ack only after** every side effect is done (for deep-scan, after the `transaction.scored` publish is confirmed).
4. Idempotency:
   - deep-scan: stateless and deterministic (same input and model give the same output and the same `eventId`).
   - alerting: records `idempotencyKey` in `processed_events` (unique index, TTL 7 days). A duplicate is acked without running any action again.
   - transaction-service status updates are idempotent (§2.3).
5. `x-delivery-limit=10` on the quorum queues is a backstop against crash loops (a message redelivered 10 times is dead-lettered).

---

## 4. quick-scan-service (Isolation Forest)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/score` | none (internal network only) | Score one transaction. |
| GET | `/health`, `/health/live`, `/metrics` | none | §0.6; readiness requires a loaded model. |

**POST /score**
- Body: `{ "transactionId": "uuid" (optional), "features": { ...§0.8 } }`
- `200`:
  ```json
  { "transactionId": "uuid|null", "score": 0.612, "threshold": 0.550, "flagged": true, "modelName": "fraudguard-quick-scan", "modelVersion": "3" }
  ```
  `score` is the anomaly score, `-score_samples(x)` of the Isolation Forest (higher means more anomalous). `flagged = score >= threshold`.
- `threshold` comes from the registered model's `threshold` tag (chosen in training for recall at an acceptable flag rate). The env var `QUICK_SCAN_THRESHOLD` overrides it.
- `400 VALIDATION_ERROR`; `503 MODEL_NOT_LOADED`.
- Latency target: p95 < 20 ms in-process.

### 4.1 Model loading (both scan services)
- At startup the service resolves `MODEL_URI` (for example `models:/fraudguard-quick-scan@production`) to a concrete registry version, then downloads **that version** (never the alias again), so resolution and download cannot race with a promotion.
- MLflow is used only to download artifacts. The native file is loaded directly: `model.skops` with the service's own skops allowlist (`sklearn.tree._tree.Tree`), ignoring the allowlist declared in the model; or `model.json` as an XGBoost `Booster`.
- Required model metadata (in `MLmodel`): quick-scan `threshold`; deep-scan `best_iteration`. Deep-scan scores with `iteration_range=(0, best_iteration + 1)`; scoring with all trees would silently ignore early stopping.
- The model's feature names must equal §0.8's order exactly, or startup fails.
- **Failure is loud:** if the model cannot be loaded (registry unreachable, alias missing, metadata missing, features mismatched), the process logs at `fatal` and exits non-zero. The orchestrator restarts it with backoff, and it never serves with a default or partial model.
- `ALLOW_LOCAL_MODEL_FALLBACK=true` plus `LOCAL_MODEL_PATH` (an MLflow model directory) is used only in tests and offline development. `/health` then reports `"source": "local"`.

Metrics: `scan_requests_total{result="flagged|clean|error"}`, `scan_latency_seconds` (histogram), `scan_flagged_total`, `model_version_info{name,version}` (gauge = 1).

## 5. deep-scan-service (XGBoost)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/score` | none (internal network only) | Score one transaction (sync; for debugging and tests). |
| GET | `/health`, `/health/live`, `/metrics` | none | Readiness requires the model and a RabbitMQ connection. |
| (AMQP) | consumes `transactions.flagged`, publishes `transaction.scored` | | §3 |

**POST /score**
- Body: same as quick-scan.
- `200`:
  ```json
  { "transactionId": "uuid|null", "probability": 0.934, "riskTier": "CRITICAL", "thresholds": { "medium": 0.30, "high": 0.70, "critical": 0.90 }, "modelName": "fraudguard-deep-scan", "modelVersion": "5" }
  ```
- `400`; `503 MODEL_NOT_LOADED`.

Metrics: the §4 metrics, plus `queue_messages_consumed_total{result="ok|retry|dead_lettered"}`, `queue_processing_latency_seconds` (histogram, from `occurredAt` to ack), `risk_tier_total{tier}`.

---

## 6. Risk policy

### 6.1 Tier thresholds (deep-scan probability `p`)
| Tier | Rule | Env var (deep-scan) | Default |
|---|---|---|---|
| LOW | `p < medium` | n/a | n/a |
| MEDIUM | `medium <= p < high` | `TIER_MEDIUM_MIN` | `0.30` |
| HIGH | `high <= p < critical` | `TIER_HIGH_MIN` | `0.70` |
| CRITICAL | `p >= critical` | `TIER_CRITICAL_MIN` | `0.90` |

At startup the service checks `0 < medium < high < critical < 1` and refuses to start otherwise. Transactions approved by quick-scan never reach deep-scan and are `LOW` by definition.

### 6.2 Tier → action mapping (`services/alerting-service/src/config/tierActions.json`)

| Tier | Action | Side effects | Resulting status |
|---|---|---|---|
| LOW | `LOG` | Alert record at `info` level. | `APPROVED` |
| MEDIUM | `NOTIFY` | Simulated notification to the user (stored and logged). | `APPROVED` |
| HIGH | `OTP_STEP_UP` | Hold funds; create a 6-digit OTP (hashed, 5 min expiry, 3 attempts); simulated notification carrying the code. | `AWAITING_OTP` |
| CRITICAL | `BLOCK_AND_FREEZE` | Freeze the sender's account; create a manual-review case; notify the user. | `ACCOUNT_FROZEN` |

- The mapping is loaded from `TIER_ACTIONS_PATH` (default `./src/config/tierActions.json`). It is reloaded in exactly two ways:
  1. **Polling:** every `TIER_ACTIONS_POLL_SECONDS` (default `30`; `0` disables it), the service hashes the file and reloads it if the content changed. Polling is used instead of `fs.watch` because Kubernetes ConfigMap volumes update through a symlink swap, which file watchers miss.
  2. **Manual:** `POST /alerts/admin/config/reload` reloads immediately and returns the active mapping.

  An invalid file is rejected and the last good mapping stays active (logged at `error`, `tier_actions_config_reloads_total{result="invalid"}`). Changing policy never requires redeploying a model or restarting a service.
- File format: `{ "version": 1, "tiers": { "<TIER>": { "action", "resultingStatus", "notifyUser", "openReviewCase"? } } }` with all four tiers present. Each action has exactly one valid resulting status (`LOG`/`NOTIFY` → `APPROVED`, `OTP_STEP_UP` → `AWAITING_OTP`, `BLOCK_AND_FREEZE` → `ACCOUNT_FROZEN`). `OTP_STEP_UP` and `BLOCK_AND_FREEZE` require `notifyUser: true`, and `openReviewCase: true` is required for, and only allowed on, `BLOCK_AND_FREEZE`. A file breaking any of these rules is invalid. The mapping can be changed (for example MEDIUM → `OTP_STEP_UP`), but it cannot describe an action whose effects contradict its status.
- The OTP outcome resolves `AWAITING_OTP`: a correct code → `APPROVED`; too many attempts or expiry → `BLOCKED`. A sweeper runs every `OTP_SWEEP_INTERVAL_SECONDS` (60) and blocks transactions whose challenge expired or ran out of attempts, including any whose blocking call to transaction-service failed earlier.
- OTP codes are 6 digits derived from `HMAC-SHA256(OTP_SECRET, "otp-code:" + transactionId)`: unpredictable without the secret, and stable across message redeliveries, so a retried message can never show the user a different code than the one stored. Only `HMAC-SHA256(OTP_SECRET, transactionId:code)` is stored, and verification compares in constant time.
- A manual review resolves `ACCOUNT_FROZEN`: admin `APPROVE` → `APPROVED` and the account is unfrozen; `REJECT` → `BLOCKED` and the account stays frozen until an admin unfreezes it.

---

## 7. alerting-service

Database `fraudguard_alerts`, collections `alerts`, `otp_challenges`, `review_cases`, `processed_events`.

Alert object:
```json
{ "id": "uuid", "userId": "uuid", "transactionId": "uuid", "riskTier": "HIGH", "action": "OTP_STEP_UP", "channel": "SIMULATED", "message": "Confirm your $42.50 transfer with the code sent to you.", "simulatedOtp": "123456", "read": false, "createdAt": "..." }
```
`simulatedOtp` appears only when `EXPOSE_SIMULATED_OTP=true` (the demo default in docker-compose; `false` in any shared environment).
Tier `LOG` alerts are stored for audit but are not user-visible: `GET /alerts` returns only alerts from notifying actions (`notifyUser: true`). All side effects are keyed by `transactionId` (one alert, one OTP challenge, one review case per transaction), so reprocessing a message creates nothing new.

**Consumer (transactions.scored)**, following the rules of §3.5:
1. Malformed or schema-invalid → dead-letter.
2. `processed_events` already holds the `idempotencyKey` → ack (duplicate).
3. Apply the tier's action: create the alert, OTP challenge or review case (idempotently).
4. `PATCH` transaction-service: `status` = the action's resulting status, `riskScore` = probability, `riskTier`, `deepScan`, `action`, `source: alerting-service`.
   - `200` → record the `idempotencyKey` in `processed_events`, then ack.
   - `409 INVALID_TRANSITION` → the transaction was already moved on (e.g. finalized by an admin); record and ack.
   - `404` → dead-letter (a data problem, not a transient one).
   - `5xx`, timeout or network error → retry via `fraudguard.retry`, or dead-letter after `MAX_RETRIES`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/alerts` | Bearer | Own alerts (pagination §0.7). |
| POST | `/alerts/otp/verify` | Bearer | Verify a step-up OTP. |
| GET | `/alerts/admin/reviews?status=OPEN\|RESOLVED` | Bearer, `admin` | Manual review queue. |
| POST | `/alerts/admin/reviews/{id}/decision` | Bearer, `admin` | Approve or reject. |
| POST | `/alerts/admin/accounts/{userId}/unfreeze` | Bearer, `admin` | Unfreeze an account (proxies to transaction-service internal). |
| GET | `/alerts/admin/config/tier-actions` | Bearer, `admin` | Active mapping. |
| POST | `/alerts/admin/config/reload` | Bearer, `admin` | Reload the mapping from disk. |
| GET | `/health`, `/health/live`, `/metrics` | public (not routed by the gateway) | Readiness checks `mongo` and `rabbitmq`. |

**POST /alerts/otp/verify**
- Body: `{ "transactionId": "uuid", "code": "6 digits" }`
- `200 { "transactionId", "status": "APPROVED" }`
- `400 INVALID_OTP` with `details: [{ "attemptsRemaining": 2 }]`; on the last failed attempt, `400 INVALID_OTP` and the transaction is `BLOCKED`.
- `404` (no challenge for this user); `409 OTP_ALREADY_RESOLVED`; `410 OTP_EXPIRED` (the transaction is `BLOCKED`).

**POST /alerts/admin/reviews/{id}/decision**
- Body: `{ "decision": "APPROVE" | "REJECT", "note": "string ≤ 500" }`
- `200 { "review": {...}, "transaction": {...} }`; `404`; `409 REVIEW_ALREADY_RESOLVED`.

Review case: `{ "id", "transactionId", "userId", "riskScore", "status": "OPEN|RESOLVED", "decision": null|"APPROVE"|"REJECT", "decidedBy", "note", "createdAt", "resolvedAt" }`.

Metrics: `alerts_created_total{tier,action}`, `otp_verifications_total{result="success|invalid|expired"}`, `review_cases_open` (gauge), `queue_messages_consumed_total{result}`, `tier_actions_config_reloads_total{result}`.

---

## 8. api-gateway (Nginx)

| Gateway path | Upstream | Notes |
|---|---|---|
| `GET /health` | answered by Nginx | `200 {"status":"ok","service":"api-gateway"}` |
| `/api/auth/*` | `auth-service:3001/auth/*` | `POST /api/auth/login`: 10 req/min per IP (burst 5) |
| `/api/wallet/*` | `transaction-service:3002/wallet/*` | |
| `/api/transactions*` | `transaction-service:3002/transactions*` | |
| `/api/alerts/*` | `alerting-service:3003/alerts/*` | |
| `/` | `frontend:8081` | SPA; compose only (Kubernetes routes the frontend at the ingress) |
| anything matching `/internal`, `/metrics`, `/health/live` under `/api/*`, or not listed | `404` | Explicit deny. Scan services are unreachable. |

- General rate limit: 20 req/s per IP, burst 40 → `429` with the §0.5 envelope.
- The frontend talks **only** to `/api/*` on the gateway. It tracks the outcome of a flagged transfer by polling `GET /api/transactions/{id}` (every 2 s, backing off to 10 s, stopping at a **resting** status: `APPROVED` or `BLOCKED` (terminal), or `AWAITING_OTP` / `ACCOUNT_FROZEN`, which wait on the user or an admin rather than the pipeline). It never calls a scan service, RabbitMQ or an `/internal` route, and the gateway has no route to them.
- On `/`, the gateway hides the frontend's own `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy` so each header is sent exactly once; the frontend's `Content-Security-Policy` passes through.
- CORS: allow the origins in `CORS_ALLOWED_ORIGINS`; methods `GET, POST, PATCH, OPTIONS`; headers `Authorization, Content-Type, Idempotency-Key, X-Request-Id`; expose `X-Request-Id, Idempotent-Replayed`.
- `X-Request-Id`: `$http_x_request_id` if present, otherwise `$request_id`; forwarded upstream and returned to the client.
- Upstream timeouts: connect 2 s, read 10 s. Max body 100 kB.
- JSON access log including the request ID, upstream time and status.
- Errors produced by the gateway itself (`404` unknown route, `413`, `429`, `502`/`503`/`504` upstream failures) use the §0.5 envelope, with `requestId`.
- Runs as a non-root user on port **8080**. `stub_status` is served only on the internal port **8090** (`/nginx_status`) for the Prometheus exporter; it is not published.
- Security headers on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. `server_tokens off`.

### 8.1 Frontend (SPA)

React single-page app, built by Vite and served by a non-root Nginx on port **8081** (`frontend:8081`). In compose it is reached only through the gateway's `/`; in Kubernetes the ingress routes `/` to it and `/api` to the gateway.

| Route | Access | Content |
|---|---|---|
| `/login`, `/register` | public | Registration signs the user straight in. |
| `/` | user | Wallet (available, held, frozen banner), deposit, transfer form with the Risk profile selector (§0.8), live tracker of the last transfer, recent activity. |
| `/transactions` | user | History with status and tier badges, status filter, cursor pagination, per-transaction details (quick-scan, deep-scan, status history). |
| `/alerts` | user | Alerts; OTP entry for `OTP_STEP_UP` alerts whose transaction is still `AWAITING_OTP` (shows `simulatedOtp` when the server exposes it). |
| `/admin` | `admin` role | Manual review queue (`OPEN`/`RESOLVED`) with approve/reject and a note, account unfreeze for rejected cases, the active tier policy and a reload button. |

- **API base:** `VITE_API_BASE_URL` (build time, default `/api`, same origin through the gateway). The Vite dev server proxies `/api` to the gateway, so development needs no CORS; `CORS_ALLOWED_ORIGINS` still lists `http://localhost:5173` for a dev build pointed at the gateway directly.
- **Token handling:** the access token is kept in `sessionStorage` (cleared when the tab closes) and attached as `Authorization: Bearer`. The client signs the user out when the token's `exp` passes or any authenticated call returns `401`, since there is no refresh token (§0.4). Role checks in the UI are cosmetic; the services enforce them.
- **Idempotency:** each transfer attempt gets one `Idempotency-Key` (UUID v4). A retry after a network error or `5xx` reuses the key, so a double submit cannot create two transfers; the key is replaced once the server gives a definite answer.
- **Errors:** §0.5 envelopes are shown with their message, per-field `details`, and the `requestId` for support.
- **Headers:** a strict `Content-Security-Policy` (`default-src 'self'`; `connect-src` from `NGINX_CSP_CONNECT_SRC`, default `'self'`; `frame-ancestors 'none'`) plus the §8 security headers. Hashed assets under `/assets/` are cached for a year; `index.html` is `no-cache`; unknown paths fall back to `index.html`.
- **Health:** `GET /health` → `200 {"status":"ok","service":"frontend"}`. The frontend is static, so it has no `/metrics`; its traffic is measured at the gateway.

### 8.2 Demo tooling (`tools/`)

Both tools use only the Python standard library.

- **`tools/replay.py <creditcard.csv>`** replays dataset rows as transfers through the gateway: `--rate` transfers per second (at most 15, under the gateway limit), `--count`, `--fraud-ratio` (fraction of rows drawn from label-1 rows; by default the dataset's natural rate), `--users`, `--seed`. It registers and funds demo users, and each transfer sends a row's feature vector between two of them. The transfer **amount is the row's `Amount`**, so the scored vector is exactly the dataset row; rows with `Amount = 0` are skipped. Every transfer gets a fresh `Idempotency-Key`, reused when retrying after a `429`, `5xx` or network error. A sender whose account becomes frozen is retired, and a new demo user replaces it when none is left. At the end it waits (`--wait` seconds) for flagged transfers to rest, then logs per-tier outcome counts split by row label. The label never leaves the tool.
- **`tools/make_demo_samples.py <creditcard.csv>`** regenerates `frontend/src/demo/sampleFeatures.json` (§0.8). It is offline developer tooling and calls the scan services' `/score` directly on their compose host ports (`127.0.0.1:8001` and `:8002`); no client does this.

---

## 9. Failure behaviour

| Failure | Behaviour | Never |
|---|---|---|
| quick-scan down, times out, or returns non-200 | Treat as **flagged**: `UNDER_REVIEW`, `quickScan.reason = QUICK_SCAN_UNAVAILABLE`, publish to `transactions.flagged`. `quick_scan_calls_total{result="timeout|error"}` increments. | Approve without a successful quick-scan. |
| RabbitMQ down at publish time | The transaction stays `UNDER_REVIEW` with an unpublished outbox entry; the relay publishes it once the broker recovers. `POST /transactions` still returns `201`. | Lose the event, or approve. |
| deep-scan down or lagging | Messages wait durably in `transactions.flagged`; the transactions stay `UNDER_REVIEW` with funds held. Queue depth and consumer lag are alerted on (Phase 13). | Auto-approve on a timeout. |
| a scan service's model fails to load at startup | Process exits non-zero (§4.1); the container restarts with backoff. For quick-scan, transaction-service meanwhile treats calls as failed (toward review); for deep-scan, flagged messages wait in the queue. | Score with a default or dummy model. |
| alerting down | `transactions.scored` backs up; statuses stay `UNDER_REVIEW` until it recovers. | Apply a tier action twice (idempotency §3.5). |
| alerting cannot reach transaction-service | Retry through the retry queue (§3.5); after `MAX_RETRIES`, dead-lettered for manual replay. | Ack before the status update succeeds. |
| Poison message | Dead-lettered immediately. | Requeue forever. |
| MongoDB down | Services report not-ready; writes fail with `503`. | Accept a transfer without persisting it. |

Principle: **every uncertainty resolves toward review, never toward approval.**

### 9.1 Retention and timeouts (and why they differ)

| Item | Lifetime | Why |
|---|---|---|
| `Idempotency-Key` record | 24 h (TTL index) | Must outlive any realistic client retry window (mobile reconnects, replay after a crash), but is only a dedup aid, not a record of truth, so it can expire. |
| OTP challenge | 5 min, 3 attempts | A security credential: short-lived to limit brute force and phishing. Expiry resolves the transaction to `BLOCKED` (toward safety), and the user can retry the transfer. |
| Manual review case | No TTL | Resolving a `CRITICAL` case needs a human decision. Expiring it would silently decide the outcome, so it stays open until an admin acts; `review_cases_open` is monitored instead. |
| `processed_events` (alerting dedup) | 7 days | Longer than any retry or redelivery path (max 3 retries × 5 s, plus DLQ replay by an operator). |
| Transactions and alerts | Kept (no TTL) | Audit trail. |
| JWT access token | 15 min (2 h in the compose demo) | Stateless and not revocable, so kept short. |

### 9.2 Out of scope (explicitly)
- **No deletion of transactions and no account closure.** Transactions are append-only records; the only way to resolve held funds is the state machine in §2.3 (settle on `APPROVED`, release on `BLOCKED`). Because no API can delete a transaction or close an account while funds are held, the "orphaned hold" case cannot occur.
- No refresh tokens or logout (§0.4), no multi-currency, no real notification delivery (notifications and OTPs are simulated and stored).

---

## 10. Environment variables (summary)

Every service reads configuration only from the environment and ships a `.env.example`. Common to all: `PORT`, `LOG_LEVEL` (default `info`), `SERVICE_NAME`.

| Service | Variables |
|---|---|
| auth | `MONGO_URI`, `MONGO_DB=fraudguard_auth`, `JWT_SECRET`, `JWT_EXPIRES_IN=15m`, `BCRYPT_ROUNDS=12`, `LOGIN_RATE_LIMIT_MAX=5`, `INTERNAL_SERVICE_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` |
| transaction | `MONGO_URI`, `MONGO_DB=fraudguard_transactions`, `RABBITMQ_URL`, `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, `AUTH_SERVICE_URL`, `QUICK_SCAN_URL`, `QUICK_SCAN_TIMEOUT_MS=300`, `OUTBOX_RELAY_INTERVAL_MS=5000`, `PENDING_RECOVERY_SECONDS=30` |
| quick-scan | `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_USERNAME`, `MLFLOW_TRACKING_PASSWORD`, `MODEL_URI=models:/fraudguard-quick-scan@production`, `ALLOW_LOCAL_MODEL_FALLBACK=false`, `LOCAL_MODEL_PATH`, `QUICK_SCAN_THRESHOLD` (optional override) |
| deep-scan | the MLflow variables above, `MODEL_URI=models:/fraudguard-deep-scan@production`, `ALLOW_LOCAL_MODEL_FALLBACK=false`, `LOCAL_MODEL_PATH`, `RABBITMQ_URL`, `TIER_MEDIUM_MIN=0.30`, `TIER_HIGH_MIN=0.70`, `TIER_CRITICAL_MIN=0.90`, `MAX_RETRIES=3`, `PREFETCH=10` |
| alerting | `MONGO_URI`, `MONGO_DB=fraudguard_alerts`, `RABBITMQ_URL`, `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`, `TRANSACTION_SERVICE_URL`, `TIER_ACTIONS_PATH`, `TIER_ACTIONS_POLL_SECONDS=30`, `OTP_TTL_SECONDS=300`, `OTP_MAX_ATTEMPTS=3`, `EXPOSE_SIMULATED_OTP=false`, `MAX_RETRIES=3`, `PREFETCH=10`, `OTP_SECRET` (≥ 32 chars), `OTP_SWEEP_INTERVAL_SECONDS=60`, `TRANSACTION_SERVICE_TIMEOUT_MS=3000` |
| gateway | `CORS_ALLOWED_ORIGINS` (space-separated exact origins), `NGINX_RESOLVER` (DNS for lazily-resolved upstreams; `127.0.0.11` in Docker) |
| frontend | `VITE_API_BASE_URL=/api` (build time), `NGINX_CSP_CONNECT_SRC='self'` (runtime) |

## 11. Changelog
- **1.5.0** (2026-09-30): no breaking changes. Frontend (§8.1): routes, token handling, idempotent transfer retries, headers, health; the polling stop rule names the resting statuses (`ACCOUNT_FROZEN` included); demo sample categories and file shape (§0.8); replay and sample tools (§8.2); the gateway hides duplicate security headers from the frontend.
- **1.4.0** (2026-09-30): no breaking changes. tierActions.json format and consistency rules; OTP hashing (`OTP_SECRET`) and sweeper behaviour; LOG alerts are audit-only; the alerting consumer's handling of transaction-service responses; gateway error envelopes, ports, security headers and env vars.
- **1.3.0** (2026-09-30): no breaking changes. MongoDB runs as a single-node replica set, and money movements are multi-document transactions; recovery of interrupted `PENDING` transfers; every service declares the full topology of the events it touches, with mandatory publishes; transaction-service readiness no longer depends on RabbitMQ (the outbox covers outages); clarified that redelivered scored events share `eventId`/score but not timestamps.
- **1.2.0** (2026-09-30): no breaking changes. Added §4.1 model loading (pinned version download, native loading with a service-owned skops allowlist, required metadata, XGBoost best-iteration scoring) and changed model-load failure to fail-fast.
- **1.1.0** (2026-09-30): no breaking changes. The refresh/logout scope cut is now documented; the frontend demo risk profiles and the no-direct-scan-access rule are specified; tier-action reload is specified precisely (hash polling + manual endpoint); added retention/timeout rationale and explicit out-of-scope items.
- **1.0.0** (2026-09-30): initial contract.
