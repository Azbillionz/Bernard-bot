/**
 * BullMQ message queue — enforces ≤30 outbound Telegram messages/second.
 * Falls back to direct send when Redis is unavailable.
 */

import { Queue, Worker } from "bullmq";
import type IORedis from "ioredis";
import type { Telegraf, Context } from "telegraf";
import { logger } from "../lib/logger";

interface SendMessageJob {
  chatId: number | string;
  text: string;
  parseMode?: "HTML" | "MarkdownV2" | "Markdown";
}

let queue: Queue<SendMessageJob> | null = null;
let botRef: Telegraf<Context> | null = null;

export function initMessageQueue(
  bot: Telegraf<Context>,
  redis: IORedis | null
): void {
  botRef = bot;

  if (!redis) {
    logger.warn("Redis unavailable — message queue disabled, direct send active");
    return;
  }

  queue = new Queue<SendMessageJob>("tg-messages", {
    connection: redis as never,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
  });

  const worker = new Worker<SendMessageJob>(
    "tg-messages",
    async (job) => {
      const { chatId, text, parseMode } = job.data;
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: parseMode ?? "HTML",
      });
    },
    {
      connection: redis as never,
      limiter: { max: 30, duration: 1_000 },
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Message queue job failed");
  });

  logger.info("BullMQ message queue initialized (30 msg/s limit)");
}

export async function queueMessage(
  chatId: number | string,
  text: string,
  parseMode: "HTML" | "MarkdownV2" | "Markdown" = "HTML"
): Promise<void> {
  if (queue) {
    await queue.add("send", { chatId, text, parseMode });
    return;
  }
  // Fallback: direct send
  try {
    await botRef?.telegram.sendMessage(chatId, text, { parse_mode: parseMode });
  } catch (err) {
    logger.error({ chatId, err }, "Direct message send failed");
  }
}
