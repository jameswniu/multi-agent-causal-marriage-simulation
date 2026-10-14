# The public LoveWorld dashboard in one image: the Rust engine, the built React dashboard and the
# Python API, with a few curated worlds simulated at build time so the site opens on real runs.
# Build: docker build -t loveworld .   Run: docker run -p 8080:8080 -v lwdata:/data loveworld
# docs/deploy.md has the Fly.io and Cloudflare steps; nothing here creates a cloud resource.
# Only the paths named below are copied, and .dockerignore keeps every .env file out of the build context.

# 1. The engine. rust-toolchain.toml names the stable channel, so rustup in this image installs the current
#    stable Rust and builds with it, as CI and a local build do. The image's own Rust 1.98.1 supplies rustup and
#    the base system. Which Rust builds it does not change the engine's maths: every exp, log, power and cosine
#    it computes comes from the pinned libm crate, never the platform's maths library (docs/contracts.md section 1).
FROM rust:1.98.1-slim-bookworm AS engine
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY engine ./engine
RUN cargo build --release --locked && strip target/release/loveworld-engine

# 2. The dashboard, a static bundle.
FROM node:22.21.0-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./
RUN npm run build

# 3. The Python API with the engine and dashboard laid out as in the repository (/app is the repo root).
#    Everything is owned by the unprivileged user from the start; a chown afterwards would copy every file.
FROM python:3.13.9-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/app/python/.venv \
    UV_CACHE_DIR=/tmp/uv-cache
RUN pip install --no-cache-dir uv==0.10.4 && useradd --create-home --uid 10001 loveworld \
    && mkdir -p /app /data && chown loveworld:loveworld /app /data
USER loveworld
WORKDIR /app
COPY --chown=loveworld:loveworld python/pyproject.toml python/uv.lock python/README.md ./python/
COPY --chown=loveworld:loveworld python/loveworld ./python/loveworld
RUN cd python && uv sync --frozen --no-dev && rm -rf /tmp/uv-cache
COPY --chown=loveworld:loveworld --from=engine /src/target/release/loveworld-engine ./target/release/loveworld-engine
COPY --chown=loveworld:loveworld --from=web /src/frontend/dist ./frontend/dist
COPY --chown=loveworld:loveworld experiments ./experiments
COPY --chown=loveworld:loveworld deploy/entrypoint.sh ./deploy/entrypoint.sh

# Curated worlds, simulated once here. Placebo and twins run before the example so its summary links them.
RUN set -eu; lw=/app/python/.venv/bin/loveworld; seed=/app/seed; \
    $lw placebo experiments/example.yaml --out $seed/retention-90d-placebo; \
    $lw twins experiments/example.yaml --out $seed/retention-90d-twins; \
    $lw run experiments/example.yaml --out $seed/example; \
    $lw run experiments/job-loss.yaml --out $seed/job-loss; \
    $lw run experiments/neuroticism-shift.yaml --out $seed/neuroticism-shift

ENV LOVEWORLD_PUBLIC=1 LOVEWORLD_RESULTS=/data/results PORT=8080
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
