/**
 * Token scoring — a transparent, formula-based heuristic (0–100) built
 * entirely from real market metrics: liquidity depth, volume/mcap ratio,
 * buy-vs-sell pressure, price momentum, listing age, and security risk
 * flags. This is a quick-glance summary of public data, not financial
 * advice or a guarantee of outcome — always shown alongside the raw
 * numbers it's derived from.
 */

export interface ScoreInput {
  liquidityUsd: number;
  volume24hUsd: number;
  marketCapUsd: number; // marketCap if available, else FDV
  buys24h?: number;
  sells24h?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  ageMinutes?: number;
  securityRisks: number; // count of active red flags
}

export interface ScoreResult {
  score: number; // 0–100
  signal: "BUY" | "WATCH" | "AVOID";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  potential: string;
  flags: string[];
  exitPlan: { tp1: number; tp2: number; sl: number; trailingStop: boolean };
}

export function scoreToken(input: ScoreInput): ScoreResult {
  const {
    liquidityUsd,
    volume24hUsd,
    marketCapUsd,
    buys24h = 0,
    sells24h = 0,
    priceChange5m = 0,
    priceChange1h = 0,
    priceChange24h = 0,
    ageMinutes,
    securityRisks,
  } = input;

  const flags: string[] = [];
  let score = 0;

  // 1. Liquidity depth (25 pts) — deeper liquidity = less slippage/rug risk
  if (liquidityUsd >= 50_000) { score += 25; flags.push("✅ Deep liquidity"); }
  else if (liquidityUsd >= 20_000) { score += 18; flags.push("✅ Healthy liquidity"); }
  else if (liquidityUsd >= 5_000) { score += 10; }
  else { flags.push("⚠️ Thin liquidity"); }

  // 2. Volume / MCap ratio (20 pts) — real trading activity vs valuation
  const volMcRatio = marketCapUsd > 0 ? volume24hUsd / marketCapUsd : 0;
  if (volMcRatio >= 0.5) { score += 20; flags.push("📊 Very high turnover"); }
  else if (volMcRatio >= 0.2) { score += 15; flags.push("📊 Healthy Vol/MCap ratio"); }
  else if (volMcRatio >= 0.05) { score += 10; flags.push("📊 Decent volume"); }
  else { flags.push("⚠️ Low volume relative to MCap"); }

  // 3. Buy/sell pressure (20 pts)
  const totalTxns = buys24h + sells24h;
  const buyRatio = totalTxns > 0 ? buys24h / totalTxns : 0.5;
  if (totalTxns >= 20) {
    if (buyRatio >= 0.65) { score += 20; flags.push("🟢 Strong buy pressure"); }
    else if (buyRatio >= 0.55) { score += 15; }
    else if (buyRatio >= 0.45) { score += 10; }
    else { flags.push("🔴 Sell pressure dominant"); }
  } else {
    score += 5; // not enough trade data to judge either way
  }

  // 4. Momentum (15 pts)
  if (priceChange5m > 5 && priceChange1h > 0) { score += 15; flags.push("🚀 Strong 5m pump"); }
  else if (priceChange5m > 0 || priceChange1h > 0) { score += 8; }
  else if (priceChange24h < -30) { flags.push("⚠️ Heavy 24h drawdown"); }

  // 5. Market cap tier (10 pts) — early-stage has more room to run, but more risk
  let potential: string;
  if (marketCapUsd > 0 && marketCapUsd < 100_000) {
    score += 10;
    flags.push("💰 Early stage MC — 10-100x potential");
    potential = "10-100x (micro-cap, high risk)";
  } else if (marketCapUsd < 1_000_000) {
    score += 7;
    potential = "3-10x (small-cap)";
  } else if (marketCapUsd < 10_000_000) {
    score += 4;
    potential = "1.5-3x (established)";
  } else {
    potential = "Limited — already large-cap";
  }

  // 6. Freshness (10 pts)
  if (ageMinutes !== undefined) {
    if (ageMinutes <= 60) { score += 10; flags.push("⏱ Fresh launch window"); }
    else if (ageMinutes <= 1440) { score += 6; }
    else { score += 3; }
  } else {
    score += 5;
  }

  // 7. Security penalty — up to -30, applied after the positive score
  const securityPenalty = Math.min(securityRisks * 10, 30);
  score -= securityPenalty;
  if (securityRisks > 0) flags.push(`🚫 ${securityRisks} security risk flag(s)`);

  score = Math.max(0, Math.min(100, Math.round(score)));

  let signal: ScoreResult["signal"];
  let confidence: ScoreResult["confidence"];
  if (score >= 70 && securityRisks === 0) { signal = "BUY"; confidence = "HIGH"; }
  else if (score >= 50) { signal = "WATCH"; confidence = "MEDIUM"; }
  else { signal = "AVOID"; confidence = "LOW"; }

  const exitPlan =
    confidence === "HIGH"
      ? { tp1: 100, tp2: 300, sl: -20, trailingStop: true }
      : confidence === "MEDIUM"
        ? { tp1: 50, tp2: 150, sl: -25, trailingStop: true }
        : { tp1: 30, tp2: 75, sl: -30, trailingStop: false };

  return { score, signal, confidence, potential, flags, exitPlan };
}

export function formatScoreBlock(result: ScoreResult): string {
  const filled = Math.round(result.score / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const signalEmoji = result.signal === "BUY" ? "🟢" : result.signal === "WATCH" ? "🟡" : "🔴";
  const entryNote =
    result.confidence === "HIGH"
      ? "Strong signal. Enter now or wait 2-3 min confirmation."
      : result.confidence === "MEDIUM"
        ? "Mixed signal — smaller size or wait for confirmation."
        : "Weak signal — high risk, consider skipping.";

  return [
    `🏆 Score  [${bar}]  ${result.score}/100`,
    `📌 Signal  ${signalEmoji} <b>${result.signal}</b> | ${result.confidence}`,
    ``,
    `🎯 Potential  <b>${result.potential}</b>`,
    `📌 Entry  ${entryNote}`,
    `🚪 Exit  TP1: +${result.exitPlan.tp1}% | TP2: +${result.exitPlan.tp2}% | SL: ${result.exitPlan.sl}% | Trailing stop ${result.exitPlan.trailingStop ? "ON" : "OFF"}`,
    ``,
    `🚩 <b>Flags</b>`,
    ...result.flags.map((f) => `  ${f}`),
    ``,
    `<i>⚙️ Auto-score from live on-chain/market data — not financial advice.</i>`,
  ].join("\n");
}
