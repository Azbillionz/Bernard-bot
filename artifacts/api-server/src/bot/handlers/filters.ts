import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, sniperConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Pending filter edit state
const pendingFilter = new Map<number, { field: string }>();

export function getPendingFilter(telegramId: number): { field: string } | null {
  return pendingFilter.get(telegramId) ?? null;
}

export async function processFilterInput(
  ctx: Context,
  input: string
): Promise<void> {
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
  const updates: Partial<typeof sniperConfigsTable.$inferInsert> = {
    updatedAt: new Date(),
  };

  switch (state.field) {
    case "min_liq":
      updates.minLiquidityUsd = value;
      break;
    case "max_tax":
      updates.maxTaxPercent = parseInt(value, 10) || 10;
      break;
    case "buy_amount":
      updates.autoBuyAmountNative = value;
      break;
    case "slippage":
      updates.slippageBps = Math.round((parseFloat(value) / 100) * 10_000);
      break;
  }

  if (existing) {
    await db
      .update(sniperConfigsTable)
      .set(updates)
      .where(eq(sniperConfigsTable.userId, user.id));
  } else {
    await db.insert(sniperConfigsTable).values({ userId: user.id, ...updates });
  }

  await ctx.reply("✅ Filter updated.", {
    ...Markup.inlineKeyboard([
      [Markup.button.callback("⚗️ View Filters", "filters")],
    ]),
  });
}

export async function handleFilters(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  let config = await db.query.sniperConfigsTable.findFirst({
    where: eq(sniperConfigsTable.userId, user.id),
  });

  if (!config) {
    const [inserted] = await db
      .insert(sniperConfigsTable)
      .values({ userId: user.id })
      .returning();
    config = inserted;
  }

  if (!config) return;

  const honeypotIcon = config.honeypotCheck ? "🟢" : "🔴";

  await ctx.editMessageText(
    [
      `⚗️ <b>Auto-Snipe Filters</b>`,
      `—`,
      `💧 Min Liquidity: <b>$${config.minLiquidityUsd}</b>`,
      `💸 Max Tax: <b>${config.maxTaxPercent}%</b>`,
      `${honeypotIcon} Honeypot Check: <b>${config.honeypotCheck ? "ON" : "OFF"}</b>`,
      `🛒 Auto-Buy Amount: <b>${config.autoBuyAmountNative} native</b>`,
      `📉 Slippage: <b>${(config.slippageBps / 100).toFixed(1)}%</b>`,
      `—`,
      `These filters apply to all auto-snipe executions.`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("💧 Min Liq", "set_filter:min_liq"),
          Markup.button.callback("💸 Max Tax", "set_filter:max_tax"),
        ],
        [
          Markup.button.callback("🛒 Buy Amount", "set_filter:buy_amount"),
          Markup.button.callback("📉 Slippage %", "set_filter:slippage"),
        ],
        [
          Markup.button.callback(
            config.honeypotCheck ? "🔴 Disable Honeypot Check" : "🟢 Enable Honeypot Check",
            "toggle_honeypot"
          ),
        ],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}

export async function handleSetFilter(
  ctx: Context,
  field: string
): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  pendingFilter.set(telegramId, { field });

  const prompts: Record<string, string> = {
    min_liq: "Send minimum liquidity in USD (e.g. 5000):",
    max_tax: "Send max buy+sell tax percent (e.g. 10):",
    buy_amount: "Send auto-buy amount in native token (e.g. 0.1):",
    slippage: "Send slippage percent (e.g. 10 for 10%):",
  };

  await ctx.reply(prompts[field] ?? "Send new value:");
}

export async function handleToggleHoneypot(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
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
