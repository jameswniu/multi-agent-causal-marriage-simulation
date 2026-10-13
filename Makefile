# LoveWorld: Rust engine, Python experiments, React dashboard.
SHELL := /bin/bash
CARGO := source $$HOME/.cargo/env 2>/dev/null; cargo
PY := cd python && uv run
ENGINE := target/release/loveworld-engine
EXPERIMENT ?= $(abspath experiments/example.yaml)
RESULTS ?= $(abspath results/example)
PORT ?= 8765
# The free read-only demo: the folder it is built into, the path GitHub Pages serves it under, and a local port.
SITE ?= $(abspath site)
PAGES_BASE ?= /multi-agent-causal-marriage-simulation/
STATIC_PORT ?= 8790
# The dashboard's pages. Each gets its own copy of index.html, which GitHub Pages serves for a link to that page
# with status 200; a link to one couple or agent reaches the app through 404.html instead.
STATIC_PAGES := world overview comparisons couples agents policy governance new

.PHONY: help engine engine-test python-sync python-test python-lint frontend-install frontend-test frontend-lint frontend-build test lint build example placebo twins replay serve dashboard figures figures-check clean demo static static-frontend serve-static

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

serve: ## Serve the API and built dashboard for every experiment under results/ (reads an optional .env)
	@# Only this recipe reads the untracked .env, so its settings never reach builds or installs.
	set -e; set -a; if [ -f .env ]; then . ./.env; fi; set +a; $(PY) loveworld serve "$(abspath results)" --port $(PORT)

dashboard: frontend-build serve ## Build the dashboard, then serve it

demo: engine ## Run the read-only demo's shocks (experiments/demo/) on the example world; run example first
	$(PY) loveworld demo "$(abspath results)"

static: ## Export the example and demo worlds as gzipped files for the read-only demo, into site/data
	$(PY) loveworld static "$(abspath results)" --site "$(SITE)"

static-frontend: ## Build the dashboard in read-only static mode into site/, with a page per route and 404.html for deep links
	cd frontend && VITE_STATIC=1 VITE_BASE=$(PAGES_BASE) npm run build -- --outDir dist-static --emptyOutDir
	rm -rf "$(SITE)/assets" "$(SITE)/index.html" "$(SITE)/404.html" $(foreach page,$(STATIC_PAGES),"$(SITE)/$(page).html")
	mkdir -p "$(SITE)"
	cp -R frontend/dist-static/. "$(SITE)/"
	cp "$(SITE)/index.html" "$(SITE)/404.html"
	for page in $(STATIC_PAGES); do cp "$(SITE)/index.html" "$(SITE)/$$page.html"; done

serve-static: ## Serve site/ the way GitHub Pages does, on port 8790 under the repository's path
	python3 tools/serve_static.py "$(SITE)" --port $(STATIC_PORT) --base $(PAGES_BASE)

figures: ## Redraw the README figures from results/example/summary.json
	python3 tools/figures.py --write

figures-check: ## Fail if a committed README figure differs from its generator
	python3 tools/figures.py --check

clean: ## Remove build outputs (keeps results/example)
	rm -rf target frontend/dist frontend/dist-static site python/.venv
