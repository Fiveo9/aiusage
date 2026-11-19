FROM node:22-slim

ARG AIUSAGE_CONTAINER_CHECK=0

LABEL org.opencontainers.image.title="aiusage" \
      org.opencontainers.image.description="Track AI coding assistant usage, token consumption, cost, and tool calls across Claude Code, Codex, OpenCode, and more" \
      org.opencontainers.image.url="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.source="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.licenses="MIT"

RUN if [ "$AIUSAGE_CONTAINER_CHECK" != "1" ]; then apt-get update && apt-get install -y --no-install-recommends python3 make g++; fi

# Same pnpm version as "packageManager" in package.json
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
COPY scripts/remote-check-recycle.cjs scripts/docker-check-native.mjs scripts/

RUN if [ "$AIUSAGE_CONTAINER_CHECK" = "1" ]; then \
      mkdir -p /app/.check-home /app/.check-tmp && \
      HOME=/app/.check-home TMPDIR=/app/.check-tmp AIUSAGE_CHECK_ROOT=/app AIUSAGE_CONTAINER_CHECK=1 NODE_OPTIONS="--require /app/scripts/remote-check-recycle.cjs" pnpm install --frozen-lockfile --ignore-scripts --package-import-method=copy && \
      node scripts/docker-check-native.mjs; \
    else pnpm install --frozen-lockfile; fi

COPY . .
# Only build server packages (skip Electron widget)
RUN if [ "$AIUSAGE_CONTAINER_CHECK" = "1" ]; then export AIUSAGE_CHECK_ROOT=/app AIUSAGE_CONTAINER_CHECK=1 NODE_OPTIONS="--require /app/scripts/remote-check-recycle.cjs"; fi; \
    pnpm --filter @aiusage/core build && pnpm --filter @aiusage/web build && pnpm --filter @fiveo9/aiusage build

VOLUME /root/.aiusage
EXPOSE 3847

CMD ["node", "packages/cli/dist/index.js", "serve", "--host", "0.0.0.0", "--port", "3847"]
