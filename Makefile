# FraudGuard developer commands. Works from a clean clone: dependencies are installed on demand
# (stamp files), so `make test` and `make e2e` need only Docker, Node 22+ and Python 3.12+.
# Windows: run from Git Bash with GNU make (`winget install ezwinports.make`).

COMPOSE ?= docker compose
.DEFAULT_GOAL := help

NODE_PACKAGES := services/auth-service services/transaction-service services/alerting-service frontend
PY_SERVICES   := services/quick-scan-service services/deep-scan-service

# Interpreter used only to create the virtualenvs.
ifeq ($(OS),Windows_NT)
  BOOTSTRAP_PYTHON ?= python
  VENV_BIN := Scripts
else
  BOOTSTRAP_PYTHON ?= python3
  VENV_BIN := bin
endif
# Root dev venv: pytest, ruff, pre-commit (requirements-dev.txt).
DEV_PY := .venv/$(VENV_BIN)/python

NODE_STAMPS := $(addsuffix /node_modules/.package-lock.json,$(NODE_PACKAGES))
PY_STAMPS   := $(addsuffix /.venv/.installed,$(PY_SERVICES))

# Loads .env into the recipe's shell (compose ports, admin credentials, broker user).
LOAD_ENV = test -f .env || { echo "No .env: run 'make env' first."; exit 1; }; set -a; . ./.env; set +a

.PHONY: help env install hooks up down ps logs mongo-users test lint e2e test-integration gateway-test \
        ml-test ml-lint replay demo-samples secrets-scan clean-deps \
        k8s-up k8s-status k8s-argocd k8s-stop k8s-start k8s-down

help: ## List available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

# ---- setup ----------------------------------------------------------------------------------

env: ## Create .env from .env.example with generated secrets (never overwrites)
	$(BOOTSTRAP_PYTHON) tools/init_env.py

install: $(NODE_STAMPS) $(PY_STAMPS) .venv/.installed ## Install all dependencies (npm ci, Python venvs)

hooks: .venv/.installed ## Install the git pre-commit hooks (needs gitleaks on PATH)
	$(DEV_PY) -m pre_commit install

# npm ci whenever the lockfile changes; npm writes node_modules/.package-lock.json.
%/node_modules/.package-lock.json: %/package-lock.json
	cd $* && npm ci --no-audit --no-fund

# One virtualenv per Python service, rebuilt when its requirements change.
%/.venv/.installed: %/requirements.txt %/requirements-dev.txt
	$(BOOTSTRAP_PYTHON) -m venv $*/.venv
	$*/.venv/$(VENV_BIN)/python -m pip install -q --disable-pip-version-check -r $*/requirements-dev.txt
	touch $@

.venv/.installed: requirements-dev.txt
	$(BOOTSTRAP_PYTHON) -m venv .venv
	$(DEV_PY) -m pip install -q --disable-pip-version-check -r requirements-dev.txt
	touch $@

clean-deps: ## Remove installed dependencies (node_modules and virtualenvs)
	rm -rf $(addsuffix /node_modules,$(NODE_PACKAGES)) $(addsuffix /.venv,$(PY_SERVICES)) .venv ml/.venv .cache

# ---- stack ----------------------------------------------------------------------------------

up: ## Build and start the local stack, waiting for healthchecks
	@$(LOAD_ENV); $(COMPOSE) up -d --build --wait

down: ## Stop the local stack (keeps volumes)
	$(COMPOSE) down

mongo-users: ## Create any missing per-service MongoDB users on the running stack (idempotent)
	$(COMPOSE) exec mongodb sh -c 'mongosh --quiet -u "$$MONGO_INITDB_ROOT_USERNAME" -p "$$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin /docker-entrypoint-initdb.d/01-create-service-users.js'

ps: ## Show container status
	$(COMPOSE) ps

logs: ## Tail logs from all containers
	$(COMPOSE) logs -f --tail=100

# ---- tests ----------------------------------------------------------------------------------

# The Node services share one mongodb-memory-server binary in .cache/mongodb-binaries (their
# package.json "config"), downloaded once per clone. Suites run from their own directory, like CI.
test: $(NODE_STAMPS) $(PY_STAMPS) .venv/.installed ## Unit tests: every service, the frontend and the tools
	@set -e; for pkg in $(NODE_PACKAGES); do echo "==> test $$pkg"; (cd $$pkg && npm test); done
	@set -e; for svc in $(PY_SERVICES); do echo "==> test $$svc"; (cd $$svc && .venv/$(VENV_BIN)/python -m pytest); done
	@echo "==> test tools"; cd tools && ../$(DEV_PY) -m pytest

