const BASE_URL =
  process.env["GOPLUS_SECURITY_API"] ?? "https://api.gopluslabs.io/api/v1";

export interface EvmSecurityResult {
  isHoneypot: boolean;
  buyTax: number;
  sellTax: number;
  isBlacklisted: boolean;
  isMintable: boolean;
  ownerAddress?: string;
}

export interface SolanaSecurityResult {
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  isBlacklisted: boolean;
}

const EVM_CHAIN_IDS: Record<string, string> = {
  ETH: "1",
  BASE: "8453",
  BSC: "56",
};

export async function checkEvmToken(
  chain: string,
  tokenAddress: string
): Promise<EvmSecurityResult> {
  const chainId = EVM_CHAIN_IDS[chain] ?? "1";
  try {
    const res = await fetch(
      `${BASE_URL}/token_security/${chainId}?contract_addresses=${tokenAddress.toLowerCase()}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return defaultEvmResult();
    const data = (await res.json()) as {
      result?: Record<string, Record<string, string>>;
    };
    const r = data.result?.[tokenAddress.toLowerCase()] ?? {};
    return {
      isHoneypot: r["is_honeypot"] === "1",
      buyTax: parseFloat(r["buy_tax"] ?? "0") * 100,
      sellTax: parseFloat(r["sell_tax"] ?? "0") * 100,
      isBlacklisted: r["is_blacklisted"] === "1",
      isMintable: r["is_mintable"] === "1",
      ownerAddress: r["owner_address"],
    };
  } catch {
    return defaultEvmResult();
  }
}

export async function checkSolanaToken(
  mintAddress: string
): Promise<SolanaSecurityResult> {
  try {
    const res = await fetch(
      `${BASE_URL}/solana/token_security?contract_addresses=${mintAddress}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return defaultSolResult();
    const data = (await res.json()) as {
      result?: Record<string, Record<string, boolean | string>>;
    };
    const r = data.result?.[mintAddress] ?? {};
    return {
      hasMintAuthority: Boolean(r["mintAuthority"]),
      hasFreezeAuthority: Boolean(r["freezeAuthority"]),
      isBlacklisted: Boolean(r["isBlacklisted"]),
    };
  } catch {
    return defaultSolResult();
  }
}

function defaultEvmResult(): EvmSecurityResult {
  return {
    isHoneypot: false,
    buyTax: 0,
    sellTax: 0,
    isBlacklisted: false,
    isMintable: false,
  };
}

function defaultSolResult(): SolanaSecurityResult {
  return {
    hasMintAuthority: false,
    hasFreezeAuthority: false,
    isBlacklisted: false,
  };
}
