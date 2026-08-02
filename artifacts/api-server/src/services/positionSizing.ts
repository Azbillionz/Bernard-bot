/**
 * Position sizing — computes the actual buy amount for auto-executed buys
 * (auto-snipe, manual-snipe "Start"), based on the user's configured mode:
 *   "fixed"   → always the same native-token amount, regardless of balance
 *   "percent" → a % of current wallet balance, so buy size scales with
 *               how funded the wallet is (leaves a small gas buffer)
 *
 * NOT used for explicit manual buys (Buy 0.1 / Buy 0.5 / Buy Custom) —
 * those amounts are exactly what the user tapped, on purpose.
 */

const GAS_BUFFER_NATIVE: Record<string, number> = {
  SOL: 0.01,
  ETH: 0.003,
  BASE: 0.003,
  BSC: 0.003,
};

export interface PositionSizeConfig {
  buySizeMode: string; // "fixed" | "percent"
  autoBuyAmountNative: string;
  positionSizePercent: number;
}

export function computeBuyAmount(
  config: PositionSizeConfig | undefined,
  chain: string,
  currentBalance: number
): number {
  const mode = config?.buySizeMode ?? "fixed";

  if (mode !== "percent") {
    const fixed = parseFloat(config?.autoBuyAmountNative ?? "0.1");
    return Number.isFinite(fixed) && fixed > 0 ? fixed : 0.1;
  }

  const buffer = GAS_BUFFER_NATIVE[chain] ?? 0.01;
  const usable = Math.max(currentBalance - buffer, 0);
  const percent = Math.min(Math.max(config?.positionSizePercent ?? 10, 1), 100);
  const amount = (usable * percent) / 100;
  return Number(amount.toFixed(6));
}
