/**
 * EVM on-chain resolver — last-resort fallback when neither DexScreener nor
 * GeckoTerminal have indexed a token yet. An EVM address alone doesn't say
 * which chain it's on, so this checks ETH/BASE/BSC in parallel via
 * eth_getCode and reads basic ERC20 metadata directly from whichever chain
 * actually has a contract deployed at that address. No API key, no
 * dependency on the user's currently-selected wallet chain.
 */

const RPC_ENV: Record<"ETH" | "BASE" | "BSC", string> = {
  ETH: "ETH_RPC_URL",
  BASE: "BASE_RPC_URL",
  BSC: "BSC_RPC_URL",
};

export interface OnchainEvmToken {
  chain: "ETH" | "BASE" | "BSC";
  name: string;
  symbol: string;
  decimals: number;
}

async function readErc20Metadata(
  rpcUrl: string,
  address: string
): Promise<{ name: string; symbol: string; decimals: number } | null> {
  try {
    const { JsonRpcProvider, Contract } = await import("ethers");
    const provider = new JsonRpcProvider(rpcUrl);
    const code = await provider.getCode(address);
    if (!code || code === "0x") return null; // no contract at this address on this chain

    const abi = [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
    ];
    const contract = new Contract(address, abi, provider);
    const [name, symbol, decimals] = await Promise.all([
      contract["name"]?.().catch(() => "Unknown"),
      contract["symbol"]?.().catch(() => "?"),
      contract["decimals"]?.().catch(() => 18),
    ]);
    return { name: String(name ?? "Unknown"), symbol: String(symbol ?? "?"), decimals: Number(decimals ?? 18) };
  } catch {
    return null;
  }
}

/** Try ETH, BASE, and BSC in parallel; return the first chain with a real contract there. */
export async function resolveEvmTokenOnchain(address: string): Promise<OnchainEvmToken | null> {
  const chains: Array<"ETH" | "BASE" | "BSC"> = ["ETH", "BASE", "BSC"];
  const results = await Promise.all(
    chains.map(async (chain) => {
      const rpcUrl = process.env[RPC_ENV[chain]];
      if (!rpcUrl) return null;
      const meta = await readErc20Metadata(rpcUrl, address);
      return meta ? { chain, ...meta } : null;
    })
  );
  return results.find((r): r is OnchainEvmToken => r !== null) ?? null;
}
