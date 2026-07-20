import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, signalsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function handlePreviousSignals(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const signals = await db
    .select()
    .from(signalsTable)
    .where(eq(signalsTable.userId, user.id))
    .orderBy(desc(signalsTable.triggeredAt))
    .limit(10);

  if (signals.length === 0) {
    await ctx.editMessageText(
      "📋 <b>Previous Signals</b>\n\nNo signals recorded yet. Start the PumpFun listener or enable Group Scanner to capture signals.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
    return;
  }

  const lines = signals.map((s, i) => {
    const ts = s.triggeredAt.toISOString().slice(0, 16).replace("T", " ");
    return `${i + 1}. <code>${s.tokenSymbol}</code> [${s.chain}] — ${s.source} @ ${ts} UTC\n   CA: <code>${s.tokenAddress}</code>`;
  });

  await ctx.editMessageText(
    `📋 <b>Previous Signals</b> (last ${signals.length})\n—\n${lines.join("\n\n")}`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}
