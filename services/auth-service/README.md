# auth-service

Registration, login and JWT issuance for FraudGuard. API: [docs/contracts.md §1](../../docs/contracts.md).

| Route                                     | Auth                                          |
| ----------------------------------------- | --------------------------------------------- |
| `POST /auth/register`, `POST /auth/login` | public (login is rate-limited per IP + email) |
| `GET /auth/me`                            | Bearer token                                  |
| `GET /internal/users/lookup?email=`       | `X-Service-Token`                             |
| `GET /health`, `/health/live`, `/metrics` | public, not routed by the gateway             |

## Run

```bash
npm ci
npm test          # Jest + supertest against an in-memory MongoDB (downloads mongod on the first run)
npm run lint      # ESLint + Prettier check
docker compose up -d --wait auth-service   # from the repo root
```

Configuration is environment-only; see [.env.example](.env.example). Invalid config fails at startup and lists every problem.

## Design notes

- **Data access:** native MongoDB driver through `src/models/userRepository.js`, which validates every document with zod before writing. Duplicate emails are prevented by a unique index, not a read-then-write check, so concurrent registrations are race-free.
- **Timing-safe login:** an unknown email is compared against a dummy bcrypt hash, so response time does not reveal which emails exist.
- **Admin accounts** can only be created by the `ADMIN_EMAIL` / `ADMIN_PASSWORD` bootstrap at startup, never by registration.
- **Reusable JWT middleware:** `src/middleware/jwtAuth.js` depends only on `jsonwebtoken`. transaction-service and alerting-service copy it verbatim (each service builds its own image, so there is no shared package).
- **Metrics** are labelled by route template (`/auth/me`), including for failed requests, to keep label cardinality bounded.
- **MongoDB driver pinned to 6.x:** driver 7.x fails its connection handshake inside Jest's module sandbox ("Missing required sub-document 'driver' in the client metadata document"), although it works in plain Node. 6.21 supports MongoDB 7 and 8; revisit when 7.x fixes this.
