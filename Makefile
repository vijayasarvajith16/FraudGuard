# FraudGuard developer commands.
# Windows: run from Git Bash with GNU make installed (e.g. `winget install ezwinports.make`).

COMPOSE ?= docker compose

.DEFAULT_GOAL := help
NODE_SERVICES := auth-service

.PHONY: help up down ps logs test lint ml-test ml-lint

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

up: ## Start the local stack and wait for healthchecks
	$(COMPOSE) up -d --wait

down: ## Stop the local stack (keeps volumes)
	$(COMPOSE) down

ps: ## Show container status
	$(COMPOSE) ps

logs: ## Tail logs from all containers
	$(COMPOSE) logs -f --tail=100

test: ## Run unit tests for every service
	@set -e; for svc in $(NODE_SERVICES); do echo "==> test $$svc"; npm --prefix services/$$svc test; done

lint: ## Lint every service
	@set -e; for svc in $(NODE_SERVICES); do echo "==> lint $$svc"; npm --prefix services/$$svc run lint; done

ml-test: ## Run ML pipeline sanity tests (synthetic data, no training)
	cd ml && python -m pytest

ml-lint: ## Lint ML code with ruff
	cd ml && ruff check . && ruff format --check .
