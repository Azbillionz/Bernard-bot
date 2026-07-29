/**
 * Pending Snipe queue — for tokens that passed all filters but couldn't be
 * bought because the wallet balance was too low at the time. Checks every
 * minute; the moment a queued token's wallet has enough balance, it fires
 * the buy automatically (via the same ctx-less path Auto-Snipe uses) and
 * notifies the user. Entries expire after 1 hour unfulfilled.
 */

import { db } from "@workspace/db";
import { pendingSnipesTable, walletsTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import { getChainBalance } from "./chainPrice";
import { triggerAutoSnipeBuy } from "../bot/handlers/trade";
import { logger } from "../lib/logger";
import { queueMessage } from "../workers/messageQueue";

const CHECK_INTERVAL_MS = 60 * 1000; // check every minute
const QUEUE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface QueueSnipeParams {
  dbUserId: number;
  telegramId: number;
  chain: string;
  ca: string;
  tokenSymbol: string;
  tokenName: string;
  priceUsd: string;
  liquidityUsd: number;
  buyAmountNative: string;
}

export async function queuePendingAutoSnipe(params: QueueSnipeParams): Promise<void> {
  await db.insert(pendingSnipesTable).values({
    userId: params.dbUserId,
    telegramId: params.telegramId,
    chain: params.chain,
    tokenAddress: params.ca,
    tokenSymbol: params.tokenSymbol,
    tokenName: params.tokenName,
    priceUsd: params.priceUsd,
    liquidityUsd: String(params.liquidityUsd),
    buyAmountNative: params.buyAmountNative,
    expiresAt: new Date(Date.now() + QUEUE_TTL_MS),
  });
}

async function checkOne(row: typeof pendingSnipesTable.$inferSelect): Promise<void> {
  try {
    const wallet = await db.query.walletsTable.findFirst({
      where: and(
        eq(walletsTable.userId, row.userId),
        eq(walletsTable.chain, row.chain),
        eq(walletsTable.isActive, true)
      ),
    });
    if (!wallet) return; // wallet removed since queuing — leave it, will expire naturally

    const balance = parseFloat(await getChainBalance(row.chain, wallet.address).catch(() => "0"));
    const needed = parseFloat(row.buyAmountNative);
    if (balance < needed) return; // still not funded

    // Mark fulfilled first to avoid a double-fire if the checker overlaps
    await db.update(pendingSnipesTable).set({ fulfilled: true }).where(eq(pendingSnipesTable.id, row.id));

    await queueMessage(
      row.telegramId,
      `💰 <b>Wallet funded!</b> Executing your queued snipe on <b>${row.tokenSymbol}</b> now…`,
      "HTML"
    );

    if (row.chain === "SOL") {
      await triggerAutoSnipeBuy({
        dbUserId: row.userId,
        telegramId: row.telegramId,
        ca: row.tokenAddress,
        tokenSymbol: row.tokenSymbol,
        tokenName: row.tokenName,
        priceUsd: row.priceUsd,
        liquidityUsd: parseFloat(row.liquidityUsd),
      });
    } else {
      // EVM chains: triggerAutoSnipeBuy is SOL-only today (Jupiter/Jito path).
      // Fall back to notifying the user to buy manually via the bot.
      await queueMessage(
        row.telegramId,
        `🎯 <b>${row.tokenSymbol}</b> is now affordable — tap below to buy.`,
        "HTML",
        [[{ text: "💰 Buy Now", callback_data: `buy:${row.tokenAddress}:${row.buyAmountNative}` }]]
      );
    }
  } catch (err) {
    logger.warn({ err, pendingSnipeId: row.id }, "Pending snipe check failed");
  }
}

export function startPendingSnipeQueue(): void {
  setInterval(async () => {
    try {
      const now = new Date();
      const due = await db.query.pendingSnipesTable.findMany({
        where: and(eq(pendingSnipesTable.fulfilled, false), lt(pendingSnipesTable.expiresAt, now)),
      });
      // Expired entries — just mark them so they stop being checked
      for (const row of due) {
        await db.update(pendingSnipesTable).set({ fulfilled: true }).where(eq(pendingSnipesTable.id, row.id));
      }

      const active = await db.query.pendingSnipesTable.findMany({
        where: eq(pendingSnipesTable.fulfilled, false),
      });
      for (const row of active) {
        await checkOne(row);
      }
    } catch (err) {
      logger.warn({ err }, "Pending snipe queue tick failed");
    }
  }, CHECK_INTERVAL_MS);

  logger.info("Pending snipe queue started (checks every 60s)");
}
