/**
 * Group Scanner — monitors group chats for contract addresses.
 *
 * HOW IT WORKS:
 * 1. User enables scanner here (in private chat with bot).
 * 2. User adds the bot to their Telegram group (make it an admin or allow message reading).
 * 3. Bot sees messages in that group and extracts any EVM/SOL contract addresses.
 * 4. Detected CAs are analyzed via DexScreener and sent to the USER's private chat.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, signalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getPairsByToken } from "../../services/dexscreener";
import { searchGeckoToken } from "../../services/geckoTerminal";
import { getBotRef } from "../../lib/botRef";
import { logger } from "../../lib/logger";
import { safeReply } from "../../lib/ctxHelper";

export async function handleGroupScanner(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  const newState = !user.scannerActive;
  await db
    .update(usersTable)
    .set({ scannerActive: newState, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));

  const text = newState
    ? [
        `📡 <b>Group Scanner — Active 🟢</b>`,
        `—`,
        `The bot will now detect <b>contract addresses</b> shared in any group`,
        `where it's a member and notify you here in private.`,
        ``,
        `<b>Setup (one-time):</b>`,
        `1️⃣ Add <b>@${ctx.botInfo?.username ?? "this bot"}</b> to your Telegram group`,
        `2️⃣ Grant it permission to read messages (make it an admin if needed)`,
        `3️⃣ When anyone in the group shares an EVM or Solana CA, you'll get`,
        `   an instant analysis + buy/sell buttons here in private chat`,
        ``,
        `🔍 Detecting: EVM <code>0x...</code> and Solana base58 addresses`,
      ].join("\n")
    : [
        `📡 <b>Group Scanner — Stopped 🔴</b>`,
        `—`,
        `Contract address scanning has been disabled.`,
        `Re-enable it to resume group monitoring.`,
      ].join("\n");

  await safeReply(ctx, text, {
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

/** Parse message text for EVM or Solana contract addresses */
export function extractCAs(text: string): { address: string; type: "EVM" | "SOL" }[] {
  const results: { address: string; type: "EVM" | "SOL" }[] = [];
  const evmRe = /\b(0x[a-fA-F0-9]{40})\b/g;
  const solRe = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;

  let m: RegExpExecArray | null;
  while ((m = evmRe.exec(text)) !== null) results.push({ address: m[1]!, type: "EVM" });
  while ((m = solRe.exec(text)) !== null) results.push({ address: m[1]!, type: "SOL" });

  return results;
}

/**
 * Called by the main bot text handler when a group message is received.
 * Sends analysis results to the user's PRIVATE chat (not the group).
 */
export async function scanGroupMessage(
  text: string,
  userId: number,
  telegramId: number,
  chain: string
): Promise<void> {
  const cas = extractCAs(text);
  if (cas.length === 0) return;

  const bot = getBotRef();
  if (!bot) return;

  for (const { address, type } of cas) {
    try {
      // Try DexScreener first, then GeckoTerminal
      const pairs = await getPairsByToken(address).catch(() => []);
      const pair = pairs[0];

      let tokenName = "Unknown";
      let tokenSymbol = "?";
      let priceUsd = "0";
      let liqUsd = 0;
      let msgText = "";

      if (pair) {
        tokenName = pair.baseToken.name;
        tokenSymbol = pair.baseToken.symbol;
        priceUsd = pair.priceUsd ?? "0";
        liqUsd = pair.liquidity?.usd ?? 0;
        msgText = [
          `📡 <b>CA Detected in Group</b>`,
          `🪙 <b>${tokenName}</b> (<code>${tokenSymbol}</code>)`,
          `📍 <code>${address}</code>`,
          `💲 $${Number(priceUsd).toFixed(8)}`,
          `💧 Liquidity: $${(liqUsd / 1_000).toFixed(1)}K`,
          `📊 24h Vol: $${((pair.volume?.h24 ?? 0) / 1_000).toFixed(1)}K`,
        ].join("\n");
      } else {
        // GeckoTerminal fallback
        const gecko = await searchGeckoToken(address, type === "SOL" ? "SOL" : chain).catch(() => null);
        if (gecko) {
          tokenName = gecko.baseTokenName;
          tokenSymbol = gecko.baseTokenSymbol;
          priceUsd = gecko.priceUsd;
          liqUsd = gecko.liquidityUsd;
          msgText = [
            `📡 <b>CA Detected in Group</b> (GeckoTerminal)`,
            `🪙 <b>${tokenName}</b> (<code>${tokenSymbol}</code>)`,
            `📍 <code>${address}</code>`,
            `💲 $${Number(priceUsd).toFixed(8)}`,
            `💧 Liquidity: $${(liqUsd / 1_000).toFixed(1)}K`,
          ].join("\n");
        } else {
          // Not found on major sources — still log and alert
          msgText = [
            `📡 <b>CA Detected in Group</b>`,
            `📍 <code>${address}</code>`,
            `⚠️ Not yet indexed on DexScreener or GeckoTerminal.`,
            `It may be brand new — use Analyze to check again.`,
          ].join("\n");
          tokenSymbol = address.slice(0, 8);
        }
      }

      // Save signal
      await db.insert(signalsTable).values({
        userId,
        tokenAddress: address,
        tokenSymbol,
        chain: type === "SOL" ? "SOL" : chain,
        source: "GROUP_SCAN",
        priceUsd,
      }).catch(() => undefined);

      // Send to user's PRIVATE chat with analyze + buy buttons
      await bot.telegram.sendMessage(telegramId, msgText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("📊 Analyze & Trade", `analyze:${address}`)],
        ]).reply_markup,
      });
    } catch (err) {
      logger.error({ err, address }, "Group scanner CA analysis failed");
    }
  }
}
