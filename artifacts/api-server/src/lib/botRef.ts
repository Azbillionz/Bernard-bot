/**
 * Singleton bot reference — lets any module send Telegram messages
 * without circular imports or passing the bot instance through layers.
 */

import type { Telegraf, Context } from "telegraf";

let _bot: Telegraf<Context> | null = null;

export function setBotRef(bot: Telegraf<Context>): void {
  _bot = bot;
}

export function getBotRef(): Telegraf<Context> | null {
  return _bot;
}
