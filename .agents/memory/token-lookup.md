---
name: Token Lookup Waterfall
description: How CA analysis resolves token data across multiple sources
---

**Waterfall order** (caAnalysis.ts):
1. DexScreener `/latest/dex/tokens/{ca}` — primary
2. GeckoTerminal `/networks/{network}/tokens/{ca}/pools` → fallback to `/search/pools?query={ca}` — secondary
3. PumpFun REST `https://frontend-api.pump.fun/coins/{ca}` — SOL only, pre-graduation tokens

**Solana address regex**: `^[1-9A-HJ-NP-Za-km-z]{32,44}$` — 32–44 chars (not 43-44) to match PumpFun mints which can be shorter.

**Trending/runners fallback**: DexScreener boost endpoints → GeckoTerminal `trending_pools` / `new_pools` if boost returns empty.

**DexScreener retry**: `fetchWithRetry` does 2 attempts with 1s delay; boost tokens resolved in parallel (8 candidates, take first 5).

**Why:** Many new tokens (especially PumpFun launches) aren't on DexScreener for minutes/hours after creation.
