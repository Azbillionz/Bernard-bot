/**
 * PumpFun / Moonshot live sniper.
 * Listens to PumpPortal WebSocket for new token mints.
 * When autoSnipe=true, applies sniper filters then auto-executes buy.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, sniperConfigsTable, signalsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { WsManager } from "../../services/wsManager";
import { getPairsByToken } from "../../services/dexscreener";
import { searchGeckoToken } from "../../services/geckoTerminal";
import { getPumpFunToken } from "../../services/pumpfunApi";
import { getNativeTokenPrice } from "../../services/chainPrice";
import { checkSolanaToken } from "../../services/goplus";
import { queueMessage } from "../../workers/messageQueue";
import { triggerAutoSnipeBuy } from "./trade";
import { logger } from "../../lib/logger";

// Active PumpFun WSS listeners keyed by db userId
const activeListeners = new Map<number, WsManager>();

const PUMPFUN_WSS =
  process.env["SOLANA_WSS_URL"] ?? "wss://pumpportal.fun/api/data";

export function isPumpfunListenerActive(dbUserId: number): boolean {
  return activeListeners.has(dbUserId);
}

export async function handlePumpfun(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  // Toggle
  if (activeListeners.has(user.id)) {
    activeListeners.get(user.id)?.destroy();
    activeListeners.delete(user.id);
    await ctx.editMessageText(
      "🌱 <b>PumpFun / Moonshot Snipe</b>\n\n🔴 Listener <b>stopped</b>.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("▶️ Start Listener", "pumpfun")],
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
    return;
  }

  const chatId = ctx.chat?.id ?? telegramId;
  const dbUserId = user.id;
  const autoSnipe = user.autoSnipe ?? false;

  const ws = new WsManager(
    PUMPFUN_WSS,
    async (raw) => {
      try {
        const data = JSON.parse(raw) as {
          txType?: string;
          mint?: string;
          name?: string;
          symbol?: string;
          solAmount?: number;
          marketCapSol?: number;
        };

        if (data.txType !== "create" || !data.mint) return;

        const mint = data.mint;
        const symbol = data.symbol ?? "?";
        const name = data.name ?? "Unknown";

        // ── Resolve token data (waterfall) ──────────────────────────────
        let priceUsd = "0";
        let liquidityUsd = 0;
        let tokenMsg = "";

        const pairs = await getPairsByToken(mint);
        const pair = pairs[0];

        if (pair) {
          priceUsd = pair.priceUsd ?? "0";
          liquidityUsd = pair.liquidity?.usd ?? 0;
          tokenMsg = [
            `🌱 <b>New Token!</b> (DexScreener)`,
            `🪙 <b>${name}</b> (<code>${symbol}</code>)`,
            `📍 CA: <code>${mint}</code>`,
            `💲 $${Number(priceUsd).toFixed(8)} | 💧 Liq: $${(liquidityUsd / 1_000).toFixed(1)}K`,
          ].join("\n");
        } else {
          // Try GeckoTerminal
          const gecko = await searchGeckoToken(mint, "SOL").catch(() => null);
          if (gecko) {
            priceUsd = gecko.priceUsd;
            liquidityUsd = gecko.liquidityUsd;
            tokenMsg = [
              `🌱 <b>New Token!</b> (GeckoTerminal)`,
              `🪙 <b>${gecko.baseTokenName}</b>`,
              `📍 CA: <code>${mint}</code>`,
              `💲 $${Number(priceUsd).toFixed(8)} | 💧 Liq: $${(liquidityUsd / 1_000).toFixed(1)}K`,
            ].join("\n");
          } else {
            // PumpFun REST API
            const pumpToken = await getPumpFunToken(mint).catch(() => null);
            const solUsd = Number(await getNativeTokenPrice("SOL").catch(() => 0));
            const pPrice = pumpToken ? pumpToken.priceNative * solUsd : 0;
            priceUsd = pPrice.toFixed(10);
            liquidityUsd = 0;
            tokenMsg = [
              `🌱 <b>New PumpFun Launch!</b>`,
              `🪙 <b>${pumpToken?.name ?? name}</b> (<code>${pumpToken?.symbol ?? symbol}</code>)`,
              `📍 CA: <code>${mint}</code>`,
              `💲 ~$${pPrice.toFixed(8)}`,
              pumpToken
                ? `📈 Bonding: ${(pumpToken.bondingCurveProgress).toFixed(1)}%`
                : "",
            ].filter(Boolean).join("\n");
          }
        }

        // ── Alert user ──────────────────────────────────────────────────
        await queueMessage(chatId, tokenMsg, "HTML");

        // ── Record signal ───────────────────────────────────────────────
        void db.insert(signalsTable).values({
          userId: dbUserId,
          tokenAddress: mint,
          tokenSymbol: symbol,
          chain: "SOL",
          source: "PUMPFUN",
          priceUsd,
        }).catch(() => undefined);

        // ── Auto-snipe logic ────────────────────────────────────────────
        if (!autoSnipe) return;

        const config = await db.query.sniperConfigsTable.findFirst({
          where: eq(sniperConfigsTable.userId, dbUserId),
        });

        // Filter: min liquidity
        const minLiq = parseFloat(config?.minLiquidityUsd ?? "0");
        if (minLiq > 0 && liquidityUsd < minLiq) {
          logger.info({ mint, liquidityUsd, minLiq }, "Auto-snipe: liquidity filter rejected");
          return;
        }

        // Filter: honeypot + tax check
        if (config?.honeypotCheck !== false) {
          const sec = await checkSolanaToken(mint).catch(() => null);
          if (sec?.isBlacklisted) {
            logger.info({ mint }, "Auto-snipe: token blacklisted, skipping");
            return;
          }
          if (sec?.hasMintAuthority) {
            logger.info({ mint }, "Auto-snipe: mint authority active, skipping");
            return;
          }
        }

        // Fire auto-snipe (non-blocking, errors logged internally)
        void triggerAutoSnipeBuy({
          dbUserId,
          telegramId,
          ca: mint,
          tokenSymbol: symbol,
          tokenName: name,
          priceUsd,
          liquidityUsd,
        });
      } catch (err) {
        logger.error({ err }, "PumpFun message handler error");
      }
    },
    () => {
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    }
  );

  ws.connect();
  activeListeners.set(user.id, ws);

  const autoSnipeStatus = autoSnipe
    ? "⚡ <b>Auto-Snipe: ON</b> — will auto-buy new launches matching your filters."
    : "🔴 Auto-Snipe: OFF — toggle it in ⚙️ Settings.";

  await ctx.editMessageText(
    [
      "🌱 <b>PumpFun / Moonshot Snipe</b>",
      "",
      "🟢 Listener <b>active</b> — monitoring new token creations on Solana.",
      "You'll receive alerts for each new PumpFun launch.",
      "",
      autoSnipeStatus,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⏹ Stop Listener", "pumpfun")],
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}
