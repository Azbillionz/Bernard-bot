# QUANTREXTRADING_BOT

Enterprise-grade multi-chain Telegram trading and sniping bot. Handles token analysis, non-custodial wallet management, auto-sniping, copy-trading, and live swaps across SOL, ETH, BASE, and BSC — all inside Telegram.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — start the API + bot server (port auto-assigned)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run typecheck:libs` — rebuild lib declarations (run after schema changes)
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes to PostgreSQL (requires DATABASE_URL)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Bot: Telegraf v4 (webhook + polling modes)
- API: Express 5
- DB: PostgreSQL + Drizzle ORM (tables: bot_users, bot_wallets, bot_trades, bot_sniper_configs, bot_signals, bot_copy_trades)
- Queue: BullMQ + ioredis (≤30 Telegram messages/sec)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/bot/` — Telegraf bot, dashboard, all 14 handlers
- `artifacts/api-server/src/services/` — DexScreener, GoPlus, Jupiter V6, 1inch, Jito, Flashbots, chainPrice, wsManager
- `artifacts/api-server/src/workers/messageQueue.ts` — BullMQ rate limiter
- `artifacts/api-server/src/lib/encryption.ts` — AES-256-GCM wallet key encryption
- `lib/db/src/schema/` — Drizzle schema: users, wallets, trades, sniperConfigs, signals, copyTrades
- `artifacts/api-server/.env.example` — all required environment variable keys

## Architecture decisions

- Drizzle ORM used instead of Prisma (existing stack) — functionally equivalent, avoids dual-ORM setup
- All wallet private keys encrypted with AES-256-GCM before storage; decrypted only at execution time
- Solana swaps: Jupiter V6 API → simulateTransaction → Jito bundle (100 bps platform fee via platformFeeBps)
- EVM swaps: 1inch v6 API (1% integrator fee) → eth_call simulation → Flashbots private RPC
- Bot uses webhook mode when WEBHOOK_DOMAIN is set; falls back to long-polling for dev
- BullMQ is optional — if REDIS_URL is absent, messages send directly (no queue)
- WsManager uses exponential backoff (1s → 30s max) with 30s ping keepalive

## Product

The bot runs entirely inside Telegram. Users:
1. Start with `/start` → live dashboard (chain, wallet, balance, price, trade count)
2. Send any CA to get DexScreener stats + GoPlus security + inline buy/sell buttons
3. Use 14-button menu: New Runners, Trending, PumpFun Snipe, Signals, Wallet Manager, Copy-Trade, Group Scanner, PnL Center, My Trades, Auto-Snipe toggle, Settings, Filters, Bot Stats, Help

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Required Secrets (add via Replit Secrets panel)

| Key | Purpose |
|-----|---------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `ENCRYPTION_SECRET` | 32+ char string for AES-256-GCM |
| `REDIS_URL` | BullMQ queue (optional but recommended) |
| `SOLANA_RPC_URL` | Solana HTTP RPC |
| `SOLANA_WSS_URL` | PumpFun WebSocket feed |
| `JITO_BLOCK_ENGINE_URL` | Jito MEV protection |
| `DEFAULT_SOL_JITO_TIP` | Lamports tip (e.g. 10000) |
| `ETH_RPC_URL` | Ethereum RPC |
| `FLASHBOTS_RPC_URL` | Flashbots private RPC |
| `BASE_RPC_URL` | Base chain RPC |
| `BSC_RPC_URL` | BSC RPC |
| `ONEINCH_API_KEY` | 1inch Developer API key |
| `DEV_FEE_WALLET` | Fee recipient address (1% on every swap) |
| `WEBHOOK_DOMAIN` | Production domain for webhook mode |

## Gotchas

- Run `pnpm run typecheck:libs` then restart after any schema change in `lib/db/src/schema/`
- Run `pnpm --filter @workspace/db run push` to create/migrate tables in the live DB
- TELEGRAM_BOT_TOKEN must be set before bot initializes — server still starts without it (webhook endpoints live at /api/webhook)
- `@solana/web3.js`, `ethers`, `ioredis`, `bullmq`, `telegraf`, `ws`, `bs58`, `tweetnacl` are all externalized from esbuild bundle — they load at runtime from node_modules
