# FraudGuard developer commands.
# Windows: run from Git Bash with GNU make installed (e.g. `winget install ezwinports.make`).

COMPOSE ?= docker compose

.DEFAULT_GOAL := help
.PHONY: help up down ps logs test lint

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

test: ## Run unit tests for every service (stub until Phase 2+)
	@echo "No service tests yet; each service phase adds its test command here."

lint: ## Lint every service (stub until Phase 2+)
	@echo "No linters yet; each service phase adds its lint command here."
