### ── Stage 1: Builder ──────────────────────────────────────────────────────
FROM node:24-alpine AS builder

# Install pnpm
RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests and lockfile first (layer cache)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./

# Copy lib packages (workspace dependencies of api-server)
COPY lib/ ./lib/

# Copy the api-server artifact
COPY artifacts/api-server/ ./artifacts/api-server/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build composite TypeScript libs (generates declarations needed by api-server)
RUN pnpm run typecheck:libs

# Build the api-server (esbuild bundle)
RUN pnpm --filter @workspace/api-server run build


### ── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace manifests for pnpm install --prod
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY artifacts/api-server/dist/ ./artifacts/api-server/dist/

# Install production dependencies only (externals needed at runtime)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

ENV NODE_ENV=production

WORKDIR /app/artifacts/api-server

EXPOSE 8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
