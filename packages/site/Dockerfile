FROM node:20-slim AS base

ARG BUILD_DATE
ARG AIUSAGE_CONTAINER_CHECK=0

LABEL org.opencontainers.image.title="aiusage-site" \
      org.opencontainers.image.description="Official website and documentation for AIUsage — track AI coding assistant usage, token consumption, costs, and tool calls across Claude Code, Codex, Cursor, and more" \
      org.opencontainers.image.url="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.source="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.documentation="https://github.com/Fiveo9/aiusage/tree/main/packages/site" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Fiveonine" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.authors="Julian <juliantanx@users.noreply.github.com>"

WORKDIR /app

# Pin pnpm to v9 (compatible with Node 20)
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
    pnpm --filter @aiusage/core build && pnpm --filter @aiusage/site build

FROM base AS prod-deps

# Install production dependencies in their own layer. Source changes should not
# invalidate this expensive step unless dependency manifests change.
COPY packages/core/package.json packages/core/package.json
COPY packages/site/package.json packages/site/package.json
COPY scripts/remote-check-recycle.cjs scripts/
RUN mkdir -p /deploy/packages/core && \
    cp /app/packages/core/package.json /deploy/packages/core/package.json && \
    cat /app/packages/site/package.json | \
      node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('/dev/stdin','utf8')); delete pkg.devDependencies; delete pkg.scripts; pkg.type='module'; pkg.dependencies=pkg.dependencies||{}; pkg.dependencies['@aiusage/core']='file:./packages/core'; fs.writeFileSync('/deploy/package.json',JSON.stringify(pkg,null,2)+'\n')" && \
    cd /deploy && \
    if [ "$AIUSAGE_CONTAINER_CHECK" = "1" ]; then \
      mkdir -p /deploy/.check-home /deploy/.check-tmp && \
      HOME=/deploy/.check-home TMPDIR=/deploy/.check-tmp AIUSAGE_CHECK_ROOT=/deploy AIUSAGE_CONTAINER_CHECK=1 NODE_OPTIONS="--require /app/scripts/remote-check-recycle.cjs" npm install --omit=dev --ignore-scripts --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi

FROM node:20-slim

LABEL org.opencontainers.image.title="aiusage-site" \
      org.opencontainers.image.description="Official website and documentation for AIUsage — track AI coding assistant usage, token consumption, costs, and tool calls across Claude Code, Codex, Cursor, and more" \
      org.opencontainers.image.url="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.source="https://github.com/Fiveo9/aiusage" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Fiveonine"

WORKDIR /app

COPY --from=builder /app/packages/site/build ./build
COPY --from=prod-deps /deploy/package.json ./
COPY --from=prod-deps /deploy/node_modules ./node_modules
COPY --from=prod-deps /deploy/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/core/dist ./packages/core/dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => { if (!r.ok) throw new Error('unhealthy') }).catch(() => process.exit(1))"

CMD ["node", "build"]
