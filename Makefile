.PHONY: help build run test clean docker-build docker-up docker-down

help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

build: ## Build TAS binary
	@echo "Building TAS..."
	@mkdir -p bin
	go build -o bin/tas ./cmd/tas

run: build ## Run TAS locally
	@echo "Running TAS..."
	./bin/tas --config config/local.yaml

test: ## Run tests
	@echo "Running tests..."
	go test -v ./...

test-coverage: ## Run tests with coverage
	@echo "Running tests with coverage..."
	go test -v -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

lint: ## Run linter
	@echo "Running linter..."
	golangci-lint run

fmt: ## Format code
	@echo "Formatting code..."
	go fmt ./...

clean: ## Clean build artifacts
	@echo "Cleaning..."
	rm -rf bin/
	rm -f coverage.out coverage.html

docker-build: ## Build Docker image
	@echo "Building Docker image..."
	docker build -f docker/Dockerfile -t trustless-agent-substrate:latest .

docker-up: ## Start services via docker-compose
	@echo "Starting services..."
	docker-compose -f docker/docker-compose.yml up -d

docker-down: ## Stop services
	@echo "Stopping services..."
	docker-compose -f docker/docker-compose.yml down

docker-logs: ## Show docker-compose logs
	docker-compose -f docker/docker-compose.yml logs -f

setup-local: ## Setup local development environment
	@echo "Setting up local environment..."
	./scripts/setup-local.sh

deps: ## Install/update dependencies
	@echo "Installing dependencies..."
	go mod download
	go mod tidy

generate: ## Run code generation
	@echo "Running code generation..."
	go generate ./...

.DEFAULT_GOAL := help
