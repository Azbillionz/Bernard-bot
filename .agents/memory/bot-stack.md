---
name: Bot Stack Decisions
description: Key architectural choices for the QUANTREXTRADING_BOT — ORM, transport, queue, build
---

- **ORM**: Drizzle (not Prisma — consistent with existing monorepo)
- **Bot transport**: Long-polling in dev; switches to webhook when `WEBHOOK_DOMAIN` env is set
- **Redis/BullMQ**: Optional — graceful direct-send fallback when unavailable
- **esbuild externals**: `@solana/web3.js`, `ioredis`, `bullmq`, `ws`, `telegraf`, `ethers`, `bs58`, `tweetnacl` — all must stay in the `external` array in `build.mjs` or bundling breaks
- **lib declarations**: Run `pnpm run typecheck:libs` after any schema change in `lib/db/src/schema/` before typechecking api-server
- **Redis URL parsing**: `extractRedisUrl()` in `index.ts` strips redis-cli command prefix; Upstash requires `rediss://` (TLS)

**Why:** Native Node modules and large transitive deps (solana, ethers) cause esbuild bundle failures when not externalized.
