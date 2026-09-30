# FraudGuard: Claude Code Prompt Playbook

Sixteen phases, each with a paste-ready prompt and a "Done when" check. Every phase leaves the repo in a working, committed state.

## How to work with Claude Code

1. **One phase per session.** Run `/clear` (or start a new session) between phases. `CLAUDE.md` carries the context forward, so you never re-explain the project.
2. **Plan first.** Start each phase in plan mode (Shift+Tab to cycle). Read the plan, correct it, then let it execute.
3. **Commit after every phase**, with a conventional-commit message (`feat(auth): ...`). Your Git history becomes part of the portfolio.
4. **Run the "Done when" check yourself** before moving on. If it fails, paste the error back in the same session.
5. **Keep the contracts file authoritative.** If a service needs a change, update `docs/contracts.md` first, then the code.
6. **Never paste secrets.** Use `.env` files (gitignored) and GitHub Actions secrets.
---

## Phase 0: Project memory and repo init

Create the repo folder manually, run `git init`, start Claude Code, and paste:

```
Create a CLAUDE.md at the repo root with this content, and create a .gitignore covering Node, Python, Terraform, .env files, ml/data/, model binaries (*.pkl, *.json models under ml/artifacts/), and IDE folders. Then make the initial commit.

# FraudGuard
Microservices fraud detection system with an end-to-end DevOps pipeline. Portfolio project for internship applications; prototype scope, not production-certified.

## Architecture
- services/auth-service (Node/Express, JWT)
- services/transaction-service (Node/Express, wallet + transactions, publishes to RabbitMQ)
- services/quick-scan-service (Python/FastAPI, Isolation Forest, sync scoring on every transaction)
- services/deep-scan-service (Python/FastAPI + RabbitMQ consumer, XGBoost, only on flagged transactions)
- services/alerting-service (Node/Express, consumes scored results, maps risk tier to mitigation via config/tierActions.json)
- services/api-gateway (Node or Nginx)
- frontend/ (React)
- ml/ (training scripts and Colab notebooks, MLflow logging)
- infra/ (helm, terraform, argocd, monitoring)
- .github/workflows/ (reusable workflows + one thin workflow per service)

## Flow
POST /transactions -> quick-scan (sync) -> if not flagged: APPROVED, tier LOW. If flagged: status UNDER_REVIEW, publish to queue transactions.flagged -> deep-scan consumes, scores, publishes to transactions.scored -> alerting maps tier to action (log, notify, OTP step-up, block, account freeze) and calls transaction-service to finalize status.

## Conventions
- Native MongoDB driver (no Mongoose), with explicit validation in a small data-access layer.
- RabbitMQ only (no Kafka).
- Every service exposes GET /health and GET /metrics (Prometheus format).
- Config via environment variables only; every service ships a .env.example.
- Structured JSON logging.
- Every service has tests and must pass lint + tests before commit.
- Dockerfiles: multi-stage, slim/alpine base, non-root user, HEALTHCHECK.
- Models are loaded from the MLflow registry by alias at startup, with a local fallback path used only in tests.
- Dev machine has 16GB RAM: docker-compose must set memory limits; no Kubernetes required for daily dev.
- ML training happens in Google Colab, not locally.
- Dataset: public Kaggle Credit Card Fraud (features Time, V1-V28, Amount, label Class), ~0.17% fraud.

## Working rules
- Read docs/contracts.md before changing any service API or queue message.
- Make small, reviewable changes. Explain what you ran to verify.
- Do not commit secrets or datasets.
```

**Done when:** `CLAUDE.md` and `.gitignore` exist and are committed.

---

## Phase 1: Contracts and scaffold

