---
name: Schema Field Names & Types
description: Non-obvious Drizzle schema field names and types that cause type errors
---

**sniperConfigs table** (`lib/db/src/schema/sniperConfigs.ts`):
- `autoBuyAmountNative` (text, default "0.1") — NOT `autoBuyAmountSol`
- `minLiquidityUsd` (text, default "5000") — string, must use `parseFloat()`
- `maxTaxPercent` (integer)
- `honeypotCheck` (boolean, default true)
- `slippageBps` (integer, default 1000)
- `jitoTipLamports` (integer, default 10000)

**chainPrice service**: `getNativeTokenPrice()` returns `string | number` — always wrap with `Number()` before arithmetic.

**Why:** These caused 8 type errors when implementing auto-snipe; documenting to avoid repeat.
