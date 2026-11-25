FROM node:22-slim AS base

ARG AIUSAGE_CONTAINER_CHECK=0

LABEL org.opencontainers.image.title="aiusage-site" \
      org.opencontainers.image.description="Official website and documentation for AIUsage — track AI coding assistant usage, token consumption, costs, and tool calls across Claude Code, Codex, Cursor, and more" \
      org.opencontainers.image.url="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.source="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.documentation="https://github.com/Fiveo9/aiusage/tree/main/packages/site" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Fiveonine" \
      org.opencontainers.image.authors="Fiveonine"

WORKDIR /app

# Use the same pnpm pin as the workspace packageManager.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS builder

# Copy workspace root files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./

# Copy package.json files for each workspace package
COPY packages/core/package.json packages/core/
COPY packages/site/package.json packages/site/
COPY scripts/remote-check-recycle.cjs scripts/

# Install dependencies
RUN if [ "$AIUSAGE_CONTAINER_CHECK" = "1" ]; then \
      mkdir -p /app/.check-home /app/.check-tmp && \
      HOME=/app/.check-home TMPDIR=/app/.check-tmp AIUSAGE_CHECK_ROOT=/app AIUSAGE_CONTAINER_CHECK=1 NODE_OPTIONS="--require /app/scripts/remote-check-recycle.cjs" pnpm install --frozen-lockfile --ignore-scripts --package-import-method=copy; \
    else pnpm install --frozen-lockfile; fi

# Copy source code
COPY scripts/recycle-output.cjs scripts/recycle-output.cjs
COPY packages/core/ packages/core/
COPY packages/site/ packages/site/

# Build
RUN if [ "$AIUSAGE_CONTAINER_CHECK" = "1" ]; then export AIUSAGE_CHECK_ROOT=/app AIUSAGE_CONTAINER_CHECK=1 NODE_OPTIONS="--require /app/scripts/remote-check-recycle.cjs"; fi; \
    pnpm --filter @aiusage/core build && pnpm --filter @aiusage/site build && \
    pnpm --filter @aiusage/site deploy --prod /app/.deploy/site

FROM node:22-slim AS runtime
ARG BUILD_DATE

LABEL org.opencontainers.image.title="aiusage-site" \
      org.opencontainers.image.description="Official website and documentation for AIUsage — track AI coding assistant usage, token consumption, costs, and tool calls across Claude Code, Codex, Cursor, and more" \
      org.opencontainers.image.url="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.source="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Fiveonine" \
      org.opencontainers.image.created="${BUILD_DATE}"

WORKDIR /app

COPY --from=builder --chown=node:node /app/.deploy/site/package.json ./
COPY --from=builder --chown=node:node /app/.deploy/site/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/site/build ./build

ENV NODE_ENV=production
ENV PORT=3000
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => { if (!r.ok) throw new Error('unhealthy') }).catch(() => process.exit(1))"

CMD ["node", "build"]
