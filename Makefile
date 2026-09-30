# FraudGuard developer commands.
# Windows: run from Git Bash with GNU make installed (e.g. `winget install ezwinports.make`).

COMPOSE ?= docker compose

.DEFAULT_GOAL := help
NODE_SERVICES := auth-service transaction-service alerting-service
PY_SERVICES := quick-scan-service deep-scan-service
# Python interpreter with the service dev requirements installed (e.g. an activated venv).
PYTHON ?= python

.PHONY: help up down ps logs test lint mongo-users test-integration gateway-test ml-test ml-lint replay demo-samples

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

up: ## Start the local stack and wait for healthchecks
	$(COMPOSE) up -d --wait

down: ## Stop the local stack (keeps volumes)
	$(COMPOSE) down

mongo-users: ## Create any missing per-service MongoDB users on the running stack (idempotent)
	$(COMPOSE) exec mongodb sh -c 'mongosh --quiet -u "$$MONGO_INITDB_ROOT_USERNAME" -p "$$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin /docker-entrypoint-initdb.d/01-create-service-users.js'

ps: ## Show container status
	$(COMPOSE) ps

logs: ## Tail logs from all containers
	$(COMPOSE) logs -f --tail=100

# Node suites run from their own directory: mongodb-memory-server resolves its cached binary
# (node_modules/.cache) from the working directory, and npm --prefix would miss it.
test: ## Run unit tests for every service, the frontend and the tools
	@set -e; for svc in $(NODE_SERVICES); do echo "==> test $$svc"; (cd services/$$svc && npm test); done
	@set -e; for svc in $(PY_SERVICES); do echo "==> test $$svc"; (cd services/$$svc && $(PYTHON) -m pytest); done
	@echo "==> test frontend"; cd frontend && npm test
	@echo "==> test tools"; cd tools && $(PYTHON) -m pytest

test-integration: ## Queue integration tests against the running compose RabbitMQ (throwaway vhosts)
	@set -a; . ./.env; set +a; \
	export RABBITMQ_TEST_URL="amqp://$$RABBITMQ_DEFAULT_USER:$$RABBITMQ_DEFAULT_PASS@127.0.0.1:$${RABBITMQ_HOST_PORT:-5672}"; \
	export RABBITMQ_TEST_MGMT_URL="http://127.0.0.1:$${RABBITMQ_UI_HOST_PORT:-15672}"; \
	(cd services/transaction-service && npm run test:integration) && \
	(cd services/alerting-service && npm run test:integration) && \
	(cd services/deep-scan-service && $(PYTHON) -m pytest tests/test_consumer_integration.py)

gateway-test: ## Black-box tests of the running API gateway (routing, deny list, CORS, limits)
	@set -a; . ./.env; set +a; \
	GATEWAY_URL="http://127.0.0.1:$${GATEWAY_HOST_PORT:-8080}" GATEWAY_ALLOWED_ORIGIN="http://localhost:5173" \
	$(PYTHON) -m pytest services/api-gateway/tests -q -p no:cacheprovider

lint: ## Lint every service
	@set -e; for svc in $(NODE_SERVICES); do echo "==> lint $$svc"; (cd services/$$svc && npm run lint); done
	@set -e; for svc in $(PY_SERVICES); do echo "==> lint $$svc"; (cd services/$$svc && ruff check . && ruff format --check .); done
	@echo "==> lint frontend"; cd frontend && npm run lint
	@echo "==> lint tools"; cd tools && ruff check . && ruff format --check .

ml-test: ## Run ML pipeline sanity tests (synthetic data, no training)
	cd ml && python -m pytest

ml-lint: ## Lint ML code with ruff
	cd ml && ruff check . && ruff format --check .

DATASET ?= ml/data/creditcard.csv
REPLAY_ARGS ?= --count 100 --rate 2 --fraud-ratio 0.2

replay: ## Replay dataset rows through the gateway (REPLAY_ARGS="--count 50 --fraud-ratio 0.1")
	@set -a; . ./.env; set +a; \
	$(PYTHON) tools/replay.py $(DATASET) --gateway "http://127.0.0.1:$${GATEWAY_HOST_PORT:-8080}" $(REPLAY_ARGS)

demo-samples: ## Regenerate frontend/src/demo/sampleFeatures.json from the running scan services
	@set -a; . ./.env; set +a; \
	$(PYTHON) tools/make_demo_samples.py $(DATASET) \
		--quick-url "http://127.0.0.1:$${QUICK_SCAN_HOST_PORT:-8001}" \
		--deep-url "http://127.0.0.1:$${DEEP_SCAN_HOST_PORT:-8002}"
