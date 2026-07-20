import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getTrendingPairs, formatPairMessage } from "../../services/dexscreener";

export async function handleTrending(ctx: Context): Promise<void> {
  await ctx.answerCbQuery("🔥 Fetching trending pairs...");
  await ctx.reply("⏳ Querying DexScreener for trending pairs...");

  const pairs = await getTrendingPairs();

  if (pairs.length === 0) {
    await ctx.reply(
      "❌ No trending pairs found. Try again shortly.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Retry", "trending")],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ])
    );
    return;
  }

  await ctx.reply(
    `🔥 <b>Trending Pairs</b> — Top ${pairs.length} by volume\n—`,
    { parse_mode: "HTML" }
  );

  for (const pair of pairs) {
    await ctx.reply(formatPairMessage(pair), {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📊 Analyze",
            `analyze:${pair.baseToken.address}`
          ),
        ],
      ]),
    });
  }

  await ctx.reply(
    "Tap Analyze on any token to view security data and trading controls.",
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]])
  );
}
