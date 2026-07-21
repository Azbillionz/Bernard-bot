import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, tradesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { safeReply } from "../../lib/ctxHelper";

export async function handleMyTrades(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  const trades = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.userId, user.id))
    .orderBy(desc(tradesTable.createdAt))
    .limit(10);

  const nav = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Refresh", "my_trades")],
    [Markup.button.callback("📊 PnL Center", "pnl_center"), Markup.button.callback("⬅️ Dashboard", "dashboard")],
  ]);

  if (trades.length === 0) {
    await safeReply(
      ctx,
      [
        `📉 <b>My Trades</b>`,
        `—`,
        `No trades yet.`,
        ``,
        `Paste any token CA in the chat to get buy/sell options.`,
      ].join("\n"),
      { parse_mode: "HTML", ...nav }
    );
    return;
  }

  const statusIcon: Record<string, string> = {
    CONFIRMED: "✅",
    PENDING: "⏳",
    FAILED: "❌",
  };

  const lines = trades.map((t) => {
    const ts = t.createdAt.toISOString().slice(0, 16).replace("T", " ");
    const icon = statusIcon[t.status] ?? "❓";
    const side = t.side === "BUY" ? "📈 BUY" : "📉 SELL";
    return [
      `${icon} ${side} <b>${t.tokenSymbol}</b> [${t.chain}]`,
      `   In: <b>${t.amountIn}</b> → Out: ${t.amountOut ?? "—"}`,
      `   Entry: $${Number(t.priceUsd).toFixed(8)} | Fee: ${t.feeBps / 100}%`,
      `   🕐 ${ts} UTC`,
      t.txHash ? `   TX: <code>${t.txHash.slice(0, 24)}…</code>` : "",
      t.status === "CONFIRMED" && t.side === "BUY"
        ? `   [Tap to sell: <code>${t.tokenAddress}</code>]`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  // Build sell buttons for the most recent confirmed BUY
  const lastBuy = trades.find((t) => t.side === "BUY" && t.status === "CONFIRMED");
  const sellRow = lastBuy
    ? [
        [
          Markup.button.callback("📤 Sell 25%", `sell:${lastBuy.tokenAddress}:25`),
          Markup.button.callback("📤 Sell 50%", `sell:${lastBuy.tokenAddress}:50`),
          Markup.button.callback("📤 Sell 100%", `sell:${lastBuy.tokenAddress}:100`),
        ],
        [Markup.button.callback("📊 Live Price", `price:${lastBuy.tokenAddress}`)],
      ]
    : [];

  await safeReply(
    ctx,
    [`📉 <b>My Trades</b> (last ${trades.length})`, `—`, lines.join("\n\n")].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        ...sellRow,
        [Markup.button.callback("🔄 Refresh", "my_trades")],
        [Markup.button.callback("📊 PnL Center", "pnl_center"), Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}
