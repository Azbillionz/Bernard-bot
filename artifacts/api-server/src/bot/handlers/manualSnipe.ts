/**
 * Manual Snipe — user-driven counterpart to Auto-Snipe.
 *
 * Flow: tap 🎯 Manual Snipe → paste CA (must match active chain) → bot runs
 * filter checks + RugCheck and shows a REVIEW-ONLY card (no Buy/Sell buttons
 * — this is a review step, not a trade screen). If it's risky or fails
 * filters, a warning is shown but the user can still tap "🎯 Start Manual
 * Snipe" to proceed anyway. Starting checks the wallet balance: insufficient
 * funds → told to fund the wallet; sufficient → buys immediately via the
 * same executeBuy path as a normal buy, then registers the position for
 * recurring ~20-minute progress notifications (services/snipeMonitor.ts),
 * on top of the existing 🔄 Refresh / 📊 Track PnL button for on-demand checks.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, sniperConfigsTable, tradesTable, activeSnipesTable, walletsTable } from "@workspace/db";
import { eq, and, desc, gt } from "drizzle-orm";
import { getPairsByToken } from "../../services/dexscreener";
import { searchGeckoToken } from "../../services/geckoTerminal";
import { getPumpFunToken } from "../../services/pumpfunApi";
import { getNativeTokenPrice, getChainBalance } from "../../services/chainPrice";
import { checkEvmToken, checkSolanaToken } from "../../services/goplus";
import { stopSnipeTracking } from "../../services/snipeMonitor";
import { queuePendingAutoSnipe } from "../../services/pendingSnipeQueue";
import { scoreToken, type ScoreInput } from "../../services/tokenScore";
import {
  detectCAType,
  countSecurityRisks,
  securityLinesFor,
} from "./caAnalysis";
import { handleBuy } from "./trade";
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
      `I'll RugCheck it and check it against your ⚗️ Snipe Filters, then`,
      `show a review — you decide whether to start the snipe.`,
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
  tokenName: string;
  tokenSymbol: string;
  priceUsd: number;
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
      tokenName: pair.baseToken.name,
      tokenSymbol: pair.baseToken.symbol,
      priceUsd: Number(pair.priceUsd ?? 0),
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
      tokenName: geckoPool.baseTokenName,
      tokenSymbol: geckoPool.baseTokenSymbol,
      priceUsd: Number(geckoPool.priceUsd ?? 0),
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
        tokenName: pumpToken.name,
        tokenSymbol: pumpToken.symbol,
        priceUsd,
        liquidityUsd: (pumpToken.virtualSolReserves / 1e9) * solPrice * 2,
        marketCapUsd: priceUsd * pumpToken.totalSupply,
      };
    }
  }

  return { found: false, tokenName: "Unknown", tokenSymbol: "?", priceUsd: 0, liquidityUsd: 0, marketCapUsd: 0 };
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
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

  await ctx.reply(`🔍 Checking <code>${ca}</code>…`, { parse_mode: "HTML" });

  const [config, metrics, security] = await Promise.all([
    db.query.sniperConfigsTable.findFirst({ where: eq(sniperConfigsTable.userId, user.id) }),
    fetchQuickMetrics(ca, user.activeChain),
    isEvmCa ? checkEvmToken(user.activeChain, ca) : checkSolanaToken(ca),
  ]);

  if (!metrics.found) {
    await ctx.reply(
      "❓ Couldn't find market data for this token yet — it may be too new. Try again in a moment.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const securityRisks = countSecurityRisks(isEvmCa ? "EVM" : "SOL", security);
  const securityLines = securityLinesFor(isEvmCa ? "EVM" : "SOL", security);

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

  const filtersPass = checks.every((c) => c.pass);
  const overallOk = filtersPass && securityRisks === 0;

  const verdictLines = checks.length
    ? checks.map((c) => `  ${c.pass ? "✅" : "❌"} ${c.label}`)
    : [`  ℹ️ No filters configured in ⚗️ Snipe Filters.`];

  const lines = [
    `🎯 <b>Manual Snipe Review</b>`,
    `🪙 <b>${metrics.tokenName}</b> (<code>${metrics.tokenSymbol}</code>) — ${user.activeChain}`,
    `📍 CA: <code>${ca}</code>`,
    `—`,
    `💲 Price: <b>$${metrics.priceUsd.toFixed(8)}</b>`,
    `🏦 MCap: ${fmtUsd(metrics.marketCapUsd)}  |  💧 Liq: ${fmtUsd(metrics.liquidityUsd)}`,
    `—`,
    `<b>Your Filters:</b>`,
    ...verdictLines,
    `—`,
    ...securityLines,
    `—`,
  ];

  if (!overallOk) {
    lines.push(
      `⚠️ <b>Warning:</b> ${!filtersPass ? "this token doesn't meet your filter criteria" : ""}${
        !filtersPass && securityRisks > 0 ? " and " : ""
      }${securityRisks > 0 ? "has security risk flags" : ""}.`,
      `Proceed only if you understand the risk.`
    );
  } else {
    lines.push(`✅ Passes your filters with no security flags.`);
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback(overallOk ? "🎯 Start Manual Snipe" : "⚠️ Start Anyway", `manual_snipe_start:${ca}`)],
      [Markup.button.callback("⬅️ Cancel", "dashboard")],
    ]),
  });
}

/**
 * "🎯 Start Manual Snipe" — checks the wallet balance directly (so the
 * outcome is always an explicit message, never silence): funded → buys
 * immediately via the same path as a normal buy and starts 20-min progress
 * tracking; not funded → tells the user to fund the wallet AND queues the
 * token so services/pendingSnipeQueue.ts fires the buy automatically the
 * moment the balance is sufficient (checked every minute, up to 1 hour).
 */
