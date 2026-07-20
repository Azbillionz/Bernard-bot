---
name: Auto-Snipe Architecture
description: How the PumpFun listener triggers automatic buys
---

**Flow**: PumpFun WS `create` event → token data waterfall (DexScreener→Gecko→PumpFun) → alert user → if `autoSnipe=true` → apply filters → `triggerAutoSnipeBuy()`

**Shared core**: `executeSolBuy(params)` in `trade.ts` — used by both manual `executeBuy` (ctx-based) and `triggerAutoSnipeBuy` (no ctx). Keeps logic in one place.

**Bot messaging without ctx**: `triggerAutoSnipeBuy` uses `getBotRef()` from `lib/botRef.ts` to get the singleton Telegraf instance, then calls `bot.telegram.sendMessage(telegramId, ...)`.

**Filters applied** (in order):
1. `minLiquidityUsd` — skip if liquidityUsd < threshold (parsed from text column)
2. `honeypotCheck` — GoPlus `checkSolanaToken`; skip if blacklisted or mint authority active

**Schema field**: `autoBuyAmountNative` (text, default "0.1") — NOT `autoBuyAmountSol`. Parse with `parseFloat()`.

**In-memory state**: `activeListeners` Map resets on server restart — users must re-toggle the listener.

**Why:** The original implementation toggled a flag but never fired trades. The fix wires the PumpFun handler directly into the execution core.
