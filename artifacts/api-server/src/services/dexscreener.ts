/**
 * DexScreener service — primary market data source.
 * Trending / runners fall back to GeckoTerminal when DexScreener returns nothing.
 */

const BASE_URL =
  process.env["DEXSCREENER_API_URL"] ?? "https://api.dexscreener.com";

export interface TokenPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceNative: string;
  priceUsd?: string;
  volume: { m5: number; h1: number; h6: number; h24: number };
  priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number; base: number; quote: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number; // unix ms
  txns?: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h6?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
}

interface BoostToken {
  tokenAddress?: string;
  chainId?: string;
}

/** Fetch with one automatic retry on failure */
async function fetchWithRetry(url: string, timeoutMs = 10_000): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  return null;
}

export async function getPairsByToken(ca: string): Promise<TokenPair[]> {
  try {
    const res = await fetchWithRetry(`${BASE_URL}/latest/dex/tokens/${ca}`);
    if (!res) return [];
    const data = (await res.json()) as { pairs?: TokenPair[] };
    return data.pairs ?? [];
  } catch {
    return [];
  }
}

async function fetchBoostTokenPairs(endpoint: string): Promise<TokenPair[]> {
  try {
    const res = await fetchWithRetry(`${BASE_URL}${endpoint}`);
    if (!res) return [];
    const data = (await res.json()) as BoostToken[];
    if (!Array.isArray(data) || data.length === 0) return [];

    const results: TokenPair[] = [];
    // Resolve first 8 tokens in parallel (take best 5 that resolve)
    const resolved = await Promise.all(
      data.slice(0, 8).map(async (token) => {
        if (!token.tokenAddress) return null;
        const pairs = await getPairsByToken(token.tokenAddress);
        return pairs[0] ?? null;
      })
    );
    for (const pair of resolved) {
      if (pair) results.push(pair);
      if (results.length >= 5) break;
    }
    return results;
  } catch {
    return [];
  }
}

export async function getTrendingPairs(): Promise<TokenPair[]> {
  const dex = await fetchBoostTokenPairs("/token-boosts/top/v1");
  if (dex.length > 0) return dex;
  // Fallback to GeckoTerminal trending (dynamically imported to avoid circular)
  try {
    const { getGeckoTrending, formatGeckoPool } = await import("./geckoTerminal");
    const pools = await getGeckoTrending("solana");
    // Convert GeckoPool → minimal TokenPair shape for re-use in handler
    return pools.map((p) => geckoPoolToTokenPair(p));
  } catch {
    return [];
  }
}

export async function getNewRunners(): Promise<TokenPair[]> {
  const dex = await fetchBoostTokenPairs("/token-boosts/latest/v1");
  if (dex.length > 0) return dex;
  // Fallback to GeckoTerminal new pools
  try {
    const { getGeckoNewPools } = await import("./geckoTerminal");
    const pools = await getGeckoNewPools("solana");
    return pools.map((p) => geckoPoolToTokenPair(p));
  } catch {
    return [];
  }
}

import type { GeckoPool } from "./geckoTerminal";
function geckoPoolToTokenPair(p: GeckoPool): TokenPair {
  return {
    chainId: p.network,
    dexId: p.dexId,
    pairAddress: p.address,
    baseToken: {
      address: p.baseTokenAddress || p.address,
      name: p.baseTokenName,
      symbol: p.baseTokenSymbol,
    },
    quoteToken: { address: "", symbol: "SOL" },
    priceNative: "0",
    priceUsd: p.priceUsd,
    volume: { m5: 0, h1: 0, h6: 0, h24: p.volumeUsd24h },
    priceChange: {
      m5: p.priceChange5m,
      h1: p.priceChange1h,
      h24: p.priceChange24h,
    },
    liquidity: { usd: p.liquidityUsd, base: 0, quote: 0 },
    fdv: p.fdvUsd ?? undefined,
    marketCap: p.marketCapUsd ?? undefined,
  };
}

export function formatPairMessage(pair: TokenPair): string {
  const pc = pair.priceChange ?? {};
  const liquidity = pair.liquidity?.usd
    ? `$${(pair.liquidity.usd / 1_000).toFixed(1)}K`
    : "N/A";
  const mc = pair.marketCap
    ? `$${(pair.marketCap / 1_000_000).toFixed(2)}M`
    : pair.fdv
      ? `$${(pair.fdv / 1_000_000).toFixed(2)}M (FDV)`
      : "N/A";
  return [
    `🪙 <b>${pair.baseToken.name}</b> (<code>${pair.baseToken.symbol}</code>)`,
    `📍 CA: <code>${pair.baseToken.address}</code>`,
    `💲 Price: <b>$${Number(pair.priceUsd ?? 0).toFixed(8)}</b>`,
    `📊 5m: ${sign(pc.m5)}% | 1h: ${sign(pc.h1)}% | 24h: ${sign(pc.h24)}%`,
    `🏦 MCap: ${mc} | 💧 Liq: ${liquidity}`,
    `🔗 DEX: ${pair.dexId} on ${pair.chainId}`,
  ].join("\n");
}

function sign(n?: number): string {
  if (n === undefined || n === null) return "0.00";
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}
