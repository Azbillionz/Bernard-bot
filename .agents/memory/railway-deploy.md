---
name: Railway Deployment
description: How to deploy this pnpm monorepo to Railway
---

**Files**: `Dockerfile` (root), `railway.json` (root), `.dockerignore` (root)

**Builder**: Docker (not Nixpacks) — specified in `railway.json` as `"builder": "DOCKERFILE"`. More reliable for pnpm monorepos.

**Dockerfile strategy** (2-stage):
1. Builder: installs all deps, runs `pnpm run typecheck:libs`, then `pnpm --filter @workspace/api-server run build`
2. Runtime: copies only `dist/` + prod node_modules; runs `node --enable-source-maps ./dist/index.mjs`

**Health check**: `GET /health` → `{ status: "ok", uptime, ts }` — configured in `railway.json` as `healthcheckPath`.

**Required Railway env vars**: `PORT` (Railway injects automatically), `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `ENCRYPTION_SECRET`. All others optional.

**Redis**: Upstash must use `rediss://` (double-s for TLS). Plain `redis://` connections are refused by Upstash.

**Webhook on Railway**: Set `WEBHOOK_DOMAIN` to the Railway-assigned domain — bot switches from long-polling to webhook automatically.

**Why:** Multi-stage build keeps the runtime image small; Railway Docker builder handles monorepo workspace protocols correctly.
