# FraudGuard

Microservices fraud detection system with an end-to-end DevOps pipeline (prototype scope).
The full README (architecture, results, deployment) arrives in Phase 15; see [docs/playbook.md](docs/playbook.md) for the build plan.

## CI status

| Area | Status |
|---|---|
| auth-service | [![auth-service](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/auth-service.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/auth-service.yml) |
| transaction-service | [![transaction-service](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/transaction-service.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/transaction-service.yml) |
| alerting-service | [![alerting-service](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/alerting-service.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/alerting-service.yml) |
| quick-scan-service | [![quick-scan-service](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/quick-scan-service.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/quick-scan-service.yml) |
| deep-scan-service | [![deep-scan-service](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/deep-scan-service.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/deep-scan-service.yml) |
| api-gateway | [![api-gateway](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/api-gateway.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/api-gateway.yml) |
| frontend | [![frontend](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/frontend.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/frontend.yml) |
| ml pipeline | [![ml](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/ml.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/ml.yml) |
| end-to-end (PRs) | [![e2e](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/e2e.yml/badge.svg)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/e2e.yml) |
| CodeQL | [![codeql](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/codeql.yml) |
| secret scanning | [![secrets](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/secrets.yml/badge.svg?branch=main)](https://github.com/vijayasarvajith16/FraudGuard/actions/workflows/secrets.yml) |

How the pipelines work, the image tags and branch protection: [docs/ci.md](docs/ci.md).

## Docs

- Service contracts: [docs/contracts.md](docs/contracts.md)
- Testing: [docs/testing.md](docs/testing.md)
- CI/CD: [docs/ci.md](docs/ci.md)
- ML results: [docs/ml-results.md](docs/ml-results.md)
- Project conventions: [CLAUDE.md](CLAUDE.md)

## Run it locally

Needs Docker, Node 22+, Python 3.12+ and GNU make (on Windows, run from Git Bash).

```bash
make env     # .env with generated secrets; change the host ports if they clash with other projects
make up      # build and start all 9 containers, waiting for healthchecks
make test    # unit tests for every service, the frontend and the tools
make e2e     # end-to-end suite against the stack
make down    # stop (keeps data volumes)
```

The UI and API are served by the gateway at `http://localhost:${GATEWAY_HOST_PORT}` (default 8080).
`make help` lists every target.
