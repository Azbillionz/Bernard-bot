/**
 * Wallet rotation — if a user has marked 2+ wallets on the same chain as
 * "tradeable", snipes rotate between them (always picks whichever was used
 * longest ago) instead of always hitting the same single wallet. This
 * spreads buys across wallets automatically.
 *
 * If no wallet is marked tradeable (the common case — most users just use
 * one wallet), this transparently falls back to the old behavior: the
 * single wallet marked isActive for that chain. Nothing changes for users
 * who never touch this feature.
 */

import { db } from "@workspace/db";
import { walletsTable, type Wallet } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

export async function pickTradingWallet(userId: number, chain: string): Promise<Wallet | null> {
  const tradeable = await db.query.walletsTable.findMany({
    where: and(
      eq(walletsTable.userId, userId),
      eq(walletsTable.chain, chain),
      eq(walletsTable.isTradeable, true)
    ),
    orderBy: [asc(walletsTable.lastUsedAt)],
  });

  if (tradeable.length > 0) return tradeable[0]!;

  // Fallback: no rotation configured — behave exactly like before.
  const active = await db.query.walletsTable.findFirst({
    where: and(
      eq(walletsTable.userId, userId),
      eq(walletsTable.chain, chain),
      eq(walletsTable.isActive, true)
    ),
  });
  return active ?? null;
}

export async function markWalletUsed(walletId: number): Promise<void> {
  await db.update(walletsTable).set({ lastUsedAt: new Date() }).where(eq(walletsTable.id, walletId));
}
