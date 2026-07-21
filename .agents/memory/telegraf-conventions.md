---
name: Telegraf bot conventions
description: Rules every new button/flow in the Telegram bot must follow (callback answering, pending text flows, callback_data size)
---

# Telegraf conventions in this bot

1. **Never call `ctx.answerCbQuery()` in handlers.** A global middleware in `bot/index.ts` answers every callback query. A second answer throws (query already answered) and can abort the handler mid-flight, surfacing as "internal error" to the user.
   **Why:** past incident — slash commands and Analyze buttons crashed intermittently from double-answering.
   **How to apply:** any new `bot.action(...)` handler just does its work; no answering.

2. **Every multi-step text flow must register with `lib/pendingFlows.ts`.** Declare your pending map, then `registerPendingClearer((id) => myMap.delete(id))`. The global middleware clears ALL pending flows on every button tap and slash command, then the flow-starting handler sets fresh state (middleware runs first, so this is safe).
   **Why:** stale abandoned prompts (e.g. custom-buy amount) were eating the user's next message — worst case executing an unintended trade.
   **How to apply:** new flow = map + clearer registration + a `getPending...` check wired into the text handler chain in `bot/index.ts` (precedence: import > rename > copy-trade > filter > custom-buy > CA detection).

3. **`callback_data` must stay ≤64 bytes.** Solana mints are 43–44 chars, so `buy:MINT:AMT` leaves ~15 chars for the amount. User-configurable numbers embedded in callback data must be clamped and capped at 6 decimals (see the auto-buy amount handling in filters input validation and pumpfun alert buttons).
   **Why:** oversized callback_data makes Telegram reject the whole message send.

4. **User-supplied strings rendered in HTML parse mode must be escaped** (wallet labels, copy-trade labels, addresses) — each handler file keeps a local `escapeHtml`.

5. **Handlers reachable from both commands and buttons must use `safeReply`** (`lib/ctxHelper`) — `ctx.editMessageText` throws when there's no message to edit (command context).
