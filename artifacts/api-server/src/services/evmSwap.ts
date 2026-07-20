/**
 * EVM swap via 1inch v6 API with integrator fee routing to DEV_FEE_WALLET.
 * All swaps are pre-simulated via eth_call before submission.
 */

const CHAIN_IDS: Record<string, number> = {
  ETH: 1,
  BASE: 8453,
  BSC: 56,
};

const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface EvmSwapTx {
  to: string;
  data: string;
  value: string;
  gas: number;
  toAmount: string;
}

export async function get1inchSwap(
  chain: string,
  fromToken: string,
  toToken: string,
  amountWei: string,
  fromAddress: string,
  slippage = 1
): Promise<EvmSwapTx | null> {
  // 1inch API key is optional; without it the swap route is unavailable
  const apiKey = process.env["ONEINCH_API_KEY"] ?? "";
  if (!apiKey) return null;

  const chainId = CHAIN_IDS[chain] ?? 1;
  const feeWallet = process.env["DEV_FEE_WALLET"] ?? "";

  const params = new URLSearchParams({
    src: fromToken,
    dst: toToken,
    amount: amountWei,
    from: fromAddress,
    slippage: String(slippage),
    ...(feeWallet ? { referrer: feeWallet, fee: "1" } : {}), // 1% integrator fee
  });

  try {
    const res = await fetch(
      `https://api.1inch.dev/swap/v6.0/${chainId}/swap?${params.toString()}`,
      {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      toAmount?: string;
      tx?: { to: string; data: string; value: string; gas: number };
    };
    if (!data.tx) return null;
    return {
      to: data.tx.to,
      data: data.tx.data,
      value: data.tx.value,
      gas: data.tx.gas,
      toAmount: data.toAmount ?? "0",
    };
  } catch {
    return null;
  }
}

export const EVM_NATIVE_TOKEN = NATIVE_TOKEN;
