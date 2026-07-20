import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { renderDashboard } from "../dashboard";

const CHAINS = ["SOL", "ETH", "BASE", "BSC"] as const;
type Chain = (typeof CHAINS)[number];

const CHAIN_INFO: Record<Chain, string> = {
  SOL: "Solana — Jito bundles, Jupiter V6",
  ETH: "Ethereum — Flashbots private RPC",
  BASE: "Base — Flashbots / direct",
  BSC: "BNB Smart Chain — direct RPC",
};

export async function handleSettings(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const chainButtons = CHAINS.map((c) =>
    Markup.button.callback(
      `${c === user.activeChain ? "✅ " : ""}${c}`,
      `set_chain:${c}`
    )
  );

  await ctx.editMessageText(
    [
      `⚙️ <b>Settings</b>`,
      ``,
      `🌐 Active Chain: <b>${user.activeChain}</b>`,
      ``,
      ...CHAINS.map((c) => `${c === user.activeChain ? "✅" : "⬜"} ${c} — ${CHAIN_INFO[c]}`),
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        chainButtons,
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}

export async function handleSetChain(
  ctx: Context,
  chain: string
): Promise<void> {
  await ctx.answerCbQuery(`Switching to ${chain}...`);
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  await db
    .update(usersTable)
    .set({ activeChain: chain, updatedAt: new Date() })
    .where(eq(usersTable.telegramId, telegramId));

  await renderDashboard(ctx, true);
}
