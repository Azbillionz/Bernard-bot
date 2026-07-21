import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getTrendingPairs, formatPairMessage } from "../../services/dexscreener";

export async function handleTrending(ctx: Context): Promise<void> {
  await ctx.reply("⏳ Fetching trending pairs from DexScreener…");

  const pairs = await getTrendingPairs();

  if (pairs.length === 0) {
    await ctx.reply(
      "❌ No trending pairs found right now. Try again shortly.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Retry", "trending")],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ])
    );
    return;
  }

  await ctx.reply(`🔥 <b>Trending Pairs</b> — Top ${pairs.length} by volume\n—`, {
    parse_mode: "HTML",
  });

  for (const pair of pairs) {
    await ctx.reply(formatPairMessage(pair), {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📊 Analyze & Trade", `analyze:${pair.baseToken.address}`),
        ],
      ]),
    });
  }

  await ctx.reply(
    "Tap <b>Analyze & Trade</b> on any token to see security data, buy/sell controls, and live price.",
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]]),
    }
  );
}
