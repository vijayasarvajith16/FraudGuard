# FraudGuard

Microservices fraud detection system with an end-to-end DevOps pipeline (prototype scope).
The full README (architecture, results, deployment) arrives in Phase 15; see [docs/playbook.md](docs/playbook.md) for the build plan.

- Service contracts: [docs/contracts.md](docs/contracts.md)
- Project conventions: [CLAUDE.md](CLAUDE.md)

## Local infrastructure

```bash
cp .env.example .env        # set passwords; change host ports if they clash with other projects
docker compose up -d --wait # MongoDB + RabbitMQ, both with healthchecks and memory limits
docker compose ps
docker compose down         # add -v to also delete data volumes
```

RabbitMQ management UI: `http://localhost:${RABBITMQ_UI_HOST_PORT}` (default 15672), with the credentials from `.env`.

The `Makefile` wraps these commands (`make up`, `make down`, `make test`, `make lint`). On Windows, run it from Git Bash with GNU make installed.
