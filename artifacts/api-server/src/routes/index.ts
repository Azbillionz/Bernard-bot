import { Router, type IRouter } from "express";
import healthRouter from "./health";
import type { Telegraf, Context } from "telegraf";
import { createWebhookRouter } from "./webhook";

let botInstance: Telegraf<Context> | null = null;

export function setBotInstance(bot: Telegraf<Context>): void {
  botInstance = bot;
}

const router: IRouter = Router();

router.use(healthRouter);

// Webhook route is registered lazily after bot init
router.use("/webhook", (req, res, next) => {
  if (botInstance) {
    const webhookRouter = createWebhookRouter(botInstance);
    webhookRouter(req, res, next);
    return;
  }
  res.status(503).json({ error: "Bot not initialized" });
});

export default router;
