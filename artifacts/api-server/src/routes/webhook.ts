import { Router, type Request, type Response } from "express";
import type { Telegraf, Context } from "telegraf";
import { logger } from "../lib/logger";

export function createWebhookRouter(bot: Telegraf<Context>): Router {
  const router = Router();

  router.post("/webhook", async (req: Request, res: Response) => {
    try {
      await bot.handleUpdate(req.body as Parameters<typeof bot.handleUpdate>[0]);
      res.sendStatus(200);
    } catch (err) {
      logger.error({ err }, "Webhook update handling failed");
      res.sendStatus(500);
    }
  });

  return router;
}
