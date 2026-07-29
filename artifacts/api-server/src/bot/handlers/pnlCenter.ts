import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, tradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getPairsByToken } from "../../services/dexscreener";
import { safeReply } from "../../lib/ctxHelper";

interface PnlSummary {
  tokenSymbol: string;
  tokenAddress: string;
  chain: string;
  totalBought: number;
  totalSold: number;
  realizedPnl: number;
  unrealizedPnl: number;
  currentPriceUsd: number;
  entryPriceUsd: number;
}

export async function handlePnlCenter(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  const trades = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.userId, user.id), eq(tradesTable.status, "CONFIRMED")));

  const nav = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Refresh", "pnl_center")],
    [Markup.button.callback("📉 My Trades", "my_trades"), Markup.button.callback("⬅️ Dashboard", "dashboard")],
  ]);

  if (trades.length === 0) {
    await safeReply(
      ctx,
      [
        `📊 <b>PnL Center</b>`,
        `—`,
        `No confirmed trades yet.`,
        ``,
        `Paste a token CA and tap Buy to execute your first trade.`,
      ].join("\n"),
      { parse_mode: "HTML", ...nav }
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
      entryPriceUsd: parseFloat(t.priceUsd),
    };

    if (t.side === "BUY") {
      existing.totalBought += parseFloat(t.amountIn);
    } else {
      const out = parseFloat(t.amountOut ?? "0");
      const inAmt = parseFloat(t.amountIn);
      existing.totalSold += out;
      existing.realizedPnl += out - inAmt;
    }

    tokenMap.set(key, existing);
  }

  // Fetch current prices in parallel
  await Promise.all(
    [...tokenMap.entries()].map(async ([, summary]) => {
      const pairs = await getPairsByToken(summary.tokenAddress).catch(() => []);
      const currentPrice = parseFloat(pairs[0]?.priceUsd ?? "0");
      summary.currentPriceUsd = currentPrice;
            if (summary.totalBought > summary.totalSold) {
        const remaining = summary.totalBought - summary.totalSold; // native currency still deployed
        const priceChangeRatio =
          summary.entryPriceUsd > 0 ? (currentPrice - summary.entryPriceUsd) / summary.entryPriceUsd : 0;
        summary.unrealizedPnl = remaining * priceChangeRatio;
      }
    })
  );

  const lines = [...tokenMap.values()].map((s) => {
    const realized =
      s.realizedPnl >= 0
        ? `+${s.realizedPnl.toFixed(4)}`
        : `${s.realizedPnl.toFixed(4)}`;
    const unrealized =
      s.unrealizedPnl >= 0
        ? `+${s.unrealizedPnl.toFixed(4)}`
        : `${s.unrealizedPnl.toFixed(4)}`;

    const priceDelta =
      s.entryPriceUsd > 0
        ? (((s.currentPriceUsd - s.entryPriceUsd) / s.entryPriceUsd) * 100).toFixed(2)
        : "0.00";
    const priceArrow = parseFloat(priceDelta) >= 0 ? "📈" : "📉";

    return [
      `🪙 <b>${s.tokenSymbol}</b> [${s.chain}]`,
      `  ${priceArrow} Price: $${s.currentPriceUsd.toFixed(8)} (${priceDelta}% from entry)`,
      `  💰 Realized P&L: <b>${realized} native</b>`,
      `  📊 Unrealized P&L: <b>${unrealized} native</b>`,
      `  🛒 Total Bought: ${s.totalBought.toFixed(4)} | Sold: ${s.totalSold.toFixed(4)}`,
    ].join("\n");
  });

  const totalRealized = [...tokenMap.values()].reduce((a, b) => a + b.realizedPnl, 0);
  const totalUnrealized = [...tokenMap.values()].reduce((a, b) => a + b.unrealizedPnl, 0);
  const totalSign = totalRealized + totalUnrealized >= 0 ? "📈" : "📉";

  await safeReply(
    ctx,
    [
      `📊 <b>PnL Center</b>`,
      `—`,
      lines.join("\n\n"),
      `—`,
      `${totalSign} Total Realized: <b>${totalRealized >= 0 ? "+" : ""}${totalRealized.toFixed(4)} native</b>`,
      `💡 Total Unrealized: <b>${totalUnrealized >= 0 ? "+" : ""}${totalUnrealized.toFixed(4)} native</b>`,
    ].join("\n"),
    { parse_mode: "HTML", ...nav }
  );
}
