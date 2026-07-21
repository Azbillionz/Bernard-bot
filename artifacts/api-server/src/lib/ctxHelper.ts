/**
 * Safe context helpers — work from both slash commands and inline button callbacks.
 * Use these instead of ctx.editMessageText() directly to avoid crashes.
 */
import type { Context } from "telegraf";

type Extra = Parameters<Context["reply"]>[1];

/**
 * Edits the existing message if we're inside a callback query,
 * otherwise sends a new message. Never throws.
 */
export async function safeReply(
  ctx: Context,
  text: string,
  extra?: Extra
): Promise<void> {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(
        text,
        extra as Parameters<Context["editMessageText"]>[1]
      );
      return;
    } catch {
      // Falls through to ctx.reply if edit fails (e.g. same text)
    }
  }
  await ctx.reply(text, extra);
}
