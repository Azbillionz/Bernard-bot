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
}

interface BoostToken {
  tokenAddress?: string;
  chainId?: string;
}

export async function getPairsByToken(ca: string): Promise<TokenPair[]> {
  try {
    const res = await fetch(`${BASE_URL}/latest/dex/tokens/${ca}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { pairs?: TokenPair[] };
    return data.pairs ?? [];
  } catch {
    return [];
  }
}

async function fetchBoostTokenPairs(endpoint: string): Promise<TokenPair[]> {
  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as BoostToken[];
    if (!Array.isArray(data)) return [];
    const results: TokenPair[] = [];
    for (const token of data.slice(0, 5)) {
      if (!token.tokenAddress) continue;
      const pairs = await getPairsByToken(token.tokenAddress);
      const best = pairs[0];
      if (best) results.push(best);
    }
    return results;
  } catch {
    return [];
  }
}

export async function getTrendingPairs(): Promise<TokenPair[]> {
  return fetchBoostTokenPairs("/token-boosts/top/v1");
}

export async function getNewRunners(): Promise<TokenPair[]> {
  return fetchBoostTokenPairs("/token-boosts/latest/v1");
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
