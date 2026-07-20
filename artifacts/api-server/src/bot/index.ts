/**
 * QUANTREXTRADING_BOT — Telegraf bot initialization.
 * Registers all command, callback_query, and text handlers.
 * Uses webhook in production, polling in development.
 */

import { Telegraf, type Context } from "telegraf";
import type IORedis from "ioredis";
import { logger } from "../lib/logger";
import { renderDashboard } from "./dashboard";
import { handleNewRunners } from "./handlers/newRunners";
import { handleTrending } from "./handlers/trending";
import { handlePumpfun } from "./handlers/pumpfun";
import { handlePreviousSignals } from "./handlers/previousSignals";
import {
  handleWalletManager,
  handleGenerateWallet,
  handleImportWallet,
  processImportedKey,
  getPendingImport,
} from "./handlers/walletManager";
import {
  handleCopyTrade,
  handleAddCopyTarget,
  handleRemoveCopyTarget,
  processCopyTradeInput,
  isPendingCopyTradeAdd,
} from "./handlers/copyTrade";
import { handleGroupScanner, scanGroupMessage } from "./handlers/groupScanner";
import { handlePnlCenter } from "./handlers/pnlCenter";
import { handleMyTrades } from "./handlers/myTrades";
import { handleAutoSnipe } from "./handlers/autoSnipe";
import { handleSettings, handleSetChain } from "./handlers/settings";
import {
  handleFilters,
  handleSetFilter,
  handleToggleHoneypot,
  processFilterInput,
  getPendingFilter,
} from "./handlers/filters";
import { handleBotStats } from "./handlers/botStats";
import { handleHelpGuide } from "./handlers/helpGuide";
import {
  handleCAAnalysis,
  handleAnalyzeCallback,
  detectCAType,
} from "./handlers/caAnalysis";
import {
  handleBuy,
  handleBuyCustom,
  handleSell,
  processCustomBuyAmount,
  getPendingCustomBuy,
} from "./handlers/trade";
import { initMessageQueue } from "../workers/messageQueue";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export function createBot(redis: IORedis | null): Telegraf<Context> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const bot = new Telegraf<Context>(token);

  // Initialize BullMQ message queue
  initMessageQueue(bot, redis);

  // ── Global error handler ────────────────────────────────────────────────
  bot.catch((err, ctx) => {
    logger.error({ err, update: ctx.update }, "Bot handler error");
    ctx.reply("⚠️ An internal error occurred. Please try again.").catch(() => {});
  });

  // ── Commands ────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    await renderDashboard(ctx, false);
  });

  bot.command("menu", async (ctx) => {
    await renderDashboard(ctx, false);
  });

  // ── Callback Queries ────────────────────────────────────────────────────
  bot.action("dashboard", (ctx) => renderDashboard(ctx, true));
  bot.action("new_runners", handleNewRunners);
  bot.action("trending", handleTrending);
  bot.action("pumpfun", handlePumpfun);
  bot.action("prev_signals", handlePreviousSignals);
  bot.action("wallet_manager", handleWalletManager);
  bot.action("copy_trade", handleCopyTrade);
  bot.action("add_copy_target", handleAddCopyTarget);
  bot.action("group_scanner", handleGroupScanner);
  bot.action("pnl_center", handlePnlCenter);
  bot.action("my_trades", handleMyTrades);
  bot.action("auto_snipe", handleAutoSnipe);
  bot.action("settings", handleSettings);
  bot.action("filters", handleFilters);
  bot.action("toggle_honeypot", handleToggleHoneypot);
  bot.action("bot_stats", handleBotStats);
  bot.action("help_guide", handleHelpGuide);

  // Dynamic actions with parameters
  bot.action(/^analyze:(.+)$/, async (ctx) => {
    const ca = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleAnalyzeCallback(ctx, ca);
  });

  bot.action(/^gen_wallet:(.+)$/, async (ctx) => {
    const chain = (ctx.match as RegExpMatchArray)[1] ?? "SOL";
    await handleGenerateWallet(ctx, chain);
  });

  bot.action(/^import_wallet:(.+)$/, async (ctx) => {
    const chain = (ctx.match as RegExpMatchArray)[1] ?? "SOL";
    await handleImportWallet(ctx, chain);
  });

  bot.action(/^rm_ct:(\d+)$/, async (ctx) => {
    const id = parseInt((ctx.match as RegExpMatchArray)[1] ?? "0", 10);
    await handleRemoveCopyTarget(ctx, id);
  });

  bot.action(/^set_chain:(.+)$/, async (ctx) => {
    const chain = (ctx.match as RegExpMatchArray)[1] ?? "SOL";
    await handleSetChain(ctx, chain);
  });

  bot.action(/^set_filter:(.+)$/, async (ctx) => {
    const field = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleSetFilter(ctx, field);
  });

  bot.action(/^buy:([^:]+):([0-9.]+)$/, async (ctx) => {
    const [, ca, amount] = ctx.match as RegExpMatchArray;
    await handleBuy(ctx, ca ?? "", amount ?? "0");
  });

  bot.action(/^buy_custom:(.+)$/, async (ctx) => {
    const ca = (ctx.match as RegExpMatchArray)[1] ?? "";
    await handleBuyCustom(ctx, ca);
  });

  bot.action(/^sell:([^:]+):(\d+)$/, async (ctx) => {
    const [, ca, pct] = ctx.match as RegExpMatchArray;
    await handleSell(ctx, ca ?? "", pct ?? "100");
  });

  // ── Text handler — CA detection + multi-step flows ──────────────────────
  bot.on("text", async (ctx) => {
    const text = ctx.message.text.trim();
    const telegramId = ctx.from.id;

    // Multi-step flow: wallet key import
    const importState = getPendingImport(telegramId);
    if (importState) {
      await processImportedKey(ctx, text);
      return;
    }

    // Multi-step flow: copy-trade target
    if (isPendingCopyTradeAdd(telegramId)) {
      await processCopyTradeInput(ctx, text);
      return;
    }

    // Multi-step flow: filter update
    const filterState = getPendingFilter(telegramId);
    if (filterState) {
      await processFilterInput(ctx, text);
      return;
    }

    // Multi-step flow: custom buy amount
    const customBuy = getPendingCustomBuy(telegramId);
    if (customBuy) {
      await processCustomBuyAmount(ctx, text);
      return;
    }

    // CA detection
    const caType = detectCAType(text);
    if (caType) {
      await handleCAAnalysis(ctx, text);
      return;
    }

    // Group scanner
    if (ctx.chat.type !== "private") {
      const user = await db.query.usersTable.findFirst({
        where: eq(usersTable.telegramId, telegramId),
      });
      if (user?.scannerActive) {
        await scanGroupMessage(text, user.id, ctx.chat.id, user.activeChain);
      }
      return;
    }

    // Default: show menu
    await renderDashboard(ctx, false);
  });

  return bot;
}

export async function launchBot(bot: Telegraf<Context>): Promise<void> {
  const webhookDomain = process.env["WEBHOOK_DOMAIN"];
  const port = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : undefined;

  if (webhookDomain && port) {
    const webhookPath = "/api/webhook";
    logger.info({ webhookDomain, webhookPath }, "Launching bot with webhook");
    await bot.telegram.setWebhook(`${webhookDomain}${webhookPath}`);
    logger.info("Webhook set — Express will handle updates");
  } else {
    logger.info("Launching bot with long-polling (no WEBHOOK_DOMAIN set)");
    // Delete any existing webhook before polling
    await bot.telegram.deleteWebhook();
    void bot.launch({ dropPendingUpdates: true });
  }
}
