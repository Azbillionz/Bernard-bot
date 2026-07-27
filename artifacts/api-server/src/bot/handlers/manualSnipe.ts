/**
 * Manual Snipe — the user-driven counterpart to Auto-Snipe. Instead of
 * the bot buying automatically off the PumpFun listener, the user pastes
 * a CA for whatever chain they currently have active, the bot checks it
 * against their configured filters (same sniperConfigsTable used by
 * Auto-Snipe: liquidity, market cap range, age range, buy ratio, tax),
 * and shows a pass/fail summary followed by the full analysis card
 * (which already has Buy/Sell/Track PnL/Chart/RugCheck buttons).
 *
 * "Notifications about the snipe" and "refresh to see progress" are the
 * existing Buy Confirmed message + the 📊 Track PnL button — no separate
 * mechanism needed since those already work for any buy, manual or auto.
 */

import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, sniperConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getPairsByToken } from "../../services/dexscreener";
import { searchGeckoToken } from "../../services/geckoTerminal";
import { getPumpFunToken } from "../../services/pumpfunApi";
import { getNativeTokenPrice } from "../../services/chainPrice";
import { handleCAAnalysis, detectCAType } from "./caAnalysis";
import { registerPendingClearer } from "../../lib/pendingFlows";

const pendingManualSnipe = new Set<number>();
registerPendingClearer((id) => pendingManualSnipe.delete(id));

export function isPendingManualSnipe(telegramId: number): boolean {
  return pendingManualSnipe.has(telegramId);
}

