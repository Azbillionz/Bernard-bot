### ── Stage 1: Builder ──────────────────────────────────────────────────────
FROM node:24-alpine AS builder

# Install pnpm
RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests and lockfile first (layer cache)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./

# Copy lib packages (workspace dependencies of api-server)
COPY lib/ ./lib/

# Copy the api-server artifact
COPY artifacts/api-server/ ./artifacts/api-server/

# Verify tsconfig.json exists before proceeding
RUN ls -la tsconfig.json || (echo "ERROR: tsconfig.json not found" && exit 1)

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build composite TypeScript libs (generates declarations needed by api-server)
RUN pnpm run typecheck:libs

# Build the api-server (esbuild bundle) — verbose output for debugging
RUN pnpm --filter @workspace/api-server run build && ls -la ./artifacts/api-server/dist/ || (echo "Build failed - dist not found" && exit 1)


### ── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests for pnpm install --prod
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/package.json ./artifacts/api-server/package.json

# Copy built artifacts from builder stage
COPY --from=builder /app/artifacts/api-server/dist/ ./artifacts/api-server/dist/

# Verify dist exists before proceeding
RUN ls -la ./artifacts/api-server/dist/ || (echo "ERROR: dist folder missing from builder stage" && exit 1)

# Install production dependencies only (externals needed at runtime)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

ENV NODE_ENV=production

WORKDIR /app/artifacts/api-server

EXPOSE 8080

CMD ["sh", "-c", "pnpm --filter @workspace/db run push-force; node --enable-source-maps ./dist/index.mjs"]

