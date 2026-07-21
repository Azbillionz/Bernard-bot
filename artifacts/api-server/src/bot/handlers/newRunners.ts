import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getNewRunners, formatPairMessage } from "../../services/dexscreener";

export async function handleNewRunners(ctx: Context): Promise<void> {
  await ctx.reply("⏳ Fetching new runners from DexScreener…");

  const pairs = await getNewRunners();

  if (pairs.length === 0) {
    await ctx.reply(
      "❌ No runners found right now — DexScreener may be rate-limiting. Try again in a moment.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Retry", "new_runners")],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ])
    );
    return;
  }

  await ctx.reply(`🔍 <b>New Runners</b> — Top ${pairs.length} boosted tokens\n—`, {
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
