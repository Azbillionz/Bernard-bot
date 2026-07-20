/**
 * CA Analysis — triggered by text input or inline "analyze:" callback.
 * Waterfall: DexScreener → GeckoTerminal → PumpFun (SOL only)
 * Detects EVM (0x + 40 hex) or Solana (43–44 char base58) addresses.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getPairsByToken, formatPairMessage } from "../../services/dexscreener";
import { searchGeckoToken, formatGeckoPool } from "../../services/geckoTerminal";
import { getPumpFunToken, formatPumpFunMessage } from "../../services/pumpfunApi";
import { getNativeTokenPrice } from "../../services/chainPrice";
import { checkEvmToken, checkSolanaToken } from "../../services/goplus";
import { db } from "@workspace/db";
import { usersTable, signalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
// Base58 Solana: 32-44 chars to catch PumpFun mints too
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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

  await ctx.reply(`🔍 Analyzing <code>${ca}</code>…`, { parse_mode: "HTML" });

  const [user] = await Promise.all([
    db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) }),
  ]);
  const chain = user?.activeChain ?? "SOL";

  // ── Parallel: DexScreener + GoPlus ───────────────────────────────────────
  const [pairs, security] = await Promise.all([
    getPairsByToken(ca),
    caType === "EVM" ? checkEvmToken(chain, ca) : checkSolanaToken(ca),
  ]);

  const pair = pairs[0];
  const tradeButtons = [
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
  ];

  // ── Security block ────────────────────────────────────────────────────────
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

  // ── 1. DexScreener hit ───────────────────────────────────────────────────
  if (pair) {
    const pairText = formatPairMessage(pair);
    const fullText = [pairText, "—", ...securityLines].join("\n");

    if (user) {
      void db.insert(signalsTable).values({
        userId: user.id,
        tokenAddress: ca,
        tokenSymbol: pair.baseToken.symbol,
        chain: caType === "SOL" ? "SOL" : chain,
        source: "MANUAL",
        priceUsd: pair.priceUsd ?? "0",
      });
    }

    await ctx.reply(fullText, { parse_mode: "HTML", ...Markup.inlineKeyboard(tradeButtons) });
    return;
  }

  // ── 2. GeckoTerminal fallback ────────────────────────────────────────────
  const geckoPool = await searchGeckoToken(ca, chain);
  if (geckoPool) {
    const poolText = formatGeckoPool(geckoPool);
    const fullText = [
      `<i>📡 Source: GeckoTerminal (not on DexScreener yet)</i>`,
      poolText,
      "—",
      ...securityLines,
    ].join("\n");

    if (user) {
      void db.insert(signalsTable).values({
        userId: user.id,
        tokenAddress: ca,
        tokenSymbol: geckoPool.baseTokenSymbol,
        chain: caType === "SOL" ? "SOL" : chain,
        source: "MANUAL",
        priceUsd: geckoPool.priceUsd,
      });
    }

    await ctx.reply(fullText, { parse_mode: "HTML", ...Markup.inlineKeyboard(tradeButtons) });
    return;
  }

  // ── 3. PumpFun fallback (SOL only) ───────────────────────────────────────
  if (caType === "SOL") {
    const pumpToken = await getPumpFunToken(ca);
    if (pumpToken) {
      const solPrice = Number(await getNativeTokenPrice("SOL").catch(() => 0));
      const pumpText = formatPumpFunMessage(pumpToken, solPrice);
      const fullText = [
        `<i>🚀 Source: PumpFun (pre-graduation)</i>`,
        pumpText,
        "—",
        ...securityLines,
      ].join("\n");

      if (user) {
        const priceUsd = (pumpToken.priceNative * solPrice).toFixed(10);
        void db.insert(signalsTable).values({
          userId: user.id,
          tokenAddress: ca,
          tokenSymbol: pumpToken.symbol,
          chain: "SOL",
          source: "PUMPFUN",
          priceUsd,
        });
      }

      await ctx.reply(fullText, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard(tradeButtons),
      });
      return;
    }
  }

  // ── 4. Not found anywhere ────────────────────────────────────────────────
  await ctx.reply(
    [
      `❓ <b>Token not found</b>`,
      `CA: <code>${ca}</code>`,
      ``,
      `Checked: DexScreener, GeckoTerminal${caType === "SOL" ? ", PumpFun" : ""}.`,
      `The token may be brand new or not yet indexed — try again in a few seconds.`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]]),
    }
  );
}

/** Also handles the inline "analyze:CA" callback button */
export async function handleAnalyzeCallback(ctx: Context, ca: string): Promise<void> {
  await ctx.answerCbQuery("🔍 Analyzing…");
  await handleCAAnalysis(ctx, ca);
}
