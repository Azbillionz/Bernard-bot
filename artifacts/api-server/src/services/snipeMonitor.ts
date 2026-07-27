/**
 * Manual Snipe monitor — a lightweight in-process scheduler (checks every
 * minute) that sends a price/P&L update for each active manual-snipe
 * position roughly every 20 minutes, until the user stops tracking it or
 * sells 100% (which the trade handler marks inactive).
 */

import { db } from "@workspace/db";
import { activeSnipesTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import { getBotRef } from "../lib/botRef";
import { getPairsByToken } from "./dexscreener";
import { logger } from "../lib/logger";

const NOTIFY_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const CHECK_INTERVAL_MS = 60 * 1000; // check every minute for anything due

function fmtPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "0";
  return p >= 1 ? p.toFixed(4) : p.toFixed(8);
}

async function notifyOne(snipe: typeof activeSnipesTable.$inferSelect): Promise<void> {
  const bot = getBotRef();
  if (!bot) return;

  try {
    const pairs = await getPairsByToken(snipe.tokenAddress);
    const pair = pairs[0];
    const current = parseFloat(pair?.priceUsd ?? "0");
    const entry = parseFloat(snipe.entryPriceUsd);
    const pct = entry > 0 && current > 0 ? ((current - entry) / entry) * 100 : null;

    const lines = [
      `🎯 <b>Manual Snipe Update</b> — ${snipe.tokenSymbol}`,
      `📍 CA: <code>${snipe.tokenAddress}</code>`,
      `—`,
      `💲 Current: $${fmtPrice(current)}`,
      pct !== null
        ? `${pct >= 0 ? "🟢" : "🔴"} P&L: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% from entry`
        : `ℹ️ No live price data right now.`,
      `—`,
      `🕐 ${new Date().toISOString().slice(11, 19)} UTC`,
    ];

    await bot.telegram
      .sendMessage(snipe.telegramId, lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: `price:${snipe.tokenAddress}` }],
            [
              { text: "📤 Sell 50%", callback_data: `sell:${snipe.tokenAddress}:50` },
              { text: "📤 Sell 100%", callback_data: `sell:${snipe.tokenAddress}:100` },
            ],
            [{ text: "⏹ Stop Tracking", callback_data: `stop_snipe:${snipe.id}` }],
          ],
        },
      })
      .catch(() => undefined);

    await db
      .update(activeSnipesTable)
      .set({ lastNotifiedAt: new Date() })
      .where(eq(activeSnipesTable.id, snipe.id));
  } catch (err) {
    logger.warn({ err, snipeId: snipe.id }, "Manual snipe notify failed");
  }
}

export function startSnipeMonitor(): void {
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - NOTIFY_INTERVAL_MS);
      const due = await db.query.activeSnipesTable.findMany({
        where: and(eq(activeSnipesTable.active, true), lt(activeSnipesTable.lastNotifiedAt, cutoff)),
      });
      for (const snipe of due) {
        await notifyOne(snipe);
      }
    } catch (err) {
      logger.warn({ err }, "Snipe monitor tick failed");
    }
  }, CHECK_INTERVAL_MS);

  logger.info("Manual snipe monitor started (20-min update interval)");
}

/** Mark a tracked position inactive — called by the "⏹ Stop Tracking" button. */
export async function stopSnipeTracking(snipeId: number): Promise<void> {
  await db.update(activeSnipesTable).set({ active: false }).where(eq(activeSnipesTable.id, snipeId));
}
