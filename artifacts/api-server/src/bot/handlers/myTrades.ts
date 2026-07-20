import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, tradesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function handleMyTrades(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const trades = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.userId, user.id))
    .orderBy(desc(tradesTable.createdAt))
    .limit(10);

  if (trades.length === 0) {
    await ctx.editMessageText(
      "📉 <b>My Trades</b>\n\nNo trades recorded. Send a CA and tap Buy to execute your first trade.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
    return;
  }

  const statusIcon: Record<string, string> = {
    CONFIRMED: "✅",
    PENDING: "⏳",
    FAILED: "❌",
  };
  const sideIcon = (side: string) => (side === "BUY" ? "📈 BUY" : "📉 SELL");

  const lines = trades.map((t) => {
    const ts = t.createdAt.toISOString().slice(0, 16).replace("T", " ");
    const icon = statusIcon[t.status] ?? "❓";
    return [
      `${icon} ${sideIcon(t.side)} <b>${t.tokenSymbol}</b> [${t.chain}]`,
      `   In: ${t.amountIn} | Out: ${t.amountOut} | $${Number(t.priceUsd).toFixed(6)}`,
      `   Fee: ${t.feeBps / 100}% | ${ts} UTC`,
      t.txHash ? `   TX: <code>${t.txHash.slice(0, 20)}...</code>` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  await ctx.editMessageText(
    [`📉 <b>My Trades</b> (last ${trades.length})`, `—`, lines.join("\n\n")].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}