lint: $(NODE_STAMPS) $(PY_STAMPS) .venv/.installed ## Lint and format checks for every package
	@set -e; for pkg in $(NODE_PACKAGES); do echo "==> lint $$pkg"; (cd $$pkg && npm run lint); done
	@set -e; for svc in $(PY_SERVICES); do echo "==> lint $$svc"; (cd $$svc && .venv/$(VENV_BIN)/ruff check . && .venv/$(VENV_BIN)/ruff format --check .); done
	@echo "==> lint tools, tests, gateway tests"
	@$(DEV_PY) -m ruff check tools tests services/api-gateway/tests
	@$(DEV_PY) -m ruff format --check tools tests services/api-gateway/tests

e2e: .venv/.installed ## End-to-end suite: builds and starts the stack, then drives it through the gateway
	@$(LOAD_ENV); $(COMPOSE) up -d --build --wait
	@$(LOAD_ENV); \
	E2E_GATEWAY_URL="http://127.0.0.1:$${GATEWAY_HOST_PORT:-8080}" E2E_COMPOSE="$(COMPOSE)" \
	$(DEV_PY) -m pytest tests/e2e -c tests/e2e/pytest.ini $(E2E_ARGS)

test-integration: $(NODE_STAMPS) $(PY_STAMPS) ## Queue integration tests against the running compose RabbitMQ (throwaway vhosts)
	@$(LOAD_ENV); \
	export RABBITMQ_TEST_URL="amqp://$$RABBITMQ_DEFAULT_USER:$$RABBITMQ_DEFAULT_PASS@127.0.0.1:$${RABBITMQ_HOST_PORT:-5672}"; \
	export RABBITMQ_TEST_MGMT_URL="http://127.0.0.1:$${RABBITMQ_UI_HOST_PORT:-15672}"; \
	(cd services/transaction-service && npm run test:integration) && \
	(cd services/alerting-service && npm run test:integration) && \
	(cd services/deep-scan-service && .venv/$(VENV_BIN)/python -m pytest tests/test_consumer_integration.py)

gateway-test: .venv/.installed ## Black-box tests of the running gateway (routing, deny list, CORS, limits)
	@$(LOAD_ENV); \
	GATEWAY_URL="http://127.0.0.1:$${GATEWAY_HOST_PORT:-8080}" GATEWAY_ALLOWED_ORIGIN="http://localhost:5173" \
	$(DEV_PY) -m pytest services/api-gateway/tests -q -p no:cacheprovider

ml-test: ml/.venv/.installed ## ML pipeline sanity tests (synthetic data, no training)
	cd ml && .venv/$(VENV_BIN)/python -m pytest

ml-lint: ml/.venv/.installed ## Lint ML code with ruff
	cd ml && .venv/$(VENV_BIN)/ruff check . && .venv/$(VENV_BIN)/ruff format --check .

# History only: the pre-commit hook scans each staged diff, and the working tree legitimately
# holds the real (gitignored) .env.
secrets-scan: ## Scan the whole git history for secrets (gitleaks, .gitleaks.toml)
	gitleaks git --redact --no-banner .

# ---- kubernetes (kind) -----------------------------------------------------------------------

# Local cluster: kind + Traefik + the Helm charts in infra/helm (docs/kubernetes.md).
# KIND_HTTP_PORT=8089 (ingress on 127.0.0.1); K8S_LOCAL_IMAGES=1 deploys locally built images.
k8s-up: ## Create a kind cluster with Traefik and Argo CD; Argo CD deploys everything from Git
	bash infra/kind/k8s.sh up

k8s-status: ## Argo CD applications, pods, ingress and the kind node's memory use
	bash infra/kind/k8s.sh status

k8s-argocd: ## Open the Argo CD UI (port-forward to https://localhost:8443, prints the password)
	bash infra/kind/k8s.sh argocd

k8s-stop: ## Stop the kind node (keeps the cluster and its data)
	bash infra/kind/k8s.sh stop

k8s-start: ## Resume a stopped kind node
	bash infra/kind/k8s.sh start

k8s-down: ## Delete the kind cluster and all its data
	bash infra/kind/k8s.sh down

# ---- demo -----------------------------------------------------------------------------------

DATASET ?= ml/data/creditcard.csv
REPLAY_ARGS ?= --count 100 --rate 2 --fraud-ratio 0.2

replay: .venv/.installed ## Replay dataset rows through the gateway (REPLAY_ARGS="--count 50 --fraud-ratio 0.1")
	@$(LOAD_ENV); \
	$(DEV_PY) tools/replay.py $(DATASET) --gateway "http://127.0.0.1:$${GATEWAY_HOST_PORT:-8080}" $(REPLAY_ARGS)

demo-samples: .venv/.installed ## Regenerate frontend/src/demo/sampleFeatures.json from the running scan services
	@$(LOAD_ENV); \
	$(DEV_PY) tools/make_demo_samples.py $(DATASET) \
		--quick-url "http://127.0.0.1:$${QUICK_SCAN_HOST_PORT:-8001}" \
		--deep-url "http://127.0.0.1:$${DEEP_SCAN_HOST_PORT:-8002}"
