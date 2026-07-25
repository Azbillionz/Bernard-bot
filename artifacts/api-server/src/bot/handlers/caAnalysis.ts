/**
 * CA Analysis — triggered by text input or inline "analyze:" callback.
 * Waterfall: DexScreener → GeckoTerminal → PumpFun (SOL only)
 * Detects EVM (0x + 40 hex) or Solana (43–44 char base58) addresses.
 *
 * Message format includes an auto-generated Score/Signal/Potential block
 * (see ../../services/tokenScore.ts) — a transparent formula built from
 * real liquidity/volume/momentum/security data, not a third-party opinion.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getPairsByToken, type TokenPair } from "../../services/dexscreener";
import { searchGeckoToken, type GeckoPool } from "../../services/geckoTerminal";
import { getPumpFunToken, type PumpFunToken } from "../../services/pumpfunApi";
import { getNativeTokenPrice } from "../../services/chainPrice";
import { checkEvmToken, checkSolanaToken } from "../../services/goplus";
import { scoreToken, formatScoreBlock, type ScoreInput } from "../../services/tokenScore";
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

type EvmSecurity = Awaited<ReturnType<typeof checkEvmToken>>;
type SolSecurity = Awaited<ReturnType<typeof checkSolanaToken>>;

function countSecurityRisks(caType: "EVM" | "SOL", security: EvmSecurity | SolSecurity): number {
  if (caType === "EVM") {
    const s = security as EvmSecurity;
    return (
      (s.isHoneypot ? 1 : 0) +
      (s.isMintable ? 1 : 0) +
      (s.isBlacklisted ? 1 : 0) +
      (s.buyTax > 10 ? 1 : 0) +
      (s.sellTax > 10 ? 1 : 0)
    );
  }
  const s = security as SolSecurity;
  return (s.hasMintAuthority ? 1 : 0) + (s.hasFreezeAuthority ? 1 : 0) + (s.isBlacklisted ? 1 : 0);
}

function securityLinesFor(caType: "EVM" | "SOL", security: EvmSecurity | SolSecurity): string[] {
  if (caType === "EVM") {
    const s = security as EvmSecurity;
    return [
      `🕵️ <b>Security (GoPlus)</b>`,
      `  🍯 Honeypot: <b>${s.isHoneypot ? "⚠️ YES" : "✅ NO"}</b>`,
      `  💸 Buy Tax: <b>${s.buyTax.toFixed(1)}%</b> | Sell Tax: <b>${s.sellTax.toFixed(1)}%</b>`,
      `  🖨 Mintable: <b>${s.isMintable ? "⚠️ YES" : "✅ NO"}</b>`,
      `  🚫 Blacklist: <b>${s.isBlacklisted ? "⚠️ YES" : "✅ NO"}</b>`,
    ];
  }
  const s = security as SolSecurity;
  return [
    `🕵️ <b>Security (GoPlus)</b>`,
    `  🖨 Mint Authority: <b>${s.hasMintAuthority ? "⚠️ ACTIVE" : "✅ REVOKED"}</b>`,
    `  🧊 Freeze Authority: <b>${s.hasFreezeAuthority ? "⚠️ ACTIVE" : "✅ REVOKED"}</b>`,
    `  🚫 Blacklist: <b>${s.isBlacklisted ? "⚠️ YES" : "✅ NO"}</b>`,
  ];
}

function sign(n?: number): string {
  if (n === undefined || n === null) return "0.00";
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtAge(ageMinutes?: number): string {
  if (ageMinutes === undefined) return "N/A";
  if (ageMinutes < 60) return `${Math.round(ageMinutes)} min`;
  if (ageMinutes < 1440) return `${(ageMinutes / 60).toFixed(1)} hr`;
  return `${(ageMinutes / 1440).toFixed(1)} d`;
}

/** Build the full scored card for a DexScreener pair. */
function buildDexScreenerCard(pair: TokenPair, securityLines: string[], securityRisks: number): string {
  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volume24hUsd = pair.volume?.h24 ?? 0;
  const marketCapUsd = pair.marketCap ?? pair.fdv ?? 0;
  const buys24h = pair.txns?.h24?.buys ?? 0;
  const sells24h = pair.txns?.h24?.sells ?? 0;
  const ageMinutes = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60_000 : undefined;

  const input: ScoreInput = {
    liquidityUsd,
    volume24hUsd,
    marketCapUsd,
    buys24h,
    sells24h,
    priceChange5m: pair.priceChange?.m5,
    priceChange1h: pair.priceChange?.h1,
    priceChange24h: pair.priceChange?.h24,
    ageMinutes,
    securityRisks,
  };
  const result = scoreToken(input);

  return [
    `🚀 <b>${pair.baseToken.name}</b> (<code>${pair.baseToken.symbol}</code>)`,
    `🔗 ${pair.dexId} on ${pair.chainId}`,
    `—`,
    formatScoreBlock(result),
    `—`,
    `💲 Price  <b>$${Number(pair.priceUsd ?? 0).toFixed(8)}</b>`,
    `🏦 Market Cap  ${fmtUsd(marketCapUsd)}`,
    `💧 Liquidity  ${fmtUsd(liquidityUsd)}`,
    `📊 Vol 24h  ${fmtUsd(volume24hUsd)}`,
    `🔄 Buys ${buys24h} | Sells ${sells24h}`,
    `⏱ Age  ${fmtAge(ageMinutes)}`,
    `📈 5m: ${sign(pair.priceChange?.m5)}% | 1h: ${sign(pair.priceChange?.h1)}% | 24h: ${sign(pair.priceChange?.h24)}%`,
    `—`,
    `📍 CA: <code>${pair.baseToken.address}</code>`,
    `—`,
    ...securityLines,
  ].join("\n");
}

