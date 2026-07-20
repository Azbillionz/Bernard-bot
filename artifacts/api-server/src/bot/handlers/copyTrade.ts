import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, copyTradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

// Pending add-target state
const pendingAdd = new Map<number, true>();

export function isPendingCopyTradeAdd(telegramId: number): boolean {
  return pendingAdd.has(telegramId);
}

export async function processCopyTradeInput(
  ctx: Context,
  input: string
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  pendingAdd.delete(telegramId);

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const parts = input.trim().split(/\s+/);
  const walletAddress = parts[0] ?? "";
  const label = parts.slice(1).join(" ") || "Unnamed";

  if (!walletAddress) {
    await ctx.reply("❌ No wallet address provided.");
    return;
  }

  await db.insert(copyTradesTable).values({
    userId: user.id,
    targetWallet: walletAddress,
    chain: user.activeChain,
    label,
    isActive: true,
  });

  await ctx.reply(
    `✅ <b>Copy-Trade Target Added</b>\n\n💼 Wallet: <code>${walletAddress}</code>\n🏷️ Label: ${label}\n🔗 Chain: ${user.activeChain}`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Copy-Trade List", "copy_trade")],
      ]),
    }
  );
}

export async function handleCopyTrade(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const targets = await db
    .select()
    .from(copyTradesTable)
    .where(eq(copyTradesTable.userId, user.id));

  const lines =
    targets.length === 0
      ? ["No copy-trade targets set."]
      : targets.map(
          (t) =>
            `${t.isActive ? "🟢" : "⚪"} [${t.chain}] <code>${t.targetWallet.slice(0, 8)}...${t.targetWallet.slice(-4)}</code> — ${t.label}`
        );

  const removeButtons =
    targets.length > 0
      ? [
          targets.slice(0, 3).map((t) =>
            Markup.button.callback(`🗑 ${t.label.slice(0, 12)}`, `rm_ct:${t.id}`)
          ),
        ]
      : [];

  await ctx.editMessageText(
    `🔄 <b>Copy-Trade</b>\n—\n${lines.join("\n")}\n—\nTap ➕ to track a new wallet.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        ...removeButtons,
        [Markup.button.callback("➕ Add Target", "add_copy_target")],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}

export async function handleAddCopyTarget(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  pendingAdd.set(telegramId, true);
  await ctx.reply(
    "📥 Send the target wallet address (and optional label):\n<code>WALLET_ADDRESS label</code>",
    { parse_mode: "HTML" }
  );
}

export async function handleRemoveCopyTarget(
  ctx: Context,
  targetId: number
): Promise<void> {
  await ctx.answerCbQuery();
  await db.delete(copyTradesTable).where(eq(copyTradesTable.id, targetId));
  await handleCopyTrade(ctx);
}
