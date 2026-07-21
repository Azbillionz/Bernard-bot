import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, walletsTable, sniperConfigsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getChainBalance } from "../../services/chainPrice";
import { safeReply } from "../../lib/ctxHelper";

export async function handleAutoSnipe(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  const newState = !user.autoSnipe;
  await db
    .update(usersTable)
    .set({ autoSnipe: newState, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));

  // Check SOL wallet + balance to warn if funds are missing
  const wallet = await db.query.walletsTable.findFirst({
    where: and(
      eq(walletsTable.userId, user.id),
      eq(walletsTable.chain, "SOL"),
      eq(walletsTable.isActive, true)
    ),
  });

  const config = await db.query.sniperConfigsTable.findFirst({
    where: eq(sniperConfigsTable.userId, user.id),
  });

  const autoBuyAmount = config?.autoBuyAmountNative ?? "0.1";
  const slippage = config ? `${(config.slippageBps / 100).toFixed(1)}%` : "15%";
  const minLiq = config?.minLiquidityUsd ?? "0";

  let balanceWarning = "";
  let balanceDisplay = "—";

  if (!wallet) {
    balanceWarning = newState
      ? `\n⚠️ <b>No SOL wallet found!</b>\nGo to 💼 Wallet Manager to create or import one before auto-snipe can execute.`
      : "";
  } else {
    const balance = await getChainBalance("SOL", wallet.address).catch(() => "0");
    balanceDisplay = `${balance} SOL`;
    const balNum = parseFloat(balance);
    const buyNum = parseFloat(autoBuyAmount);
    if (newState && balNum < buyNum) {
      balanceWarning = `\n⚠️ <b>Insufficient balance!</b>\nYour wallet has <b>${balance} SOL</b> but auto-buy is set to <b>${autoBuyAmount} SOL</b>.\nDeposit SOL before snipes will execute.`;
    }
  }

  const statusLine = newState
    ? `🟢 <b>Auto-Snipe is ON</b>`
    : `🔴 <b>Auto-Snipe is OFF</b>`;

  const text = [
    `🤖 <b>Auto-Snipe</b>`,
    `—`,
    statusLine,
    ``,
    `⚙️ <b>Current Settings:</b>`,
    `  🛒 Buy Amount: <b>${autoBuyAmount} SOL</b>`,
    `  📉 Slippage: <b>${slippage}</b>`,
    `  💧 Min Liquidity: <b>$${minLiq}</b>`,
    `  💼 Wallet Balance: <b>${balanceDisplay}</b>`,
    balanceWarning,
    ``,
    newState
      ? `The bot will automatically snipe new PumpFun launches matching your filters.`
      : `Enable to auto-buy new launches from the PumpFun listener.`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  await safeReply(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          newState ? "⏹ Turn OFF Auto-Snipe" : "▶️ Turn ON Auto-Snipe",
          "auto_snipe"
        ),
      ],
      [
        Markup.button.callback("💳 Deposit SOL", "deposit:SOL"),
        Markup.button.callback("⚗️ Filters", "filters"),
      ],
      [Markup.button.callback("⬅️ Dashboard", "dashboard")],
    ]),
  });
}
