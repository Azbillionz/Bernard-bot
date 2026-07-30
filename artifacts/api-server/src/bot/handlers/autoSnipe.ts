import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, walletsTable, sniperConfigsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getChainBalance } from "../../services/chainPrice";
import { safeReply } from "../../lib/ctxHelper";
import { startPumpfunListener, stopPumpfunListener, isPumpfunListenerActive } from "./pumpfun";

async function renderAutoSnipeScreen(ctx: Context, telegramId: number): Promise<void> {
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  const isOn = user.autoSnipe ?? false;

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
    balanceWarning = isOn
      ? `\n⚠️ <b>No SOL wallet found!</b>\nGo to 💼 Wallet Manager to create or import one before auto-snipe can execute.`
      : "";
  } else {
    const balance = await getChainBalance("SOL", wallet.address).catch(() => "0");
    balanceDisplay = `${balance} SOL`;
    const balNum = parseFloat(balance);
    const buyNum = parseFloat(autoBuyAmount);
    if (isOn && balNum < buyNum) {
      balanceWarning = `\n⚠️ <b>Insufficient balance!</b>\nYour wallet has <b>${balance} SOL</b> but auto-buy is set to <b>${autoBuyAmount} SOL</b>.\nDeposit SOL before snipes will execute.`;
    }
  }

  const listenerRunning = isPumpfunListenerActive(user.id);
  const statusLine = isOn
    ? `🟢 <b>Auto-Snipe is ON</b> — listener ${listenerRunning ? "active" : "starting"}, watching for new launches`
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
    isOn
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
          isOn ? "⏹ Turn OFF Auto-Snipe" : "▶️ Turn ON Auto-Snipe",
          "auto_snipe_toggle"
        ),
      ],
      [
        Markup.button.callback("💳 Deposit SOL", "deposit:SOL"),
        Markup.button.callback("⚗️ Filters", "filters"),
      ],
      [Markup.button.callback("🎯 Manual Snipe", "manual_snipe")],
      [Markup.button.callback("⬅️ Dashboard", "dashboard")],
    ]),
  });
}

/**
 * Opens the Auto-Snipe screen — READ ONLY, never flips the setting.
 * If Auto-Snipe is already on but the listener isn't running for any
 * reason (e.g. right after a deploy, before the boot-time auto-resume
 * runs), this makes sure it's actually running rather than just claiming
 * to be. Just viewing this screen must never turn anything off.
 */
export async function handleAutoSnipe(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  if (user.autoSnipe && !isPumpfunListenerActive(user.id)) {
    const chatId = ctx.chat?.id ?? telegramId;
    startPumpfunListener(user.id, telegramId, chatId);
  }

  await renderAutoSnipeScreen(ctx, telegramId);
}

/**
 * The actual ON/OFF flip — only reachable via the explicit
 * "Turn ON/OFF Auto-Snipe" button inside the screen, never by just
 * opening or re-opening the Auto-Snipe menu.
 */
export async function handleAutoSnipeToggle(ctx: Context): Promise<void> {
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

  const chatId = ctx.chat?.id ?? telegramId;
  if (newState) {
    startPumpfunListener(user.id, telegramId, chatId);
  } else {
    stopPumpfunListener(user.id);
  }

  await renderAutoSnipeScreen(ctx, telegramId);
}
