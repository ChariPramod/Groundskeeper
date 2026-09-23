# Build from the repository root: docker build -f deploy/worker.Dockerfile .
FROM node:22.17.1-bookworm-slim
COPY --from=ghcr.io/astral-sh/uv:0.11.22 /uv /uvx /bin/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.33.0 --activate
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_CACHE_DIR=/tmp/uv-cache
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
    && uv python install 3.12 \
    && uv sync --locked --python 3.12 \
    && pnpm db:generate \
    && chown -R node:node /app /opt/python
USER node
ENV WORKER_HEALTH_HOST=0.0.0.0 WORKER_HEALTH_PORT=9090
EXPOSE 9090
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:9090/health/live").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "--import", "tsx", "apps/github/src/worker-serve.ts"]
