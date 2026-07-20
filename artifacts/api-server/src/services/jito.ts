/**
 * Jito Block Engine — sends Solana transactions as bundles to avoid front-running.
 * Transactions are routed through the Jito block engine with dynamic tips.
 */

export async function sendJitoBundle(
  serializedBase64Txs: string[]
): Promise<string | null> {
  const jitoUrl =
    process.env["JITO_BLOCK_ENGINE_URL"] ??
    "https://mainnet.block-engine.jito.wtf";
  try {
    const res = await fetch(`${jitoUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedBase64Txs],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: string };
    return data.result ?? null;
  } catch {
    return null;
  }
}

export function getJitoTipLamports(): number {
  const tip = process.env["DEFAULT_SOL_JITO_TIP"];
  return tip ? parseInt(tip, 10) : 10_000;
}

export async function getBundleStatus(bundleId: string): Promise<string> {
  const jitoUrl =
    process.env["JITO_BLOCK_ENGINE_URL"] ??
    "https://mainnet.block-engine.jito.wtf";
  try {
    const res = await fetch(`${jitoUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return "UNKNOWN";
    const data = (await res.json()) as {
      result?: { value?: { confirmation_status?: string }[] };
    };
    return data.result?.value?.[0]?.confirmation_status ?? "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
