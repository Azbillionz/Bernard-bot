import type { Context } from "telegraf";
import { Markup } from "telegraf";

export async function handleHelpGuide(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();

  await ctx.editMessageText(
    [
            `❓ <b>MAESTRO_BOT — Help & Guide</b>`,
      `—`,
      `<b>🔍 Scanning</b>`,
      `• Send any CA (Solana base58 / EVM 0x...) to instantly analyze it`,
      `• <b>New Runners</b> — latest boosted tokens from DexScreener`,
      `• <b>Trending</b> — top 5 by volume from DexScreener`,
      ``,
      `<b>🌱 Sniping</b>`,
      `• <b>PumpFun / Moonshot Snipe</b> — WSS listener for new token launches`,
      `• <b>Auto-Snipe</b> — auto-buys new tokens matching your filter thresholds`,
      `• <b>Filters</b> — set min liquidity, max tax, honeypot checks, slippage`,
      ``,
      `<b>💼 Wallets</b>`,
      `• Generate or import wallets for SOL, ETH, BASE, BSC`,
      `• Keys encrypted with AES-256-GCM — non-custodial`,
      `• Switch chains in ⚙️ Settings`,
      ``,
      `<b>📊 Trading</b>`,
      `• Buy 0.1 / 0.5 / Custom — tap after analyzing a CA`,
      `• Sell 50% / 100% — partial or full exit`,
      `• All trades pre-simulated before execution`,
      `• 1% platform fee applied on every swap`,
      ``,
      `<b>🔒 MEV Protection</b>`,
      `• SOL: Jito Block Engine bundles`,
      `• EVM: Flashbots Private RPC`,
      ``,
      `<b>🔄 Copy-Trade</b>`,
      `• Add target wallets to mirror their on-chain activity`,
      ``,
      `<b>📡 Group Scanner</b>`,
      `• Auto-detect CAs in group messages`,
      ``,
            `<b>Support:</b> @your_support_handle`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}
