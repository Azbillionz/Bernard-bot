/**
 * EVM swap via 0x Swap API v2 (AllowanceHolder) with integrator fee routing
 * to DEV_FEE_WALLET. All swaps are pre-simulated via eth_call before submission.
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
  // 0x API key is optional; without it the swap route is unavailable
  const apiKey = process.env["ZEROX_API_KEY"] ?? "";
  if (!apiKey) return null;

  const chainId = CHAIN_IDS[chain] ?? 1;
  const feeWallet = process.env["DEV_FEE_WALLET"] ?? "";

  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken: fromToken,
    buyToken: toToken,
    sellAmount: amountWei,
    taker: fromAddress,
    slippageBps: String(Math.round(slippage * 100)),
    ...(feeWallet
      ? { swapFeeRecipient: feeWallet, swapFeeBps: "100", swapFeeToken: toToken } // 1% integrator fee, taken from output token
      : {}),
  });

  try {
    const res = await fetch(
      `https://api.0x.org/swap/allowance-holder/quote?${params.toString()}`,
      {
        headers: { "0x-api-key": apiKey, "0x-version": "v2" },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      buyAmount?: string;
      transaction?: { to: string; data: string; value: string; gas: string };
    };
    if (!data.transaction) return null;
    return {
      to: data.transaction.to,
      data: data.transaction.data,
      value: data.transaction.value,
      gas: Number(data.transaction.gas),
      toAmount: data.buyAmount ?? "0",
    };
  } catch {
    return null;
  }
}

export const EVM_NATIVE_TOKEN = NATIVE_TOKEN;
