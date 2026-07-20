/**
 * Flashbots Private RPC — routes EVM transactions outside the public mempool
 * to eliminate front-running and sandwich attacks.
 */

const FLASHBOTS_RPC =
  process.env["FLASHBOTS_RPC_URL"] ?? "https://rpc.flashbots.net";

const EVM_RPC_ENV: Record<string, string> = {
  ETH: "ETH_RPC_URL",
  BASE: "BASE_RPC_URL",
  BSC: "BSC_RPC_URL",
};

export async function sendPrivateTx(signedTxHex: string): Promise<string | null> {
  try {
    const res = await fetch(FLASHBOTS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendPrivateTransaction",
        params: [{ tx: signedTxHex, preferences: { fast: true } }],
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

export async function simulateEvmTx(
  from: string,
  to: string,
  data: string,
  chain: string
): Promise<{ success: boolean; error?: string }> {
  const envKey = EVM_RPC_ENV[chain];
  const rpcUrl = envKey ? (process.env[envKey] ?? "") : "";
  if (!rpcUrl) return { success: false, error: "No RPC URL configured for " + chain };
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ from, to, data }, "latest"],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await res.json()) as {
      result?: string;
      error?: { message?: string };
    };
    if (result.error) {
      return { success: false, error: result.error.message ?? "Simulation failed" };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
