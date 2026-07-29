import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, signalsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { safeReply } from "../../lib/ctxHelper";

export async function handlePreviousSignals(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Send /start first."); return; }

  const signals = await db
    .select()
    .from(signalsTable)
    .where(and(eq(signalsTable.userId, user.id), eq(signalsTable.chain, user.activeChain)))
    .orderBy(desc(signalsTable.triggeredAt))
    .limit(10);

  const nav = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Refresh", "prev_signals")],
    [Markup.button.callback("⬅️ Dashboard", "dashboard")],
  ]);

  if (signals.length === 0) {
    await safeReply(
      ctx,
      [
        `📋 <b>Previous Signals</b> — ${user.activeChain}`,
        `—`,
        `No signals yet on ${user.activeChain}.`,
        ``,
        `Start the <b>PumpFun Listener</b> or enable <b>Group Scanner</b>`,
        `to automatically capture contract addresses, or paste a CA to`,
        `analyze one manually.`,
      ].join("\n"),
      { parse_mode: "HTML", ...nav }
    );
    return;
  }

  const lines = signals.map((s, i) => {
    const ts = s.triggeredAt.toISOString().slice(0, 16).replace("T", " ");
    return [
      `${i + 1}. <b>${s.tokenSymbol}</b> — ${s.source}`,
      `   🕐 ${ts} UTC`,
      `   CA: <code>${s.tokenAddress}</code>`,
    ].join("\n");
  });

  await safeReply(
    ctx,
    [`📋 <b>Previous Signals</b> — ${user.activeChain} (last ${signals.length})`, `—`, lines.join("\n\n")].join("\n"),
    { parse_mode: "HTML", ...nav }
  );
}
