# ATLAS task runner. `make` lists the targets.

SERVER := apps/server
WEB := apps/web
COMPOSE_PROD := docker compose -f compose.prod.yaml
SERVICE ?=

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show available commands
	@awk 'BEGIN {FS=":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: env-check
env-check:
	@test -f .env || (echo "Missing .env. Copy .env.example to .env and fill local values." && exit 1)

# Local development

.PHONY: install
install: ## Install root (lint), server and web dependencies
	npm install
	npm --prefix $(SERVER) install
	npm --prefix $(WEB) install

.PHONY: up
up: ## Start local PostGIS (port 5434)
	docker compose up -d postgis

.PHONY: up-stack
up-stack: env-check ## Build and start the full local Docker stack (frontend, backend, PostGIS)
	docker compose --profile deploy up -d --build

.PHONY: down
down: ## Stop the local Docker stack (data volume is kept)
	docker compose --profile deploy down

.PHONY: logs
logs: ## Tail local Docker logs, optionally SERVICE=name
	docker compose --profile deploy logs -f $(SERVICE)

.PHONY: dev-server
dev-server: env-check ## Run the NestJS server in watch mode
	npm --prefix $(SERVER) run start:dev:local

.PHONY: dev-web
dev-web: ## Run the web app with Vite HMR (http://localhost:5176)
	npm --prefix $(WEB) run dev

# Database

.PHONY: db-migrate
db-migrate: env-check ## Apply pending SQL migrations (also runs on server startup)
	npm --prefix $(SERVER) run migrate:local

.PHONY: db-generate
db-generate: ## Generate a SQL migration from changes in src/database/schema.ts
	npm --prefix $(SERVER) run db:generate

.PHONY: db-shell
db-shell: ## Open psql in the local PostGIS container
	docker compose exec postgis psql -U atlas -d atlas

.PHONY: bootstrap-admin
bootstrap-admin: env-check ## Create the first ADMIN from BOOTSTRAP_ADMIN_* in .env
	npm --prefix $(SERVER) run bootstrap-admin:local

# Quality

.PHONY: check
check: ## Lint and format check (Ultracite)
	npm run check

.PHONY: fix
fix: ## Auto-fix lint and formatting (Ultracite)
	npm run fix

.PHONY: build
build: ## Typecheck and build server and web
	npm --prefix $(SERVER) run build
	npm --prefix $(WEB) run build

.PHONY: test
test: ## Run server unit tests
	npm --prefix $(SERVER) test

# Production (compose.prod.yaml)

.PHONY: prod-up
prod-up: env-check ## Build and start the production stack
	$(COMPOSE_PROD) up --build -d

.PHONY: prod-down
prod-down: env-check ## Stop the production stack (data volume is kept)
	$(COMPOSE_PROD) down

.PHONY: prod-logs
prod-logs: env-check ## Tail production logs, optionally SERVICE=name
	$(COMPOSE_PROD) logs -f $(SERVICE)

.PHONY: prod-bootstrap-admin
prod-bootstrap-admin: env-check ## Create the first ADMIN in production from BOOTSTRAP_ADMIN_* in .env
	$(COMPOSE_PROD) --profile bootstrap run --rm bootstrap-admin
