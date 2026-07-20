/**
 * PumpFun REST API — token info for pre-graduation meme coins.
 * These tokens often don't appear on DexScreener or GeckoTerminal yet.
 */

export interface PumpFunToken {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  createdTimestamp: number;
  usdMarketCap: number;
  bondingCurveProgress: number; // 0–100 (100 = graduated)
  complete: boolean;
  totalSupply: number;
  priceNative: number; // price in SOL
  priceUsd: number;
  virtualSolReserves: number;
  virtualTokenReserves: number;
}

interface RawPumpCoin {
  mint?: string;
  name?: string;
  symbol?: string;
  description?: string;
  image_uri?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  created_timestamp?: number;
  usd_market_cap?: number;
  bonding_curve_progress?: number;
  complete?: boolean;
  total_supply?: number;
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
}

const PUMP_API = "https://frontend-api.pump.fun";

export async function getPumpFunToken(
  mint: string
): Promise<PumpFunToken | null> {
  try {
    const res = await fetch(`${PUMP_API}/coins/${mint}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as RawPumpCoin;
    if (!d.mint) return null;

    // Derive price from virtual reserves (k = sol * tokens, price = sol/tokens)
    const solRes = (d.virtual_sol_reserves ?? 0) / 1e9; // lamports → SOL
    const tokRes = (d.virtual_token_reserves ?? 0) / 1e6; // micro-tokens → tokens
    const priceNative = tokRes > 0 ? solRes / tokRes : 0;

    // We need SOL/USD price to convert — use a rough proxy
    // Will be enriched by caller using chainPrice service
    return {
      mint: d.mint,
      name: d.name ?? "Unknown",
      symbol: d.symbol ?? "?",
      description: d.description ?? "",
      imageUri: d.image_uri ?? "",
      twitter: d.twitter,
      telegram: d.telegram,
      website: d.website,
      createdTimestamp: d.created_timestamp ?? 0,
      usdMarketCap: d.usd_market_cap ?? 0,
      bondingCurveProgress: (d.bonding_curve_progress ?? 0) * 100,
      complete: d.complete ?? false,
      totalSupply: d.total_supply ?? 0,
      priceNative,
      priceUsd: 0, // enriched by caller
      virtualSolReserves: d.virtual_sol_reserves ?? 0,
      virtualTokenReserves: d.virtual_token_reserves ?? 0,
    };
  } catch {
    return null;
  }
}

export function formatPumpFunMessage(
  token: PumpFunToken,
  solPriceUsd: number
): string {
  const priceUsd = token.priceNative * solPriceUsd;
  const mcUsd =
    token.usdMarketCap > 0
      ? `$${(token.usdMarketCap / 1_000).toFixed(1)}K`
      : priceUsd > 0 && token.totalSupply > 0
        ? `$${((priceUsd * token.totalSupply) / 1_000_000).toFixed(2)}M`
        : "N/A";

  const progress = Math.min(token.bondingCurveProgress, 100).toFixed(1);
  const progressBar =
    "█".repeat(Math.round(token.bondingCurveProgress / 10)) +
    "░".repeat(10 - Math.round(token.bondingCurveProgress / 10));

  const links: string[] = [];
  if (token.twitter) links.push(`<a href="${token.twitter}">🐦 Twitter</a>`);
  if (token.telegram) links.push(`<a href="${token.telegram}">💬 Telegram</a>`);
  if (token.website) links.push(`<a href="${token.website}">🌐 Website</a>`);

  return [
    `🚀 <b>${token.name}</b> (<code>${token.symbol}</code>) — PumpFun`,
    `📍 CA: <code>${token.mint}</code>`,
    `💲 Price: <b>~$${priceUsd.toFixed(8)}</b> (${token.priceNative.toFixed(6)} SOL)`,
    `🏦 MCap: ${mcUsd}`,
    `📈 Bonding: [${progressBar}] ${progress}%${token.complete ? " ✅ Graduated" : ""}`,
    ...(links.length ? [`🔗 ${links.join(" | ")}`] : []),
    `📝 ${token.description.slice(0, 120)}${token.description.length > 120 ? "…" : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}
