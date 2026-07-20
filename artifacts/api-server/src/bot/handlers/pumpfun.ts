import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { WsManager } from "../../services/wsManager";
import { getPairsByToken } from "../../services/dexscreener";
import { queueMessage } from "../../workers/messageQueue";
import { logger } from "../../lib/logger";

// Active PumpFun WSS listeners keyed by userId
const activeListeners = new Map<number, WsManager>();

const PUMPFUN_WSS =
  process.env["SOLANA_WSS_URL"] ?? "wss://pumpportal.fun/api/data";

export async function handlePumpfun(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  // Toggle listener
  if (activeListeners.has(user.id)) {
    activeListeners.get(user.id)?.destroy();
    activeListeners.delete(user.id);
    await ctx.editMessageText(
      "🌱 <b>PumpFun / Moonshot Snipe</b>\n\n🔴 Listener <b>stopped</b>.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("▶️ Start Listener", "pumpfun")],
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
    return;
  }

  const chatId = ctx.chat?.id ?? telegramId;
  const userId = user.id;

  const ws = new WsManager(
    PUMPFUN_WSS,
    async (raw) => {
      try {
        const data = JSON.parse(raw) as {
          txType?: string;
          mint?: string;
          name?: string;
          symbol?: string;
        };
        if (data.txType !== "create" || !data.mint) return;

        const pairs = await getPairsByToken(data.mint);
        const pair = pairs[0];
        const priceUsd = pair?.priceUsd ?? "0";

        const msg = [
          `🌱 <b>New Token Detected!</b>`,
          `🪙 <b>${data.name ?? "Unknown"}</b> (<code>${data.symbol ?? "?"}</code>)`,
          `📍 CA: <code>${data.mint}</code>`,
          `💲 Price: $${Number(priceUsd).toFixed(8)}`,
        ].join("\n");

        await queueMessage(chatId, msg, "HTML");

        // Record signal
        const { signalsTable } = await import("@workspace/db");
        await db.insert(signalsTable).values({
          userId,
          tokenAddress: data.mint,
          tokenSymbol: data.symbol ?? "UNKNOWN",
          chain: "SOL",
          source: "PUMPFUN",
          priceUsd,
        });
      } catch (err) {
        logger.error({ err }, "PumpFun message handler error");
      }
    },
    () => {
      // Subscribed on open
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    }
  );

  ws.connect();
  activeListeners.set(user.id, ws);

  await ctx.editMessageText(
    "🌱 <b>PumpFun / Moonshot Snipe</b>\n\n🟢 Listener <b>active</b> — monitoring new token creations on Solana.\nYou'll receive alerts for each new PumpFun launch.",
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⏹ Stop Listener", "pumpfun")],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}
