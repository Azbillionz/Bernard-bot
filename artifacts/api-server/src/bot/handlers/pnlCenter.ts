import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, tradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getPairsByToken } from "../../services/dexscreener";

interface PnlSummary {
  tokenSymbol: string;
  tokenAddress: string;
  chain: string;
  totalBought: number;
  totalSold: number;
  realizedPnl: number;
  unrealizedPnl: number;
  currentPriceUsd: number;
}

export async function handlePnlCenter(ctx: Context): Promise<void> {
  await ctx.answerCbQuery("📊 Calculating PnL...");
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const trades = await db
    .select()
    .from(tradesTable)
    .where(
      and(eq(tradesTable.userId, user.id), eq(tradesTable.status, "CONFIRMED"))
    );

  if (trades.length === 0) {
    await ctx.editMessageText(
      "📊 <b>PnL Center</b>\n\nNo confirmed trades yet. Execute your first trade to see PnL tracking.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
    return;
  }

  // Group trades by token
  const tokenMap = new Map<string, PnlSummary>();
  for (const t of trades) {
    const key = `${t.chain}:${t.tokenAddress}`;
    const existing = tokenMap.get(key) ?? {
      tokenSymbol: t.tokenSymbol,
      tokenAddress: t.tokenAddress,
      chain: t.chain,
      totalBought: 0,
      totalSold: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      currentPriceUsd: 0,
    };

    const amountIn = parseFloat(t.amountIn);
    const amountOut = parseFloat(t.amountOut);
    const price = parseFloat(t.priceUsd);

    if (t.side === "BUY") {
      existing.totalBought += amountIn;
    } else {
      existing.totalSold += amountOut;
      existing.realizedPnl += amountOut - amountIn;
    }

    tokenMap.set(key, existing);
  }

  // Fetch current prices for unrealized PnL
  for (const [, summary] of tokenMap) {
    const pairs = await getPairsByToken(summary.tokenAddress);
    const currentPrice = parseFloat(pairs[0]?.priceUsd ?? "0");
    summary.currentPriceUsd = currentPrice;
    if (summary.totalBought > summary.totalSold) {
      const remaining = summary.totalBought - summary.totalSold;
      // unrealized = remaining tokens * current price - cost basis
      summary.unrealizedPnl = remaining * currentPrice - summary.totalBought;
    }
  }

  const lines = [...tokenMap.values()].map((s) => {
    const realized = s.realizedPnl >= 0 ? `+$${s.realizedPnl.toFixed(2)}` : `-$${Math.abs(s.realizedPnl).toFixed(2)}`;
    const unrealized = s.unrealizedPnl >= 0 ? `+$${s.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(s.unrealizedPnl).toFixed(2)}`;
    return [
      `🪙 <b>${s.tokenSymbol}</b> [${s.chain}]`,
      `  💰 Realized: <b>${realized}</b>`,
      `  📈 Unrealized: <b>${unrealized}</b>`,
    ].join("\n");
  });

  const totalRealized = [...tokenMap.values()].reduce((a, b) => a + b.realizedPnl, 0);
  const totalUnrealized = [...tokenMap.values()].reduce((a, b) => a + b.unrealizedPnl, 0);

  await ctx.editMessageText(
    [
      `📊 <b>PnL Center</b>`,
      `—`,
      lines.join("\n\n"),
      `—`,
      `📈 Total Realized: <b>${totalRealized >= 0 ? "+" : ""}$${totalRealized.toFixed(2)}</b>`,
      `💡 Total Unrealized: <b>${totalUnrealized >= 0 ? "+" : ""}$${totalUnrealized.toFixed(2)}</b>`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Refresh", "pnl_center")],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}
