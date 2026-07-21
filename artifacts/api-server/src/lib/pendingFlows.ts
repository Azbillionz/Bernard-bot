/**
 * Central registry for per-user pending multi-step text flows
 * (wallet import, rename, filter edit, custom buy amount, copy-trade add).
 *
 * Each handler module registers a clearer for its own pending map.
 * The global middleware in bot/index.ts calls clearAllPendingFlows on
 * every button tap and slash command, so a user's next text message is
 * never consumed by a stale, abandoned step — e.g. a forgotten
 * "custom buy amount" prompt accidentally executing a trade.
 */

type Clearer = (telegramId: number) => void;

const clearers: Clearer[] = [];

export function registerPendingClearer(fn: Clearer): void {
  clearers.push(fn);
}

export function clearAllPendingFlows(telegramId: number): void {
  for (const clear of clearers) clear(telegramId);
}
