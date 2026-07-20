import app from "./app";
import { logger } from "./lib/logger";
import { createBot, launchBot } from "./bot/index";
import { setBotInstance } from "./routes/index";

// ── Global exception boundaries ──────────────────────────────────────────
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
  process.exit(1);
});

// ── Port validation ───────────────────────────────────────────────────────
const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${rawPort}"`);

// ── Redis (optional) ──────────────────────────────────────────────────────
let redis: import("ioredis").default | null = null;
const redisUrl = process.env["REDIS_URL"];
if (redisUrl) {
  const { default: IORedis } = await import("ioredis");
  redis = new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  redis.on("error", (err) => logger.error({ err }, "Redis error"));
  await redis.connect().catch((err) => {
    logger.warn({ err }, "Redis connect failed — queue disabled");
    redis = null;
  });
} else {
  logger.warn("REDIS_URL not set — BullMQ message queue disabled");
}

// ── Bot initialization ────────────────────────────────────────────────────
let bot: ReturnType<typeof createBot> | null = null;
const botToken = process.env["TELEGRAM_BOT_TOKEN"];

if (botToken) {
  bot = createBot(redis);
  setBotInstance(bot);
  await launchBot(bot);
} else {
  logger.warn("TELEGRAM_BOT_TOKEN not set — bot not started. Set it in Secrets.");
}

// ── Start HTTP server ─────────────────────────────────────────────────────
app.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error starting server");
    process.exit(1);
  }
  logger.info({ port }, "QUANTREXTRADING_BOT server listening");
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutting down");
  if (bot) bot.stop(signal);
  if (redis) await redis.quit();
  process.exit(0);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
