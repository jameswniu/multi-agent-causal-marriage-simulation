# LoveWorld: Rust engine, Python experiments, React dashboard.
SHELL := /bin/bash
CARGO := source $$HOME/.cargo/env 2>/dev/null; cargo
PY := cd python && uv run
ENGINE := target/release/loveworld-engine
EXPERIMENT ?= $(abspath experiments/example.yaml)
RESULTS ?= $(abspath results/example)
PORT ?= 8765

.PHONY: help engine engine-test python-sync python-test python-lint frontend-install frontend-test frontend-lint frontend-build test lint build example placebo twins replay serve dashboard figures figures-check clean

help:
	@grep -E '^[a-z-]+:.*?## ' Makefile | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

engine: ## Build the Rust simulation engine (release)
	$(CARGO) build --release

engine-test: ## Run Rust unit and integration tests
	$(CARGO) test --release

engine-lint: ## Clippy and rustfmt check
	$(CARGO) clippy --release --all-targets -- -D warnings
	$(CARGO) fmt --all -- --check

python-sync: ## Install the Python package and dev dependencies
	cd python && uv sync

python-test: engine ## Run Python tests (statistics, end to end, API, governance)
	$(PY) pytest -q

python-lint: ## Ruff and mypy
	$(PY) ruff check .
	$(PY) mypy loveworld

frontend-install: ## Install dashboard dependencies
	cd frontend && npm install

frontend-test: ## Run dashboard tests
	cd frontend && npm test -- --run

frontend-lint: ## Lint the dashboard
	cd frontend && npm run lint

frontend-build: ## Build the dashboard into frontend/dist
	cd frontend && npm run build

test: engine-test python-test frontend-test ## Run every test suite

lint: engine-lint python-lint frontend-lint ## Run every linter

build: engine frontend-build ## Build engine and dashboard

example: engine ## Run the example experiment and analysis into results/example
	$(PY) loveworld run "$(abspath $(EXPERIMENT))" --out "$(abspath $(RESULTS))" --overwrite

placebo: engine ## Placebo run: treatment parameters equal to control
	$(PY) loveworld placebo "$(abspath $(EXPERIMENT))" --overwrite

twins: engine ## Twin runs: every couple under both arms on the same random streams
	$(PY) loveworld twins "$(abspath $(EXPERIMENT))" --overwrite

replay: engine ## Re-run the example and verify every table hash
	$(PY) loveworld replay "$(abspath $(RESULTS))"

serve: ## Serve the API and built dashboard for every experiment under results/
	$(PY) loveworld serve "$(abspath results)" --port $(PORT)

dashboard: frontend-build serve ## Build the dashboard, then serve it

figures: ## Redraw the README figures from results/example/summary.json
	python3 tools/figures.py --write

figures-check: ## Fail if a committed README figure differs from its generator
	python3 tools/figures.py --check

clean: ## Remove build outputs (keeps results/example)
	rm -rf target frontend/dist python/.venv