```
Enter plan mode. Create the folder structure from CLAUDE.md (services/*, frontend/, ml/, infra/, .github/workflows/, docs/) with empty placeholder files where needed.

Then write docs/contracts.md defining, precisely:
1. REST APIs for every service (paths, methods, request/response JSON, status codes, auth requirements). Include the gateway's route table.
2. The transaction JSON schema: id, userId, amount, features (Time, V1-V28), status (PENDING | APPROVED | UNDER_REVIEW | BLOCKED | ACCOUNT_FROZEN | AWAITING_OTP), riskScore, riskTier (LOW | MEDIUM | HIGH | CRITICAL), timestamps.
3. RabbitMQ topology: exchanges, queues (transactions.flagged, transactions.scored, plus dead-letter queues), message schemas, retry policy, idempotency key.
4. Risk tier thresholds on the deep-scan probability (propose defaults, make them env-configurable) and the default tier-to-action mapping.
5. Failure behaviour: what happens if quick-scan is down or times out (fail toward review, not toward approval), and if deep-scan lags.

Also create a root docker-compose.yml skeleton containing only MongoDB and RabbitMQ (management UI enabled) with memory limits and healthchecks, and a Makefile with targets up, down, test, lint (they can be stubs for now).
```

**Done when:** `docker compose up` starts MongoDB and RabbitMQ healthy, and `docs/contracts.md` reads like something a teammate could build against.

---

## Phase 2: Auth service

```
Enter plan mode, then implement services/auth-service per docs/contracts.md.
- Express app with routes: POST /auth/register, POST /auth/login, GET /auth/me, GET /health, GET /metrics.
- Native MongoDB driver in a small data-access layer with explicit input validation (no Mongoose). Unique index on email.
- bcrypt password hashing, JWT access tokens, secret from env.
- JWT verification middleware exported as a reusable module other Node services can copy or import.
- Rate limiting on login, helmet, request logging as JSON, consistent error format.
- Jest + supertest tests (use mongodb-memory-server or a test container), ESLint + Prettier config.
- Multi-stage Dockerfile (node alpine, non-root, HEALTHCHECK), .env.example.
- Add the service to docker-compose.yml with a memory limit.
Run lint and tests and show me the results.
```

**Done when:** register and login work through `docker compose up`, and `npm test` and `npm run lint` pass.

---

## Phase 3: ML training pipeline (Colab plus MLflow)

Before this phase: download the Kaggle dataset into Colab (or Drive) and create a free DagsHub repo to get an MLflow tracking URI.

```
Enter plan mode. Build the ML training pipeline under ml/.
- ml/src/data.py: load the Kaggle credit card fraud CSV, stratified train/validation/test split, save the split metadata (not the data).
- ml/src/train_quick_scan.py: Isolation Forest trained unsupervised on mostly-normal data. Choose the contamination/threshold by validation recall at an acceptable flag rate. Goal: high recall, fast inference, flags a small fraction of traffic.
- ml/src/train_deep_scan.py: XGBoost classifier that handles severe class imbalance (scale_pos_weight, evaluate with PR-AUC, precision, recall, F1 at chosen thresholds; not accuracy). Save the model in XGBoost's native JSON format, not pickle.
- ml/src/evaluate.py: loads a model and computes metrics on the held-out test set, exits non-zero if recall or PR-AUC fall below thresholds passed as arguments (this will be a CI regression gate later). Also evaluate the full cascade: overall recall, precision, and the percentage of transactions that reach the deep scan.
- Log params, metrics, plots (PR curve, confusion matrix), library versions, and the model to MLflow. Register models as fraudguard-quick-scan and fraudguard-deep-scan. Tracking URI and credentials come from env vars.
- ml/requirements.txt with pinned versions.
- ml/notebooks/train_in_colab.ipynb: a thin notebook that mounts Drive, clones the repo, pip installs requirements, sets MLflow env vars from Colab secrets, runs both training scripts and evaluate.py.
- A small ml/README.md explaining how to run it in Colab.
Do not run heavy training locally. Give me exact Colab steps.
```

**Done when:** both models appear in the MLflow registry with metrics, and `evaluate.py` reports cascade recall, precision, and the deep-scan traffic percentage. Save those numbers for your resume.

After the run, manually set the registry alias `production` on each model version.

---

## Phase 4: Quick-scan and deep-scan HTTP services

