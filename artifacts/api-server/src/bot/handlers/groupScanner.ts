import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, signalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getPairsByToken } from "../../services/dexscreener";
import { queueMessage } from "../../workers/messageQueue";
import { logger } from "../../lib/logger";

export async function handleGroupScanner(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const newState = !user.scannerActive;
  await db
    .update(usersTable)
    .set({ scannerActive: newState, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));

  const statusText = newState
    ? "🟢 <b>Group Scanner Active</b>\n\nThe bot will now monitor all group messages for contract addresses (EVM <code>0x...</code> or Solana base58) and automatically analyze them."
    : "🔴 <b>Group Scanner Stopped</b>\n\nContract address scanning has been disabled.";

  await ctx.editMessageText(statusText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          newState ? "⏹ Stop Scanner" : "▶️ Start Scanner",
          "group_scanner"
        ),
      ],
      [Markup.button.callback("⬅️ Dashboard", "dashboard")],
    ]),
  });
}

/**
 * Parse any message text for EVM or Solana contract addresses.
 */
export function extractCAs(text: string): {
  address: string;
  type: "EVM" | "SOL";
}[] {
  const results: { address: string; type: "EVM" | "SOL" }[] = [];
  const evmRe = /\b(0x[a-fA-F0-9]{40})\b/g;
  const solRe = /\b([1-9A-HJ-NP-Za-km-z]{43,44})\b/g;

  let m: RegExpExecArray | null;
  while ((m = evmRe.exec(text)) !== null) {
    results.push({ address: m[1]!, type: "EVM" });
  }
  while ((m = solRe.exec(text)) !== null) {
    results.push({ address: m[1]!, type: "SOL" });
  }
  return results;
}

export async function scanGroupMessage(
  text: string,
  userId: number,
  chatId: number | string,
  chain: string
): Promise<void> {
  const cas = extractCAs(text);
  for (const { address, type } of cas) {
    try {
      const pairs = await getPairsByToken(address);
      const pair = pairs[0];
      if (!pair) continue;

      const priceUsd = pair.priceUsd ?? "0";
      await db.insert(signalsTable).values({
        userId,
        tokenAddress: address,
        tokenSymbol: pair.baseToken.symbol,
        chain: type === "SOL" ? "SOL" : chain,
        source: "GROUP_SCAN",
        priceUsd,
      });

      await queueMessage(
        chatId,
        `📡 <b>CA Detected in Group</b>\n🪙 ${pair.baseToken.name} (<code>${pair.baseToken.symbol}</code>)\n📍 <code>${address}</code>\n💲 $${Number(priceUsd).toFixed(8)}`,
        "HTML"
      );
    } catch (err) {
      logger.error({ err, address }, "Group scanner CA analysis failed");
    }
  }
}
