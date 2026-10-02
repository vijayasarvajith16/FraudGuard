# Resume material

Built only from results measured in this repository; the sources table maps every number to the
document that measured it. Nothing here is projected or rounded up.

## Bullets

- **Built FraudGuard, a fraud-screened payment system of 7 microservices** (Node.js, Python/FastAPI,
  React, MongoDB, RabbitMQ). A two-stage ML cascade has an Isolation Forest score every transfer in
  ≤ 2.5 ms (p95) and route the 6.10% it flags to an XGBoost model over RabbitMQ. It reaches 77.9%
  fraud recall at 93.7% precision on held-out data, and any outage fails toward manual review.
- **Automated delivery end to end with GitHub Actions and GitOps.** Every service has lint, tests with
  a 75% coverage floor, Trivy, CodeQL and gitleaks. Images go to GHCR, a release bot pins each tag in
  Git, and Argo CD deploys Helm charts to Kubernetes, rolling out only the changed service and
  reverting manual drift within 73 s.
- **Made the system observable and load-tested it.** Prometheus and Grafana dashboards and 11 alert
  rules are code, unit-tested with promtool. An in-cluster k6 test sustained 24 transfers/s with 0
  errors (p95 450 ms) and exposed a crash-looping bottleneck, fixed with CPU autoscaling and liveness
  tuning. A queue-depth autoscaler drained a deep-scan outage backlog in 35 s.
- **Closed the MLOps loop.** Models trained in Colab and tracked in MLflow are evaluated in CI on a
  checksum-verified test set, promoted only after human approval by pinning the version in Git, and
  watched with drift alerts. The first real promotion raised deep-scan traffic from 6.1% to 10.2% with
  no recall gain, so I added a cost gate and rolled the model back through the same pipeline.

## 30-second explanation

"FraudGuard is a payment app where every transfer is checked for fraud before money moves. A cheap
anomaly model scores every transfer in under 2.5 ms. The few it finds suspicious, 6.1%, go
through a queue to a stronger XGBoost model, and its risk tier drives an action: approve, notify, ask
for a one-time code, or freeze the account. If anything is down, transfers wait for review rather than
being approved blind. Around it is the delivery pipeline I'd want in production: CI with tests and
security scans, GitOps deployment with Argo CD on Kubernetes, Prometheus and Grafana with autoscaling,
k6 load tests, and an MLOps workflow that evaluates new models, waits for my approval, and rolls them
out. On held-out data it catches 77.9% of fraud at 93.7% precision."

## Sources

| Number | Meaning | Source |
|---|---|---|
| 7 | microservices: frontend, gateway, auth, transaction, quick-scan, deep-scan, alerting | [architecture.md](architecture.md) |
| ≤ 2.5 ms | quick-scan scoring latency, p95, inside the service | [ml-results.md](ml-results.md) |
| 6.10% | share of transactions sent to deep-scan (test split) | [ml-results.md](ml-results.md) |
| 77.9% | cascade recall, held-out test split | [ml-results.md](ml-results.md) |
| 93.7% | cascade precision, held-out test split | [ml-results.md](ml-results.md) |
| 75% | coverage floor of every service's unit tests in CI | [ci.md](ci.md) |
| 73 s | longest measured self-heal: a deleted Deployment recreated by Argo CD | [gitops.md](gitops.md) |
| 11 | Prometheus alert rules, each unit-tested with promtool | [monitoring.md](monitoring.md) |
| 24 transfers/s | highest load step with 0 errors (p95 450 ms) | [performance.md](performance.md) |
| 450 ms | p95 latency at 24 transfers/s | [performance.md](performance.md) |
| 35 s | time to drain the deep-scan outage backlog | [performance.md](performance.md) |
| 6.1% → 10.2% | deep-scan traffic of production v2 vs the first promoted model v3 | [mlops.md](mlops.md) |
