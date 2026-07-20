/**
 * CA Analysis — triggered by text input.
 * Detects EVM (0x + 40 hex) or Solana (43-44 char base58) addresses,
 * queries DexScreener + GoPlus security, and renders trading controls.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getPairsByToken, formatPairMessage } from "../../services/dexscreener";
import { checkEvmToken, checkSolanaToken } from "../../services/goplus";
import { db } from "@workspace/db";
import { usersTable, signalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export function detectCAType(text: string): "EVM" | "SOL" | null {
  const trimmed = text.trim();
  if (EVM_RE.test(trimmed)) return "EVM";
  if (SOL_RE.test(trimmed)) return "SOL";
  return null;
}

export async function handleCAAnalysis(ctx: Context, ca: string): Promise<void> {
  const caType = detectCAType(ca);
  if (!caType) return;

  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  await ctx.reply(`🔍 Analyzing <code>${ca}</code>...`, { parse_mode: "HTML" });

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  const chain = user?.activeChain ?? "SOL";

  // Fetch pair data and security in parallel
  const [pairs, security] = await Promise.all([
    getPairsByToken(ca),
    caType === "EVM"
      ? checkEvmToken(chain, ca)
      : checkSolanaToken(ca),
  ]);

  const pair = pairs[0];

  if (!pair) {
    await ctx.reply(
      `❌ No pair data found for <code>${ca}</code>.\n\nToken may not be listed on DexScreener yet.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
    return;
  }

  // Format security section
  let securityLines: string[];
  if (caType === "EVM") {
    const s = security as Awaited<ReturnType<typeof checkEvmToken>>;
    securityLines = [
      `🕵️ <b>Security (GoPlus)</b>`,
      `  🍯 Honeypot: <b>${s.isHoneypot ? "⚠️ YES" : "✅ NO"}</b>`,
      `  💸 Buy Tax: <b>${s.buyTax.toFixed(1)}%</b> | Sell Tax: <b>${s.sellTax.toFixed(1)}%</b>`,
      `  🖨 Mintable: <b>${s.isMintable ? "⚠️ YES" : "✅ NO"}</b>`,
      `  🚫 Blacklist: <b>${s.isBlacklisted ? "⚠️ YES" : "✅ NO"}</b>`,
    ];
  } else {
    const s = security as Awaited<ReturnType<typeof checkSolanaToken>>;
    securityLines = [
      `🕵️ <b>Security (GoPlus)</b>`,
      `  🖨 Mint Authority: <b>${s.hasMintAuthority ? "⚠️ ACTIVE" : "✅ REVOKED"}</b>`,
      `  🧊 Freeze Authority: <b>${s.hasFreezeAuthority ? "⚠️ ACTIVE" : "✅ REVOKED"}</b>`,
      `  🚫 Blacklist: <b>${s.isBlacklisted ? "⚠️ YES" : "✅ NO"}</b>`,
    ];
  }

  const pairText = formatPairMessage(pair);
  const fullText = [pairText, `—`, ...securityLines].join("\n");

  // Record as manual signal
  if (user) {
    await db.insert(signalsTable).values({
      userId: user.id,
      tokenAddress: ca,
      tokenSymbol: pair.baseToken.symbol,
      chain: caType === "SOL" ? "SOL" : chain,
      source: "MANUAL",
      priceUsd: pair.priceUsd ?? "0",
    });
  }

  // Trading controls
  await ctx.reply(fullText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("💰 Buy 0.1", `buy:${ca}:0.1`),
        Markup.button.callback("💰 Buy 0.5", `buy:${ca}:0.5`),
        Markup.button.callback("💰 Buy Custom", `buy_custom:${ca}`),
      ],
      [
        Markup.button.callback("📤 Sell 50%", `sell:${ca}:50`),
        Markup.button.callback("📤 Sell 100%", `sell:${ca}:100`),
      ],
      [Markup.button.callback("⬅️ Dashboard", "dashboard")],
    ]),
  });
}

/** Also handles the inline "analyze:CA" callback button */
export async function handleAnalyzeCallback(ctx: Context, ca: string): Promise<void> {
  await ctx.answerCbQuery("🔍 Analyzing...");
  await handleCAAnalysis(ctx, ca);
}
