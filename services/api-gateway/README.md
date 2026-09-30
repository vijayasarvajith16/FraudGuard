# api-gateway

Nginx (official unprivileged image, stable 1.30) as the single public entry point (docs/contracts.md §8). Listens on **8080** as a non-root user.

| Path                                                                                                | Upstream                                                                      |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /health`                                                                                       | answered by the gateway                                                       |
| `/api/auth/*`                                                                                       | auth-service `/auth/*` (`POST /api/auth/login`: 10 req/min per IP, burst 5)   |
| `/api/wallet*`, `/api/transactions*`                                                                | transaction-service                                                           |
| `/api/alerts*`                                                                                      | alerting-service                                                              |
| `/`                                                                                                 | frontend SPA (Phase 7), resolved per request so the gateway starts without it |
| `/internal*`, `/metrics`, `/api/**/internal`, `/api/**/metrics`, `/api/**/health`, unknown `/api/*` | `404`                                                                         |

The scan services have **no route at all**.

- **Rate limits:** 20 req/s per IP (burst 40) on the API; login additionally 10/min. Returns `429` with `Retry-After`.
- **Request IDs:** a well-formed incoming `X-Request-Id` is kept, otherwise one is generated. It is forwarded upstream and returned exactly once.
- **Errors produced by the gateway** (`404`, `413` over 100 kB, `429`, `502`–`504`) use the contract's JSON envelope.
- **CORS:** `CORS_ALLOWED_ORIGINS` (space-separated exact origins) becomes an nginx `map` at startup (`docker-entrypoint.d/20-cors-origins.sh`). Unlisted origins get no CORS headers, and preflight `OPTIONS` is answered by the gateway.
- **Security headers** (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`), `server_tokens off`, JSON access log to stdout.
- `stub_status` only on internal port **8090** (`/nginx_status`), for the Prometheus exporter in Phase 13.

Configuration: `NGINX_RESOLVER` (DNS for lazy upstreams; `127.0.0.11` in Docker) and `CORS_ALLOWED_ORIGINS`. Only `NGINX_*` variables are substituted into the template, so nginx's own `$variables` are untouched.

## Test

```bash
make gateway-test   # 25 black-box tests against the running stack (routing, deny list, CORS, 413, rate limit)
```
