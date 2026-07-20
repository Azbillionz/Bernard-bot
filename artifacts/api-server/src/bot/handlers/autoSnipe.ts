import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { renderDashboard } from "../dashboard";

export async function handleAutoSnipe(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const newState = !user.autoSnipe;
  await db
    .update(usersTable)
    .set({ autoSnipe: newState, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));

  // Re-render dashboard with updated state
  await renderDashboard(ctx, true);
}