```
Enter plan mode. Implement services/quick-scan-service and services/deep-scan-service (FastAPI) per docs/contracts.md.
Both:
- POST /score taking the transaction features, returning score, flagged (quick) or probability and riskTier (deep), plus model version.
- Load the model from the MLflow registry by alias at startup (env: MLFLOW_TRACKING_URI, MODEL_URI). If unavailable, fall back to a local model path only when an env flag is set (used in tests). Fail loudly otherwise.
- Pydantic schemas validating exactly the fields in the contract, GET /health (includes model version), GET /metrics with Prometheus metrics: request count, scoring latency histogram, flagged count, model version gauge.
- pytest tests using a tiny fixture model trained in the test setup, ruff for lint, pinned requirements matching ml/requirements.txt versions.
- Slim multi-stage Dockerfiles, non-root, HEALTHCHECK, .env.example.
- Add both to docker-compose.yml with memory limits (deep-scan gets more than quick-scan).
Do not add the queue consumer yet.
```

**Done when:** `curl` to `/score` on each service returns sensible results for a normal row and a known fraud row.

---

## Phase 5: Transaction service and the queue path

```
Enter plan mode. Implement services/transaction-service per docs/contracts.md, and add the RabbitMQ consumer to deep-scan-service.

transaction-service:
- Wallet balance and transactions collections (native MongoDB driver). Endpoints: deposit, transfer/payment, get transaction, list my transactions, plus an internal endpoint (service-token protected) for the alerting service to finalize a transaction's status.
- On POST /transactions: validate, store as PENDING, call quick-scan synchronously with a short timeout. Not flagged: APPROVED with tier LOW. Flagged: UNDER_REVIEW and publish to transactions.flagged. Quick-scan error or timeout: treat as flagged (fail toward review).
- Idempotency key support, JWT auth using auth-service tokens, GET /health, GET /metrics.
- Publisher in src/queue/ with retries and confirms.

deep-scan-service:
- Add a background consumer for transactions.flagged: score with XGBoost, map to a risk tier using env-configurable thresholds, publish to transactions.scored. Ack only after publish; dead-letter poison messages after N retries. Consumer must be idempotent.
- Expose queue-consumed and queue-processing-latency metrics.

Add tests (unit plus an integration test using a RabbitMQ test container or the compose stack) and update docker-compose.yml.
```

**Done when:** a flagged transaction ends up as a message on `transactions.scored` (visible in the RabbitMQ UI), and a normal one is approved immediately.

---

## Phase 6: Alerting service and API gateway

```
Enter plan mode. Implement services/alerting-service and services/api-gateway.

alerting-service:
- Consume transactions.scored. Look up the tier in config/tierActions.json (default: LOW -> log only; MEDIUM -> notify user; HIGH -> step-up OTP verification and hold; CRITICAL -> block, freeze account, escalate to manual review queue). Execute the action (notifications and OTP are simulated: persist them in MongoDB and log them), then call transaction-service's internal endpoint to finalize status.
- Endpoints to list a user's alerts, verify an OTP, and list the manual review queue with approve/reject for an admin role.
- The mapping must be reloadable from config without redeploying models (env var or config file path; document it).
- Idempotent handling of duplicate messages, health, metrics, tests, Dockerfile, .env.example, compose entry.

api-gateway:
- Use Nginx (preferred for lightness) or a small Node proxy. Route /api/auth, /api/transactions, /api/alerts, rate limit, CORS, request IDs propagated downstream, health endpoint.
- Do not expose the scan services or internal endpoints through the gateway.
```

**Done when:** the whole flow works through the gateway with `curl`: a high-risk transaction produces an alert and a changed status.

---

## Phase 7: Frontend and transaction replay tool

```
Enter plan mode. Two deliverables.

1. frontend/ (React, Vite): login/register, wallet dashboard, "make a transfer" form, transaction history with a risk tier badge and status, an alerts page with OTP verification, and an admin page for the manual review queue. Talk only to the gateway. Keep the UI clean and light; no heavy UI libraries. Multi-stage Dockerfile serving the build with Nginx (non-root). Add to compose.

2. tools/replay.py: reads the Kaggle CSV (path from arg) and replays rows as transactions through the gateway at a configurable rate, with a --fraud-ratio option that oversamples fraud rows for demos, logging per-tier outcome counts at the end. The dataset features are anonymized, so the replay tool supplies the feature vector while userId, amount, and recipient come from generated demo users.
```

