/**
 * Jupiter V6 API — Solana token swaps with 1% platform fee (100 bps).
 * All swaps are pre-simulated via simulateTransaction before submission.
 */

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6";
const PLATFORM_FEE_BPS = 100; // 1%

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps = 1000
): Promise<JupiterQuote | null> {
  const feeWallet = process.env["DEV_FEE_WALLET"] ?? "";
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountLamports),
    slippageBps: String(slippageBps),
    platformFeeBps: String(PLATFORM_FEE_BPS),
    ...(feeWallet ? { feeAccount: feeWallet } : {}),
  });
  try {
    const res = await fetch(`${JUPITER_QUOTE_API}/quote?${params.toString()}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as JupiterQuote;
  } catch {
    return null;
  }
}

export async function buildJupiterSwapTx(
  quote: JupiterQuote,
  userPublicKey: string,
  prioritizationFeeLamports = 5_000
): Promise<string | null> {
  try {
    const res = await fetch(`${JUPITER_QUOTE_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { swapTransaction?: string };
    return data.swapTransaction ?? null;
  } catch {
    return null;
  }
}

export async function simulateSolanaTx(
  serializedBase64: string
): Promise<{ success: boolean; error?: string }> {
  const rpcUrl =
    process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: [serializedBase64, { encoding: "base64", sigVerify: false }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as {
      result?: { value?: { err?: unknown } };
    };
    const err = data.result?.value?.err;
    return err
      ? { success: false, error: JSON.stringify(err) }
      : { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
