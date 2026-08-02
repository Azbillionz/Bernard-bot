import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, sniperConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { safeReply } from "../../lib/ctxHelper";
import { registerPendingClearer } from "../../lib/pendingFlows";

// Pending filter edit state
const pendingFilter = new Map<number, { field: string }>();
registerPendingClearer((id) => pendingFilter.delete(id));

export function getPendingFilter(telegramId: number): { field: string } | null {
  return pendingFilter.get(telegramId) ?? null;
}

export async function processFilterInput(ctx: Context, input: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const state = pendingFilter.get(telegramId);
  if (!state) return;
  pendingFilter.delete(telegramId);

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const existing = await db.query.sniperConfigsTable.findFirst({
    where: eq(sniperConfigsTable.userId, user.id),
  });

  const value = input.trim();
  const num = parseFloat(value);
  const updates: Partial<typeof sniperConfigsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  let error: string | null = null;

  switch (state.field) {
    case "min_liq": {
      if (!Number.isFinite(num) || num < 0) {
        error = "Send a number ≥ 0, e.g. <b>5000</b> for $5,000.";
      } else {
        updates.minLiquidityUsd = String(Math.round(num));
      }
      break;
    }
    case "max_tax": {
      const tax = parseInt(value, 10);
      if (!Number.isFinite(tax) || tax < 0 || tax > 100) {
        error = "Send a whole number between 0 and 100, e.g. <b>10</b>.";
      } else {
        updates.maxTaxPercent = tax;
      }
      break;
    }
    case "buy_amount": {
      // Bounded + ≤6 decimals so quick-buy callback data (buy:MINT:AMT)
      // always stays under Telegram's 64-byte limit.
      if (!Number.isFinite(num) || num <= 0) {
        error = "Send a positive amount, e.g. <b>0.1</b>.";
      } else if (num > 1000) {
        error = "Maximum auto-buy amount is <b>1000</b>.";
      } else {
        updates.autoBuyAmountNative = String(Number(num.toFixed(6)));
      }
      break;
    }
    case "position_percent": {
      const pct = parseInt(value, 10);
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
        error = "Send a whole percent 1-100, e.g. <b>10</b> for 10% of your balance per buy.";
      } else {
        updates.positionSizePercent = pct;
      }
      break;
    }
    case "slippage": {
      if (!Number.isFinite(num) || num < 0.1 || num > 100) {
        error = "Send a percent between 0.1 and 100, e.g. <b>10</b>.";
      } else {
        updates.slippageBps = Math.round(num * 100);
      }
      break;
    }
    case "min_mc": {
      if (!Number.isFinite(num) || num < 0) {
        error = "Send a number ≥ 0, e.g. <b>10000</b> for $10,000. Send <b>0</b> to disable this filter.";
      } else {
        updates.minMarketCapUsd = String(Math.round(num));
      }
      break;
    }
    case "max_mc": {
      if (!Number.isFinite(num) || num < 0) {
        error = "Send a number ≥ 0, e.g. <b>5000000</b> for $5M. Send <b>0</b> for no maximum.";
      } else {
        updates.maxMarketCapUsd = String(Math.round(num));
      }
      break;
    }
    case "min_age": {
      const mins = parseInt(value, 10);
      if (!Number.isFinite(mins) || mins < 0) {
        error = "Send whole minutes ≥ 0, e.g. <b>5</b>. Send <b>0</b> to disable this filter.";
      } else {
        updates.minAgeMinutes = mins;
      }
      break;
    }
    case "max_age": {
      const mins = parseInt(value, 10);
      if (!Number.isFinite(mins) || mins < 0) {
        error = "Send whole minutes ≥ 0, e.g. <b>1440</b> for 1 day. Send <b>0</b> for no maximum.";
      } else {
        updates.maxAgeMinutes = mins;
      }
      break;
    }
    case "min_buy_ratio": {
      const pct = parseInt(value, 10);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        error = "Send a whole percent 0-100, e.g. <b>55</b> for 55% buys. Send <b>0</b> to disable this filter.";
      } else {
        updates.minBuyRatioPercent = pct;
      }
      break;
    }
  }

  if (error) {
    await ctx.reply(`❌ Invalid value. ${error}`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("⚗️ Back to Filters", "filters")]]),
    });
    return;
  }

  if (existing) {
    await db.update(sniperConfigsTable).set(updates).where(eq(sniperConfigsTable.userId, user.id));
  } else {
    await db.insert(sniperConfigsTable).values({ userId: user.id, ...updates });
  }

  await ctx.reply(
    `✅ Filter updated! Tap below to view all settings.`,
    Markup.inlineKeyboard([[Markup.button.callback("⚗️ View Filters", "filters")]])
  );
}

