import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { getNewRunners, formatPairMessage } from "../../services/dexscreener";
import { renderDashboard } from "../dashboard";

export async function handleNewRunners(ctx: Context): Promise<void> {
  await ctx.answerCbQuery("🔍 Fetching new runners...");
  await ctx.reply("⏳ Querying DexScreener for new runners...");

  const pairs = await getNewRunners();

  if (pairs.length === 0) {
    await ctx.reply(
      "❌ No runners found right now. Try again in a moment.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Retry", "new_runners")],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ])
    );
    return;
  }

  await ctx.reply(
    `🔍 <b>New Runners</b> — Top ${pairs.length} boosted tokens\n—`,
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
    "Use the buttons above to analyze any token.",
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]])
  );
}
