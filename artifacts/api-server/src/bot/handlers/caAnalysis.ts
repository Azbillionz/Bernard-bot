/**
 * CA Analysis — triggered by text input or inline "analyze:" callback.
 *
 * EVM chain is NEVER guessed from the user's active wallet — a 0x address
 * looks identical on every EVM chain, so we resolve the real chain from
 * whichever data source actually finds the token (DexScreener's chainId,
 * GeckoTerminal's network, or on-chain bytecode presence), trying
 * ETH/BASE/BSC in parallel. This means pasting any CA works regardless of
 * which chain the user currently has selected.
 *
 * Waterfall (SOL):  DexScreener → GeckoTerminal → PumpFun bonding curve
 *                    → generic on-chain metadata (any SPL token) → not found
 * Waterfall (EVM):  DexScreener (all chains) → GeckoTerminal (ETH/BASE/BSC
 *                    in parallel) → on-chain bytecode+ERC20 read (ETH/BASE/BSC
 *                    in parallel) → not found
 *
 * Message format includes an auto-generated Score/Signal/Potential block
 * (see ../../services/tokenScore.ts) — a transparent formula built from
 * real liquidity/volume/momentum/security data, not a third-party opinion.
 *
 * Every result card also gets: 📊 Track PnL (live price + entry P&L),
 * 📈 Chart (external link, when a pair/pool/pump.fun page exists),
 * 🔍 RugCheck (re-runs just the security scan standalone), and 🎯 Snipe
 * (jumps to the Confirm-Snipe preview instead of buying immediately).
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getPairsByToken, type TokenPair } from "../../services/dexscreener";
import { searchGeckoToken, type GeckoPool } from "../../services/geckoTerminal";
import {
  getPumpFunToken,
  getSolTokenOnchainMetadata,
  type PumpFunToken,
} from "../../services/pumpfunApi";
import { resolveEvmTokenOnchain, type OnchainEvmToken } from "../../services/evmOnchain";
import { getNativeTokenPrice } from "../../services/chainPrice";
import { checkEvmToken, checkSolanaToken } from "../../services/goplus";
import { scoreToken, formatScoreBlock, type ScoreInput } from "../../services/tokenScore";
import { db } from "@workspace/db";
import { usersTable, signalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
// Base58 Solana: 32-44 chars to catch PumpFun mints too
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Different sources spell chain names differently — normalize to our codes.
const DEXSCREENER_CHAIN_MAP: Record<string, "ETH" | "BASE" | "BSC"> = {
  ethereum: "ETH",
  base: "BASE",
  bsc: "BSC",
};
const GECKO_CHAIN_MAP: Record<string, "ETH" | "BASE" | "BSC"> = {
  eth: "ETH",
  base: "BASE",
  bsc: "BSC",
};

export function detectCAType(text: string): "EVM" | "SOL" | null {
  const trimmed = text.trim();
  if (EVM_RE.test(trimmed)) return "EVM";
  if (SOL_RE.test(trimmed)) return "SOL";
  return null;
}

export type EvmSecurity = Awaited<ReturnType<typeof checkEvmToken>>;
export type SolSecurity = Awaited<ReturnType<typeof checkSolanaToken>>;

export function countSecurityRisks(caType: "EVM" | "SOL", security: EvmSecurity | SolSecurity): number {
  if (caType === "EVM") {
    const s = security as EvmSecurity;
    return (
      (s.isHoneypot ? 1 : 0) +
      (s.isMintable ? 1 : 0) +
      (s.isBlacklisted ? 1 : 0) +
      (s.buyTax > 10 ? 1 : 0) +
      (s.sellTax > 10 ? 1 : 0)
    );
  }
  const s = security as SolSecurity;
  return (s.hasMintAuthority ? 1 : 0) + (s.hasFreezeAuthority ? 1 : 0) + (s.isBlacklisted ? 1 : 0);
}

export function securityLinesFor(caType: "EVM" | "SOL", security: EvmSecurity | SolSecurity): string[] {
  if (caType === "EVM") {
    const s = security as EvmSecurity;
    return [
      `🕵️ <b>Security (GoPlus)</b>`,
      `  🍯 Honeypot: <b>${s.isHoneypot ? "⚠️ YES" : "✅ NO"}</b>`,
      `  💸 Buy Tax: <b>${s.buyTax.toFixed(1)}%</b> | Sell Tax: <b>${s.sellTax.toFixed(1)}%</b>`,
      `  🖨 Mintable: <b>${s.isMintable ? "⚠️ YES" : "✅ NO"}</b>`,
      `  🚫 Blacklist: <b>${s.isBlacklisted ? "⚠️ YES" : "✅ NO"}</b>`,
    ];
  }
  const s = security as SolSecurity;
  return [
    `🕵️ <b>Security (GoPlus)</b>`,
    `  🖨 Mint Authority: <b>${s.hasMintAuthority ? "⚠️ ACTIVE" : "✅ REVOKED"}</b>`,
    `  🧊 Freeze Authority: <b>${s.hasFreezeAuthority ? "⚠️ ACTIVE" : "✅ REVOKED"}</b>`,
    `  🚫 Blacklist: <b>${s.isBlacklisted ? "⚠️ YES" : "✅ NO"}</b>`,
  ];
}

function sign(n?: number): string {
  if (n === undefined || n === null) return "0.00";
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtAge(ageMinutes?: number): string {
  if (ageMinutes === undefined) return "N/A";
  if (ageMinutes < 60) return `${Math.round(ageMinutes)} min`;
  if (ageMinutes < 1440) return `${(ageMinutes / 60).toFixed(1)} hr`;
  return `${(ageMinutes / 1440).toFixed(1)} d`;
}
interface ExtraButtonsOpts {
  chartUrl?: string;
  /** Encoded as "SOL::<ca>" or "EVM:<CHAIN>:<ca>" — used by both the
   *  rugcheck: and snipe_confirm: callbacks (same resolved-chain target). */
  rugcheckTarget?: string;
}

