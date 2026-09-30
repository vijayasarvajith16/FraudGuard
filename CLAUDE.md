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
- The phase-by-phase build plan lives in docs/playbook.md.