export async function handleManualSnipePrompt(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
  if (!user) { await ctx.reply("❌ Send /start first."); return; }

  pendingManualSnipe.add(telegramId);
  await ctx.reply(
    [
      `🎯 <b>Manual Snipe</b> — active chain: <b>${user.activeChain}</b>`,
      ``,
      `Paste the contract address of a token on <b>${user.activeChain}</b>.`,
      `I'll check it against your ⚗️ Snipe Filters, then show the full`,
      `analysis so you can RugCheck, review, and buy if it looks good.`,
      ``,
      `Trading a different chain? Switch it first in 💼 Wallet Manager.`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
}

const DEX_CHAIN_ID: Record<string, string> = {
  SOL: "solana",
  ETH: "ethereum",
  BASE: "base",
  BSC: "bsc",
};

interface QuickMetrics {
  found: boolean;
  liquidityUsd: number;
  marketCapUsd: number;
  ageMinutes?: number;
  buyRatioPercent?: number;
}

async function fetchQuickMetrics(ca: string, chain: string): Promise<QuickMetrics> {
  const pairs = await getPairsByToken(ca);
  const wantedChainId = DEX_CHAIN_ID[chain];
  const pair = pairs.find((p) => p.chainId === wantedChainId) ?? pairs[0];

  if (pair) {
    const buys = pair.txns?.h24?.buys ?? 0;
    const sells = pair.txns?.h24?.sells ?? 0;
    return {
      found: true,
      liquidityUsd: pair.liquidity?.usd ?? 0,
      marketCapUsd: pair.marketCap ?? pair.fdv ?? 0,
      ageMinutes: pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60_000 : undefined,
      buyRatioPercent: buys + sells > 0 ? (buys / (buys + sells)) * 100 : undefined,
    };
  }

  const geckoPool = await searchGeckoToken(ca, chain);
  if (geckoPool) {
    const buys = geckoPool.buys24h ?? 0;
    const sells = geckoPool.sells24h ?? 0;
    return {
      found: true,
      liquidityUsd: geckoPool.liquidityUsd ?? 0,
      marketCapUsd: geckoPool.marketCapUsd ?? geckoPool.fdvUsd ?? 0,
      ageMinutes: geckoPool.poolCreatedAt ? (Date.now() - geckoPool.poolCreatedAt) / 60_000 : undefined,
      buyRatioPercent: buys + sells > 0 ? (buys / (buys + sells)) * 100 : undefined,
    };
  }

  if (chain === "SOL") {
    const pumpToken = await getPumpFunToken(ca);
    if (pumpToken) {
      const solPrice = Number(await getNativeTokenPrice("SOL").catch(() => 0));
      const priceUsd = pumpToken.priceNative * solPrice;
      return {
        found: true,
        liquidityUsd: (pumpToken.virtualSolReserves / 1e9) * solPrice * 2,
        marketCapUsd: priceUsd * pumpToken.totalSupply,
      };
    }
  }

  return { found: false, liquidityUsd: 0, marketCapUsd: 0 };
}

export async function processManualSnipeCA(ctx: Context, ca: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  pendingManualSnipe.delete(telegramId);

  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
  if (!user) return;

  const caType = detectCAType(ca);
  if (!caType) {
    await ctx.reply("❌ That doesn't look like a valid contract address. Try again, or tap 🎯 Manual Snipe to restart.");
    return;
  }

  const isEvmCa = caType === "EVM";
  if (isEvmCa && user.activeChain === "SOL") {
    await ctx.reply(
      `⚠️ That's an EVM address, but your active chain is <b>SOL</b>. Switch chains in 💼 Wallet Manager, or paste a Solana token instead.`,
      { parse_mode: "HTML" }
    );
    return;
  }
  if (!isEvmCa && user.activeChain !== "SOL") {
    await ctx.reply(
      `⚠️ That's a Solana address, but your active chain is <b>${user.activeChain}</b>. Switch chains in 💼 Wallet Manager, or paste a token on ${user.activeChain} instead.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const config = await db.query.sniperConfigsTable.findFirst({ where: eq(sniperConfigsTable.userId, user.id) });
  const metrics = await fetchQuickMetrics(ca, user.activeChain);

  if (!metrics.found) {
    await ctx.reply(
      "❓ Couldn't find market data for this token yet — it may be too new. Try again in a moment, or paste it again to run a full on-chain analysis.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const checks: { label: string; pass: boolean }[] = [];
  const minLiq = parseFloat(config?.minLiquidityUsd ?? "0");
  if (minLiq > 0) checks.push({ label: `Liquidity ≥ $${minLiq}`, pass: metrics.liquidityUsd >= minLiq });

  const minMc = parseFloat(config?.minMarketCapUsd ?? "0");
  if (minMc > 0) checks.push({ label: `MCap ≥ $${minMc}`, pass: metrics.marketCapUsd >= minMc });

  const maxMc = parseFloat(config?.maxMarketCapUsd ?? "0");
  if (maxMc > 0) checks.push({ label: `MCap ≤ $${maxMc}`, pass: metrics.marketCapUsd <= maxMc });

  const minAge = config?.minAgeMinutes ?? 0;
  if (minAge > 0 && metrics.ageMinutes !== undefined) {
    checks.push({ label: `Age ≥ ${minAge}m`, pass: metrics.ageMinutes >= minAge });
  }

  const maxAge = config?.maxAgeMinutes ?? 0;
  if (maxAge > 0 && metrics.ageMinutes !== undefined) {
    checks.push({ label: `Age ≤ ${maxAge}m`, pass: metrics.ageMinutes <= maxAge });
  }

  const minBuyRatio = config?.minBuyRatioPercent ?? 0;
  if (minBuyRatio > 0 && metrics.buyRatioPercent !== undefined) {
    checks.push({ label: `Buy ratio ≥ ${minBuyRatio}%`, pass: metrics.buyRatioPercent >= minBuyRatio });
  }

  const allPass = checks.every((c) => c.pass);
  const verdictLines = checks.length
    ? checks.map((c) => `  ${c.pass ? "✅" : "❌"} ${c.label}`)
    : [`  ℹ️ No filters configured in ⚗️ Snipe Filters — nothing to check.`];

  await ctx.reply(
    [
      `🎯 <b>Manual Snipe Check</b>`,
      `📍 CA: <code>${ca}</code>`,
      `—`,
      allPass ? `✅ <b>Passes your filters</b>` : `⚠️ <b>Does not meet your filters</b>`,
      ...verdictLines,
      `—`,
      `Full analysis below 👇`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );

  await handleCAAnalysis(ctx, ca);
}