export async function handleStartManualSnipe(ctx: Context, ca: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
  if (!user) { await ctx.reply("❌ Send /start first."); return; }

  const wallet = await db.query.walletsTable.findFirst({
    where: and(eq(walletsTable.userId, user.id), eq(walletsTable.chain, user.activeChain), eq(walletsTable.isActive, true)),
  });
  if (!wallet) {
    await ctx.reply("❌ No active wallet for this chain. Set one up in 💼 Wallet Manager first.");
    return;
  }

  const config = await db.query.sniperConfigsTable.findFirst({ where: eq(sniperConfigsTable.userId, user.id) });
  const buyAmount = config?.autoBuyAmountNative ?? "0.1";
  const buyAmountNum = parseFloat(buyAmount);

  const balance = parseFloat(await getChainBalance(user.activeChain, wallet.address).catch(() => "0"));

  if (balance < buyAmountNum) {
    const metrics = await fetchQuickMetrics(ca, user.activeChain);
    await ctx.reply(
      [
        `⚠️ <b>Insufficient balance</b>`,
        `💼 Wallet: <b>${balance.toFixed(4)} ${user.activeChain}</b>`,
        `🛒 Needed: <b>${buyAmount} ${user.activeChain}</b>`,
        ``,
        `📥 Fund your wallet:`,
        `<code>${wallet.address}</code>`,
        ``,
        `✅ This snipe is now <b>queued</b> — I'll check your balance every minute and buy automatically the moment it's funded (queue expires after 1 hour).`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );

    await queuePendingAutoSnipe({
      dbUserId: user.id,
      telegramId,
      chain: user.activeChain,
      ca,
      tokenSymbol: metrics.tokenSymbol,
      tokenName: metrics.tokenName,
      priceUsd: String(metrics.priceUsd),
      liquidityUsd: metrics.liquidityUsd,
      buyAmountNative: buyAmount,
    });
    return;
  }

  const before = new Date();
  await handleBuy(ctx, ca, buyAmount);

  const confirmedTrade = await db.query.tradesTable.findFirst({
    where: and(
      eq(tradesTable.userId, user.id),
      eq(tradesTable.tokenAddress, ca),
      eq(tradesTable.side, "BUY"),
      eq(tradesTable.status, "CONFIRMED"),
      gt(tradesTable.createdAt, before)
    ),
    orderBy: [desc(tradesTable.createdAt)],
  });

  if (!confirmedTrade) return; // handleBuy already reported the failure reason

  await db.insert(activeSnipesTable).values({
    userId: user.id,
    telegramId,
    chain: user.activeChain,
    tokenAddress: ca,
    tokenSymbol: confirmedTrade.tokenSymbol,
    tokenName: confirmedTrade.tokenName,
    entryPriceUsd: confirmedTrade.priceUsd,
  });

  await ctx.reply(
    `🎯 <b>Manual Snipe active</b> — you'll get a progress update roughly every 20 minutes. Use 🔄 Refresh anytime for a live check.`,
    { parse_mode: "HTML" }
  );
}

export async function handleStopSnipe(ctx: Context, snipeIdStr: string): Promise<void> {
  const snipeId = parseInt(snipeIdStr, 10);
  if (!Number.isFinite(snipeId)) return;
  await stopSnipeTracking(snipeId);
  await ctx.reply("⏹ Stopped periodic updates for this position. Your tokens are untouched — sell anytime from 📊 Track PnL.");
}

/**
 * "🎯 Snipe" preview — reachable from a CA analysis card, New Runners, or
 * Trending. Unlike the Buy buttons (which buy immediately), this shows a
 * CONFIRM SNIPE screen first: score/signal, computed TP/SL price targets
 * (from tokenScore.ts's exitPlan), and the configured buy amount — so the
 * user sees exactly what they're agreeing to before anything executes.
 * Confirm re-uses the same manual_snipe_start:<ca> flow as Manual Snipe
 * (balance check, buy, then registers 20-min progress tracking).
 */
export async function handleSnipeConfirmPreview(ctx: Context, target: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const parts = target.split(":");
  const type = parts[0] as "SOL" | "EVM";
  const chain = type === "SOL" ? "SOL" : parts[1] ?? "ETH";
  const ca = parts.slice(2).join(":");
  if (!ca) return;

  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
  if (!user) { await ctx.reply("❌ Send /start first."); return; }

  await ctx.reply("🎯 Preparing snipe preview…");

  const [config, metrics, security] = await Promise.all([
    db.query.sniperConfigsTable.findFirst({ where: eq(sniperConfigsTable.userId, user.id) }),
    fetchQuickMetrics(ca, chain),
    type === "SOL" ? checkSolanaToken(ca) : checkEvmToken(chain, ca),
  ]);

  if (!metrics.found) {
    await ctx.reply("❓ No live market data for this token right now — try 🔍 Analyze instead.");
    return;
  }

  const securityRisks = countSecurityRisks(type === "SOL" ? "SOL" : "EVM", security);
  const scoreInput: ScoreInput = {
    liquidityUsd: metrics.liquidityUsd,
    volume24hUsd: 0, // not fetched in this quick preview — score is a rough guide here, not the full analysis
    marketCapUsd: metrics.marketCapUsd,
    buys24h: undefined,
    sells24h: undefined,
    ageMinutes: metrics.ageMinutes,
    securityRisks,
  };
  const scoreResult = scoreToken(scoreInput);

  const buyAmountNative = parseFloat(config?.autoBuyAmountNative ?? "0.1");
  const nativePrice = Number(await getNativeTokenPrice(chain).catch(() => 0));
  const buyAmountUsd = buyAmountNative * nativePrice;

  const tpPrice = metrics.priceUsd * (1 + scoreResult.exitPlan.tp1 / 100);
  const slPrice = metrics.priceUsd * (1 + scoreResult.exitPlan.sl / 100); // sl is already negative

  const signalEmoji = scoreResult.signal === "BUY" ? "🟢" : scoreResult.signal === "WATCH" ? "🟡" : "🔴";
  const warning =
    scoreResult.score < 50 || securityRisks > 0
      ? `⚠️ ${securityRisks > 0 ? "Security risk flags found" : "Score below 50"} — consider waiting or skipping.`
      : null;

  await ctx.reply(
    [
      `🎯 <b>CONFIRM SNIPE</b>`,
      ``,
      `Token: <b>${metrics.tokenName}</b> (<code>${metrics.tokenSymbol}</code>)`,
      `Score: <b>${scoreResult.score}/100</b> | ${signalEmoji} ${scoreResult.signal}`,
      ``,
      `📌 Price: $${metrics.priceUsd.toFixed(8)}`,
      `🏦 MCap: ${fmtUsd(metrics.marketCapUsd)}`,
      ...(warning ? [``, warning] : []),
      ``,
      `<b>Trade Details</b>`,
      `💰 In: <b>${buyAmountNative} ${chain}</b> (~$${buyAmountUsd.toFixed(2)})`,
      `🎯 TP: $${tpPrice.toFixed(8)} (+${scoreResult.exitPlan.tp1}%)`,
      `🛑 SL: $${slPrice.toFixed(8)} (${scoreResult.exitPlan.sl}%)`,
      `⏱ Suggested max hold: 120 min <i>(shown for reference — not auto-enforced; sell manually via 📊 Track PnL)</i>`,
      ``,
      `Change buy amount in ⚙️ Snipe Filters → Buy Amount.`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Confirm Snipe", `manual_snipe_start:${ca}`),
          Markup.button.callback("❌ Cancel", "dashboard"),
        ],
        [Markup.button.callback("⚗️ Snipe Filters", "filters")],
      ]),
    }
  );
}
