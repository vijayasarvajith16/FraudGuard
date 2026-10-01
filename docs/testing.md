# Testing

FraudGuard is tested in layers. Each layer catches what the one below cannot, and all of them run
from a clean clone with `make`.

| Layer | Command | Needs | What it proves |
|---|---|---|---|
| Unit | `make test` | Node 22+, Python 3.12+ | Each service's logic in isolation: validation, state machine, money movements (in-memory MongoDB), scoring with fixture models, the frontend's components, the demo tools. |
| Lint and format | `make lint` | as above | ESLint + Prettier for the Node packages, ruff for Python. |
| Queue integration | `make test-integration` | running stack | Real RabbitMQ in throwaway vhosts: publisher confirms, retry, dead-lettering and redelivery for the transaction, deep-scan and alerting consumers. |
| Gateway black box | `make gateway-test` | running stack | Routing, the deny list (scan services and `/internal` unreachable), CORS, rate limits, error envelopes, frontend headers. |
| End to end | `make e2e` | Docker | The whole system through the gateway only, as a client sees it (below). Builds and starts the stack itself. |
| ML sanity | `make ml-test` | Python | The training pipeline on synthetic data (real training runs in Colab). |
| Monitoring as code | `make test-monitoring` | Docker | promtool unit tests for every alert rule (firing and quiet cases), and every dashboard query parses (docs/monitoring.md). |
| Load | `make load-test` | the kind cluster | k6 through the ingress and gateway inside the cluster: p50/p95/p99, errors and the autoscalers' reactions per load step (docs/performance.md). |

## The end-to-end suite (`tests/e2e/`)

Standard-library HTTP client plus pytest; it never talks to a service directly. Expectations that may
legitimately change, such as the tier policy and the model's scores, are read from the running system (the admin
policy API) or come from the demo samples (docs/contracts.md §0.8), so a new model or policy file does
not break the tests' logic.

| Flow | Checks |
|---|---|
| Normal row | `APPROVED` / `LOW` instantly by quick-scan, no deep-scan, money settled, no alert. |
| No features | The neutral vector is built and approved. |
| Idempotency | Same key and body replays (`200`, `Idempotent-Replayed`); a changed body is `409`; debited once. |
| Errors | `422 INSUFFICIENT_FUNDS`, self-transfer and missing key `400`, all in the error envelope. |
| Known fraud row | `UNDER_REVIEW` at creation, then a non-LOW tier whose action and status match the live policy; alert iff the tier notifies. |
| CRITICAL | Account frozen, funds held, transfers and deposits `423`, review case visible to the admin only; approve settles and unfreezes; reject releases the funds, keeps the freeze until an admin unfreezes. |
| HIGH | `AWAITING_OTP` with funds held; wrong code shows attempts left; right code approves; replay `409`; another user `404`; three wrong codes block and release the funds. |
| Quick-scan hung (paused) | Transfer goes `UNDER_REVIEW` (`QUICK_SCAN_UNAVAILABLE`) within the 300 ms budget, then is decided by deep-scan, never approved unscored. |
| Quick-scan down (stopped) | Same, and normal traffic is approved instantly again after it restarts. |
| Deep-scan down | Flagged transfers stay `UNDER_REVIEW` with funds held; the queued message is scored when it returns. |

The last three are marked `disruptive`: they pause, stop and restart containers and always restore them.
Skip them with `make e2e E2E_ARGS='-m "not disruptive"'`. A full run takes about two minutes on a warm stack.

## From a clean clone

```bash
make env        # .env with generated secrets; edit the host ports if something else uses them
make test       # installs dependencies on first run (npm ci, one venv per Python service)
make e2e        # builds and starts the stack, runs the suite; `make down` stops it
make hooks      # optional: git pre-commit hooks
```

The scan services load the production models from the project's public DagsHub registry, so no
credentials are needed.

**Second checkout on the same machine:** Compose names the project after the folder. Two checkouts in
folders both named `FraudGuard` would share one project and its volumes, and the second `.env`'s
passwords would not match the first one's database. Give the second checkout its own project
(`export COMPOSE_PROJECT_NAME=fraudguard-2`) and stop the first stack before starting it (container
names are fixed). Never run `docker compose down -v` without checking which project it targets: it
deletes that project's volumes. On Windows, the first `make test` downloads a MongoDB archive for the in-memory
test database (about 1 GB, once per clone, into `.cache/`; on Linux it is about 70 MB).

## Git hooks and secret scanning

`make hooks` installs `.pre-commit-config.yaml`:

- **Hygiene checks:** trailing whitespace, final newlines, LF line endings, YAML/JSON/TOML syntax, merge markers, case conflicts, files over 500 kB, private keys.
- **gitleaks:** scans the staged diff (config `.gitleaks.toml`: the default rules plus narrow allowlists for known false positives, each documented).
- **A hard block** on committing `.env` files or datasets.
- **ruff:** check (with fixes) and format.
- **Prettier:** writes formatting fixes; then ESLint and Prettier checks for each Node package.

`make secrets-scan` scans the whole git history. The hooks need `gitleaks` on `PATH`
(`winget install Gitleaks.Gitleaks`, `brew install gitleaks`).