/** Build the full scored card for a GeckoTerminal pool (pre-DexScreener listing). */
function buildGeckoCard(pool: GeckoPool, securityLines: string[], securityRisks: number): string {
  const liquidityUsd = pool.liquidityUsd ?? 0;
  const volume24hUsd = pool.volumeUsd24h ?? 0;
  const marketCapUsd = pool.marketCapUsd ?? pool.fdvUsd ?? 0;
  const ageMinutes = pool.poolCreatedAt ? (Date.now() - pool.poolCreatedAt) / 60_000 : undefined;

  const input: ScoreInput = {
    liquidityUsd,
    volume24hUsd,
    marketCapUsd,
    buys24h: pool.buys24h,
    sells24h: pool.sells24h,
    priceChange5m: pool.priceChange5m,
    priceChange1h: pool.priceChange1h,
    priceChange24h: pool.priceChange24h,
    ageMinutes,
    securityRisks,
  };
  const result = scoreToken(input);

  return [
    `🚀 <b>${pool.baseTokenName}</b> (<code>${pool.baseTokenSymbol}</code>)`,
    `🔗 ${pool.dexId} on ${pool.network}`,
    `<i>📡 Source: GeckoTerminal (not on DexScreener yet)</i>`,
    `—`,
    formatScoreBlock(result),
    `—`,
    `💲 Price  <b>$${Number(pool.priceUsd ?? 0).toFixed(8)}</b>`,
    `🏦 Market Cap  ${fmtUsd(marketCapUsd)}`,
    `💧 Liquidity  ${fmtUsd(liquidityUsd)}`,
    `📊 Vol 24h  ${fmtUsd(volume24hUsd)}`,
    `🔄 Buys ${pool.buys24h ?? "N/A"} | Sells ${pool.sells24h ?? "N/A"}`,
    `⏱ Age  ${fmtAge(ageMinutes)}`,
    `📈 5m: ${sign(pool.priceChange5m)}% | 1h: ${sign(pool.priceChange1h)}% | 24h: ${sign(pool.priceChange24h)}%`,
    `—`,
    `📍 CA: <code>${pool.baseTokenAddress}</code>`,
    `—`,
    ...securityLines,
  ].join("\n");
}

/** Build the full scored card for a pre-graduation PumpFun token (on-chain data only). */
function buildPumpFunCard(
  token: PumpFunToken,
  solPriceUsd: number,
  securityLines: string[],
  securityRisks: number
): string {
  const priceUsd = token.priceNative * solPriceUsd;
  const marketCapUsd = priceUsd * token.totalSupply;
  const liquidityUsd = (token.virtualSolReserves / 1e9) * solPriceUsd * 2; // both sides of the curve

  const input: ScoreInput = {
    liquidityUsd,
    volume24hUsd: 0, // not available from on-chain bonding-curve state alone
    marketCapUsd,
    securityRisks,
    // buys/sells/age/momentum unavailable pre-graduation without an indexer —
    // scoring degrades gracefully (treated as neutral/unknown) rather than guessed
  };
  const result = scoreToken(input);

  return [
    `🚀 <b>${token.name}</b> (<code>${token.symbol}</code>)`,
    `🌱 PumpFun ${token.complete ? "✅ Graduated" : "PRE-BOND"}`,
    `<i>🚀 Source: PumpFun on-chain (bonding curve)</i>`,
    `—`,
    formatScoreBlock(result),
    `—`,
    `💲 Price  <b>~$${priceUsd.toFixed(8)}</b> (${token.priceNative.toFixed(6)} SOL)`,
    `🏦 Market Cap  ${marketCapUsd > 0 ? fmtUsd(marketCapUsd) : "N/A"}`,
    `💧 Liquidity  ~${fmtUsd(liquidityUsd)}`,
    `📈 Bonding progress: ${Math.min(token.bondingCurveProgress, 100).toFixed(1)}%${token.complete ? " ✅" : ""}`,
    `—`,
    `📍 CA: <code>${token.mint}</code>`,
    `—`,
    ...securityLines,
  ].join("\n");
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
  const securityRisks = countSecurityRisks(caType, security);
  const securityLines = securityLinesFor(caType, security);

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

  // ── 1. DexScreener hit ───────────────────────────────────────────────────
  if (pair) {
    const fullText = buildDexScreenerCard(pair, securityLines, securityRisks);

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
    const fullText = buildGeckoCard(geckoPool, securityLines, securityRisks);

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
      const fullText = buildPumpFunCard(pumpToken, solPrice, securityLines, securityRisks);

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

/**
 * Also handles the inline "analyze:CA" callback button.
 * NOTE: the global middleware in bot/index.ts already answers every
 * callback query — answering again here throws and aborts the analysis.
 */
export async function handleAnalyzeCallback(ctx: Context, ca: string): Promise<void> {
  await handleCAAnalysis(ctx, ca);
}