**Done when:** you can run the replay tool and watch tiers and alerts appear in the UI.

---

## Phase 8: Tests and end-to-end verification

```
Enter plan mode. Add an end-to-end test suite under tests/e2e/ that runs against docker compose: register, deposit, send a normal transaction (expect APPROVED/LOW), send a known fraud row (expect a non-LOW tier and the action mapped for that tier), verify OTP flow, verify a CRITICAL case freezes the account. Fail-toward-review test: stop quick-scan and confirm a transaction goes UNDER_REVIEW instead of approved. Wire `make test` to run unit tests for every service and `make e2e` for the compose suite. Also add pre-commit hooks (lint, format, secrets scan with gitleaks).
```

**Done when:** `make test` and `make e2e` both pass from a clean clone.

---

## Phase 9: CI with GitHub Actions

```
Enter plan mode. Build the CI under .github/workflows/.
- Two reusable workflows (workflow_call): _node-service.yml and _python-service.yml. Steps: checkout, cache deps, lint, unit tests with coverage, Dependabot-compatible dependency audit (npm audit / pip-audit), Docker build with buildx cache, Trivy image scan failing on HIGH/CRITICAL, and on main only: push the image to GHCR tagged with the commit SHA and semver.
- One thin workflow per service (auth, transaction, alerting, gateway, quick-scan, deep-scan, frontend) that triggers only on changes under that service's path and calls the reusable workflow.
- A separate workflow for ml/ that runs lint and the tiny-model sanity tests. Do not train in CI.
- A CodeQL workflow, .github/dependabot.yml for npm, pip, docker, and github-actions, and a workflow that runs the e2e suite on pull requests to main.
- Add branch protection guidance to docs/ (required checks).
- Add a CI status badge section to the README.
```

**Done when:** a change to one service triggers only its workflow, and images land in GHCR on merge.

---

## Phase 10: Kubernetes with Helm

```
Enter plan mode. Create Helm charts under infra/helm/. Prefer one shared chart (infra/helm/service) with a values-<service>.yaml per service, plus small charts or values for MongoDB and RabbitMQ (use lightweight configurations).
Requirements: Deployment, Service, ConfigMap, Secret references (no real secrets committed), liveness and readiness probes on /health, resource requests and limits sized for a small cluster, Ingress routing to the gateway and frontend, and image tags in values files so CI can bump them. Scan services get distinct resource profiles (quick-scan: low latency, small; deep-scan: bigger).
Add a kind cluster config and a make target (make k8s-up) that creates a kind cluster, installs an ingress controller, and deploys everything. Document the memory footprint and how to stop it.
```

**Done when:** `make k8s-up` brings up the app on kind and the UI works through the ingress.

---

## Phase 11: Terraform

```
Enter plan mode. Write Terraform under infra/terraform/ to provision the demo environment. Ask me which target I'm using (Oracle Cloud free-tier VM with k3s, or another cloud) before writing provider code. Use modules (network, compute, cluster bootstrap), variables and outputs, a remote or documented local state approach, and no hardcoded credentials. The bootstrap should install k3s and ArgoCD, and output the kubeconfig instructions and ingress address. Add `terraform fmt` and `terraform validate` steps to a CI workflow, plus tfsec or Trivy config scanning. Document `terraform apply` and `terraform destroy` costs and teardown clearly.
```

**Done when:** `terraform validate` passes in CI and `apply` produces a reachable cluster.

---

## Phase 12: GitOps with ArgoCD

```
Enter plan mode. Add ArgoCD config under infra/argocd/: an app-of-apps root application plus one Application per service pointing at infra/helm, automated sync with prune and self-heal, and sync waves so MongoDB and RabbitMQ come up before services. Extend the CI release step so a merge to main opens or commits an image-tag bump in the Helm values (a separate commit by a bot using the workflow token), which ArgoCD then syncs. Document the promotion flow with a diagram in docs/.
```