export async function handleFilters(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  let config = await db.query.sniperConfigsTable.findFirst({
    where: eq(sniperConfigsTable.userId, user.id),
  });

  if (!config) {
    const [inserted] = await db.insert(sniperConfigsTable).values({ userId: user.id }).returning();
    config = inserted;
  }
  if (!config) return;

  const honeypotIcon = config.honeypotCheck ? "🟢" : "🔴";
  const mcRange =
    config.minMarketCapUsd !== "0" || config.maxMarketCapUsd !== "0"
      ? `$${config.minMarketCapUsd === "0" ? "0" : config.minMarketCapUsd} – ${config.maxMarketCapUsd === "0" ? "∞" : `$${config.maxMarketCapUsd}`}`
      : "Any (disabled)";
  const ageRange =
    config.minAgeMinutes > 0 || config.maxAgeMinutes > 0
      ? `${config.minAgeMinutes}m – ${config.maxAgeMinutes > 0 ? `${config.maxAgeMinutes}m` : "∞"}`
      : "Any (disabled)";
  const buyRatio = config.minBuyRatioPercent > 0 ? `≥${config.minBuyRatioPercent}% buys` : "Any (disabled)";
  const isPercentMode = config.buySizeMode === "percent";
  const sizingLine = isPercentMode
    ? `${config.positionSizePercent}% of wallet balance per buy`
    : `${config.autoBuyAmountNative} native token (fixed)`;

  await safeReply(
    ctx,
    [
      `⚗️ <b>Snipe Filters</b>`,
      `—`,
      `Used by both 🤖 Auto-Snipe and 🎯 Manual Snipe checks.`,
      `—`,
      `💧 Min Liquidity: <b>$${config.minLiquidityUsd}</b>`,
      `🏦 Market Cap Range: <b>${mcRange}</b>`,
      `⏱ Age Range: <b>${ageRange}</b>`,
      `🔄 Min Buy Ratio: <b>${buyRatio}</b>`,
      `💸 Max Tax: <b>${config.maxTaxPercent}%</b>`,
      `${honeypotIcon} Honeypot Check: <b>${config.honeypotCheck ? "ON" : "OFF"}</b>`,
      `🛒 Position Size: <b>${sizingLine}</b>`,
      `📉 Slippage: <b>${(config.slippageBps / 100).toFixed(1)}%</b>`,
      `—`,
      `Tap a setting below to update it.`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("💧 Min Liquidity", "set_filter:min_liq"),
          Markup.button.callback("💸 Max Tax", "set_filter:max_tax"),
        ],
        [
          Markup.button.callback("🏦 Min MCap", "set_filter:min_mc"),
          Markup.button.callback("🏦 Max MCap", "set_filter:max_mc"),
        ],
        [
          Markup.button.callback("⏱ Min Age", "set_filter:min_age"),
          Markup.button.callback("⏱ Max Age", "set_filter:max_age"),
        ],
        [Markup.button.callback("🔄 Min Buy Ratio %", "set_filter:min_buy_ratio")],
        [
          Markup.button.callback(
            isPercentMode ? "🔀 Switch to Fixed Amount" : "🔀 Switch to % of Balance",
            "toggle_buy_mode"
          ),
        ],
        isPercentMode
          ? [Markup.button.callback("🛒 Position %", "set_filter:position_percent")]
          : [Markup.button.callback("🛒 Buy Amount", "set_filter:buy_amount")],
        [Markup.button.callback("📉 Slippage %", "set_filter:slippage")],
        [
          Markup.button.callback(
            config.honeypotCheck ? "🔴 Disable Honeypot Check" : "🟢 Enable Honeypot Check",
            "toggle_honeypot"
          ),
        ],
        [
          Markup.button.callback("🎯 Manual Snipe", "manual_snipe"),
          Markup.button.callback("⬅️ Dashboard", "dashboard"),
        ],
      ]),
    }
  );
}

export async function handleSetFilter(ctx: Context, field: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  pendingFilter.set(telegramId, { field });

  const prompts: Record<string, string> = {
    min_liq: "💧 Send minimum liquidity in USD (e.g. <b>5000</b> = $5,000):",
    max_tax: "💸 Send max buy+sell tax percent (e.g. <b>10</b> = 10%):",
    buy_amount: "🛒 Send auto-buy amount in native token (e.g. <b>0.1</b> SOL):",
    position_percent: "🛒 Send % of wallet balance to use per buy (e.g. <b>10</b> for 10%):",
    slippage: "📉 Send slippage percent (e.g. <b>10</b> for 10%):",
    min_mc: "🏦 Send minimum market cap in USD (e.g. <b>10000</b>). Send <b>0</b> to disable:",
    max_mc: "🏦 Send maximum market cap in USD (e.g. <b>5000000</b>). Send <b>0</b> for no maximum:",
    min_age: "⏱ Send minimum token age in minutes (e.g. <b>5</b>). Send <b>0</b> to disable:",
    max_age: "⏱ Send maximum token age in minutes (e.g. <b>1440</b> for 1 day). Send <b>0</b> for no maximum:",
    min_buy_ratio: "🔄 Send minimum buy ratio percent, e.g. <b>55</b> means at least 55% of trades must be buys. Send <b>0</b> to disable:",
  };

  await ctx.reply(prompts[field] ?? "Send new value:", { parse_mode: "HTML" });
}

export async function handleToggleHoneypot(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const config = await db.query.sniperConfigsTable.findFirst({
    where: eq(sniperConfigsTable.userId, user.id),
  });

  if (config) {
    await db
      .update(sniperConfigsTable)
      .set({ honeypotCheck: !config.honeypotCheck, updatedAt: new Date() })
      .where(eq(sniperConfigsTable.userId, user.id));
  }

  await handleFilters(ctx);
}

export async function handleToggleBuyMode(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const config = await db.query.sniperConfigsTable.findFirst({
    where: eq(sniperConfigsTable.userId, user.id),
  });

  const newMode = config?.buySizeMode === "percent" ? "fixed" : "percent";

  if (config) {
    await db
      .update(sniperConfigsTable)
      .set({ buySizeMode: newMode, updatedAt: new Date() })
      .where(eq(sniperConfigsTable.userId, user.id));
  } else {
    await db.insert(sniperConfigsTable).values({ userId: user.id, buySizeMode: newMode });
  }

  await handleFilters(ctx);
}
