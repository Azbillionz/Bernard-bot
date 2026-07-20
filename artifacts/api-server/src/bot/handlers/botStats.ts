import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, tradesTable, signalsTable } from "@workspace/db";
import { count, eq } from "drizzle-orm";

export async function handleBotStats(ctx: Context): Promise<void> {
  await ctx.answerCbQuery("📊 Loading stats...");

  const [userRow] = await db.select({ c: count() }).from(usersTable);
  const [tradeRow] = await db.select({ c: count() }).from(tradesTable);
  const [sigRow] = await db.select({ c: count() }).from(signalsTable);
  const [confirmedRow] = await db
    .select({ c: count() })
    .from(tradesTable)
    .where(eq(tradesTable.status, "CONFIRMED"));
  const [failedRow] = await db
    .select({ c: count() })
    .from(tradesTable)
    .where(eq(tradesTable.status, "FAILED"));

  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  await ctx.editMessageText(
    [
      `📊 <b>Bot Stats — QUANTREXTRADING_BOT</b>`,
      `—`,
      `👥 Total Users: <b>${userRow?.c ?? 0}</b>`,
      `🔁 Total Trades: <b>${tradeRow?.c ?? 0}</b>`,
      `  ✅ Confirmed: ${confirmedRow?.c ?? 0}`,
      `  ❌ Failed: ${failedRow?.c ?? 0}`,
      `🎯 Total Signals: <b>${sigRow?.c ?? 0}</b>`,
      `—`,
      `⏱ Uptime: <b>${hours}h ${mins}m</b>`,
      `💲 Platform Fee: <b>1% (100 bps)</b>`,
      `🔐 Encryption: <b>AES-256-GCM</b>`,
      `🚀 MEV Protection: <b>Jito (SOL) + Flashbots (EVM)</b>`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}