**Done when:** a code change merges, CI builds, the tag bumps automatically, and ArgoCD rolls it out with no manual kubectl.

---

## Phase 13: Monitoring, autoscaling, load test

```
Enter plan mode. Add observability under infra/monitoring/ using a lightweight Prometheus and Grafana deployment (not the full kube-prometheus-stack; keep memory small and retention short).
- Scrape all services' /metrics. Provision Grafana dashboards as code: fraud-flag rate, deep-scan traffic percentage, risk-tier distribution, quick-scan and deep-scan latency (p50/p95), RabbitMQ queue lag, error rates.
- Prometheus alert rules: high queue lag, scan latency SLO breach, service down, and sudden spike in CRITICAL tiers.
- HPA for quick-scan and deep-scan with different metrics and limits (CPU for quick-scan, queue depth or CPU for deep-scan).
- A k6 load test script in tests/load/ that ramps traffic through the gateway and records p95 latency, error rate, and the point at which HPA scales. Save results as a markdown table in docs/performance.md.
```

**Done when:** dashboards show live data during a replay run, and the load test produces real numbers for the README and resume.

---

## Phase 14: MLOps loop

```
Enter plan mode. Close the MLOps loop.
- A GitHub Actions workflow (manual trigger and scheduled) that runs ml/src/evaluate.py against the registered candidate model versions and fails if recall or PR-AUC fall below thresholds.
- A promotion script that, when evaluation passes, moves the MLflow alias production to the new version and bumps the model version in the Helm values (committed by the bot), so ArgoCD rolls the scan services with the new model.
- Drift monitoring: add a light Prometheus metric in the scan services for the score distribution and flag rate over time, plus a Grafana panel and an alert rule for drift-like shifts.
- Document the model lifecycle in docs/mlops.md (train in Colab, register, evaluate, promote, roll out, monitor, retrain).
```

**Done when:** registering a better model and running the workflow results in the scan services running the new model version, visible on the Grafana version gauge.

---

## Phase 15: Documentation, README, resume material

```
Enter plan mode. Produce the portfolio-facing documentation.
- README.md: one-paragraph pitch, architecture diagram (Mermaid), the two-stage cascade explanation with the real measured numbers from docs/performance.md and the ML evaluation, a pipeline diagram (Mermaid) showing every DevOps phase and its tools, screenshots placeholders (UI, Grafana, ArgoCD, GitHub Actions), quick start (docker compose) and full deploy (Terraform + ArgoCD) instructions, and a limitations section (prototype scope, public dataset, no compliance certification, demo-scale load).
- docs/architecture.md with a sequence diagram of quick-scan, queue, deep-scan, alert, finalize.
- docs/decisions/ with short ADRs: RabbitMQ over Kafka, GitOps with ArgoCD, cascade design, policy decoupled from models, fail toward review.
- docs/resume.md with 4 resume bullets built only from numbers that actually exist in the repo (fill from measured results, no placeholders left) and a 30-second interview explanation of the system.
```

**Done when:** a stranger can understand, run, and evaluate the project from the README alone.

---

## Prompts for when things go wrong

**Failing test or CI run:**
```
Here is the failing output: <paste>. Find the root cause before changing code, explain it in two sentences, then fix it and rerun the failing command.
```

**Claude Code drifts from the contract:**
```
Re-read docs/contracts.md and CLAUDE.md. List every place your last change deviates from them, then fix the code (or propose a contract update, not both silently).
```

**Before each commit:**
```
Review your own diff as a strict code reviewer: bugs, missing error handling, secrets, missing tests, inconsistencies with CLAUDE.md. Fix what you find, run lint and tests, then commit with a conventional commit message.
```

**Memory or resource trouble on the laptop:**
```
The stack is using too much RAM on my 16GB machine. Profile the compose stack's memory use per container, then propose and apply reductions (limits, slimmer images, disabling optional services in a "lite" compose profile) without changing behavior.
```
