import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import {
  usersTable,
  walletsTable,
  tradesTable,
  signalsTable,
} from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { getChainBalance, getNativeTokenPrice, CHAIN_SYMBOLS } from "../services/chainPrice";
import { logger } from "../lib/logger";
import { isAdmin } from "../lib/isAdmin";

export async function getOrCreateUser(telegramId: number, ctx: Context) {
  let user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) {
    const rows = await db
      .insert(usersTable)
      .values({
        telegramId,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        activeChain: "SOL",
      })
      .returning();
    user = rows[0];
  }
  return user ?? null;
}

export async function renderDashboard(
  ctx: Context,
  edit = false
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  try {
    const user = await getOrCreateUser(telegramId, ctx);
    if (!user) return;

    const chain = user.activeChain;
    const symbol = CHAIN_SYMBOLS[chain] ?? chain;

    const wallet = await db.query.walletsTable.findFirst({
      where: and(
        eq(walletsTable.userId, user.id),
        eq(walletsTable.chain, chain),
        eq(walletsTable.isActive, true)
      ),
    });

    const walletDisplay = wallet?.address
      ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
      : "Tap 💼 to connect";
    const balance = wallet?.address
      ? await getChainBalance(chain, wallet.address)
      : "0.0000";

    const [tradeRow] = await db
      .select({ c: count() })
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.userId, user.id),
          eq(tradesTable.status, "CONFIRMED")
        )
      );
    const [sigRow] = await db
      .select({ c: count() })
      .from(signalsTable)
      .where(eq(signalsTable.userId, user.id));

    const price = await getNativeTokenPrice(chain);
    const snipeStatus = user.autoSnipe ? "🟢 ON" : "🔴 OFF";
    const scannerStatus = user.scannerActive ? "🟢 Active" : "🔴 Inactive";
    const autoSnipeLabel = user.autoSnipe ? "🤖 Auto-Snipe 🟢" : "🤖 Auto-Snipe 🔴";

    const text = [
      `⚡ <b>QUANTREX</b> | 🌐 Active Chain: <b>${chain}</b>`,
      `—`,
      `💼 Wallet: <code>${walletDisplay}</code>`,
      `💰 Balance: <b>${balance} ${symbol}</b>`,
      `🤖 Auto-Snipe: <b>${snipeStatus}</b>`,
      `📈 Open Trades: <b>${tradeRow?.c ?? 0}</b>`,
      `📡 Scanner: <b>${scannerStatus}</b>`,
      `🎯 Signals Sent: <b>${sigRow?.c ?? 0}</b>`,
      `💲 ${symbol} Price: <b>$${price}</b>`,
      `—`,
      `Send any CA (<i>Solana base58</i> or <i>EVM 0x...</i>) to analyze it instantly.`,
      `Use the menu below to scan, snipe, and track trades.`,
    ].join("\n");

    const adminRow = isAdmin(telegramId)
      ? [[Markup.button.callback("📊 Bot Stats", "bot_stats"), Markup.button.callback("❓ Help & Guide", "help_guide")]]
      : [[Markup.button.callback("❓ Help & Guide", "help_guide")]];
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("💰 Buy", "prompt_buy"),
        Markup.button.callback("📤 Sell", "prompt_sell"),
      ],
      
      [
        Markup.button.callback("🔍 New Runners", "new_runners"),
        Markup.button.callback("🔥 Trending", "trending"),
      ],
  
      [
        Markup.button.callback("🌱 PumpFun / Moonshot Snipe", "pumpfun"),
        Markup.button.callback("📋 Previous Signals", "prev_signals"),
      ],
      [
        Markup.button.callback("💼 Wallet Manager", "wallet_manager"),
        Markup.button.callback("🔄 Copy-Trade", "copy_trade"),
      ],
      [
        Markup.button.callback("📡 Group Scanner", "group_scanner"),
        Markup.button.callback("📊 PnL Center", "pnl_center"),
      ],
      [
        Markup.button.callback("📉 My Trades", "my_trades"),
        Markup.button.callback(autoSnipeLabel, "auto_snipe"),
      ],
      [
        Markup.button.callback("⚙️ Settings", "settings"),
        Markup.button.callback("⚗️ Filters", "filters"),
      ],
      ...adminRow,
    ]);

    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...keyboard });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", ...keyboard });
    }
  } catch (err) {
    logger.error({ err }, "renderDashboard failed");
    if (!edit) {
      await ctx.reply("⚠️ Dashboard unavailable — check DB connection.");
    }
  }
}
