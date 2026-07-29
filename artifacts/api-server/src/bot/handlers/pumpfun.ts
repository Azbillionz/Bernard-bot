/**
 * PumpFun / Moonshot live sniper.
 * Listens to PumpPortal WebSocket for new token mints.
 * When autoSnipe=true, applies sniper filters then auto-executes buy.
 *
 * The listener is started/stopped from TWO places that both need to agree:
 *  - the 🌱 PumpFun screen (manual start/stop of live alerts)
 *  - the 🤖 Auto-Snipe toggle (turning auto-buy on/off)
 * Both call the same startPumpfunListener/stopPumpfunListener functions so
 * there's exactly one listener per user and no stale/disconnected state.
 * The auto-snipe check inside the listener always re-reads the DB flag at
 * fire time — never a captured value from when the listener started — so
 * toggling Auto-Snipe on/off takes effect immediately without restarting.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, walletsTable, sniperConfigsTable, signalsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { WsManager } from "../../services/wsManager";
import { getPairsByToken } from "../../services/dexscreener";
import { searchGeckoToken } from "../../services/geckoTerminal";
import { getPumpFunToken } from "../../services/pumpfunApi";
import { getNativeTokenPrice, getChainBalance } from "../../services/chainPrice";
import { checkSolanaToken } from "../../services/goplus";
import { queueMessage } from "../../workers/messageQueue";
import { triggerAutoSnipeBuy } from "./trade";
import { logger } from "../../lib/logger";
import { safeReply } from "../../lib/ctxHelper";

// Active PumpFun WSS listeners keyed by db userId
const activeListeners = new Map<number, WsManager>();

// Token names/symbols come from an external WebSocket feed — escape before
// rendering in HTML parse mode, or a name like "<Best>" silently kills the send.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PUMPFUN_WSS =
  process.env["SOLANA_WSS_URL"] ?? "wss://pumpportal.fun/api/data";

export function isPumpfunListenerActive(dbUserId: number): boolean {
  return activeListeners.has(dbUserId);
}

export function stopPumpfunListener(dbUserId: number): void {
  activeListeners.get(dbUserId)?.destroy();
  activeListeners.delete(dbUserId);
}

/**
 * Starts (or no-ops if already running) the live PumpFun listener for a
 * user. Auto-snipe eligibility is re-checked fresh from the DB on every
 * single new-token event — this function does not "bake in" the current
 * autoSnipe value, so toggling it elsewhere takes effect on the very next
 * detected token without needing to restart anything.
 */
export function startPumpfunListener(dbUserId: number, telegramId: number, chatId: number): void {
  if (activeListeners.has(dbUserId)) return; // already running

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
        // Raw values for DB + trade params; escaped values for HTML rendering
        const symbol = data.symbol ?? "?";
        const name = data.name ?? "Unknown";
        const symbolSafe = escapeHtml(symbol);
        const nameSafe = escapeHtml(name);
        const devBuySol = data.solAmount ?? 0;
        const mcapSol = data.marketCapSol ?? 0;

        // ── Resolve token data (waterfall) ────────────────────────────────
        let priceUsd = "0";
        let liquidityUsd = 0;
        let tokenMsg = "";

        const pairs = await getPairsByToken(mint).catch(() => []);
        const pair = pairs[0];

        if (pair) {
          priceUsd = pair.priceUsd ?? "0";
          liquidityUsd = pair.liquidity?.usd ?? 0;
          tokenMsg = [
            `🌱 <b>New Token!</b>`,
            `🪙 <b>${nameSafe}</b> (<code>${symbolSafe}</code>)`,
            `📍 CA: <code>${mint}</code>`,
            `💲 Price: $${Number(priceUsd).toFixed(8)}`,
            `💧 Liquidity: $${(liquidityUsd / 1_000).toFixed(1)}K`,
            `📊 Source: DexScreener`,
          ].join("\n");
        } else {
          const gecko = await searchGeckoToken(mint, "SOL").catch(() => null);
          if (gecko) {
            priceUsd = gecko.priceUsd;
            liquidityUsd = gecko.liquidityUsd;
            tokenMsg = [
              `🌱 <b>New Token!</b>`,
              `🪙 <b>${escapeHtml(gecko.baseTokenName)}</b>`,
              `📍 CA: <code>${mint}</code>`,
              `💲 Price: $${Number(priceUsd).toFixed(8)}`,
              `💧 Liquidity: $${(liquidityUsd / 1_000).toFixed(1)}K`,
              `📊 Source: GeckoTerminal`,
            ].join("\n");
          } else {
            const pumpToken = await getPumpFunToken(mint).catch(() => null);
            const solUsd = Number(await getNativeTokenPrice("SOL").catch(() => 0));
            const pPrice = pumpToken ? pumpToken.priceNative * solUsd : 0;
            priceUsd = pPrice.toFixed(10);
            liquidityUsd = 0;
            tokenMsg = [
              `🌱 <b>New PumpFun Launch!</b>`,
              `🪙 <b>${escapeHtml(pumpToken?.name ?? name)}</b> (<code>${escapeHtml(pumpToken?.symbol ?? symbol)}</code>)`,
              `📍 CA: <code>${mint}</code>`,
              `💲 ~$${pPrice.toFixed(8)}`,
              pumpToken ? `📈 Bonding: ${pumpToken.bondingCurveProgress.toFixed(1)}%` : "",
              `📊 Source: PumpFun`,
            ].filter(Boolean).join("\n");
          }
        }

        // Launch stats straight from the mint event itself
        const launchStats = [
          mcapSol > 0 ? `🏦 Launch MC: ${mcapSol.toFixed(1)} SOL` : "",
          devBuySol > 0 ? `👨‍💻 Dev buy: ${devBuySol.toFixed(2)} SOL` : "",
        ].filter(Boolean).join(" | ");
        if (launchStats) tokenMsg += `\n${launchStats}`;

        // ── Always fetch fresh config for this token's quick-buy amount ───
        const freshConfig0 = await db.query.sniperConfigsTable.findFirst({
          where: eq(sniperConfigsTable.userId, dbUserId),
        });
        const rawAutoBuy = parseFloat(freshConfig0?.autoBuyAmountNative ?? "0.1");
        const quickBuyAmount = Number(
          Math.min(Math.max(Number.isFinite(rawAutoBuy) ? rawAutoBuy : 0.1, 0.000001), 1000).toFixed(6)
        );

        // ── Alert user with analyze + quick buy buttons ─────────────────
        await queueMessage(chatId, tokenMsg, "HTML", [
          [
            { text: "📊 Analyze", callback_data: `analyze:${mint}` },
            { text: "💰 Quick Buy", callback_data: `buy:${mint}:${quickBuyAmount}` },
          ],
        ]);

        // ── Record signal ────────────────────────────────────────────────
        void db.insert(signalsTable).values({
          userId: dbUserId,
          tokenAddress: mint,
          tokenSymbol: symbol,
          chain: "SOL",
          source: "PUMPFUN",
          priceUsd,
        }).catch(() => undefined);

        // ── Auto-snipe — ALWAYS re-read the live DB flag, never a value
        //    captured when the listener started, so toggling Auto-Snipe
        //    on/off elsewhere takes effect on the very next token. ───────
        const freshUser = await db.query.usersTable.findFirst({
          where: eq(usersTable.id, dbUserId),
        });
        if (!freshUser?.autoSnipe) return;

        const freshConfig = await db.query.sniperConfigsTable.findFirst({
          where: eq(sniperConfigsTable.userId, dbUserId),
        });

        const minLiq = parseFloat(freshConfig?.minLiquidityUsd ?? "0");
        if (minLiq > 0 && liquidityUsd < minLiq) {
          await queueMessage(
            telegramId,
            `⏭ <b>Auto-Snipe Skipped</b> — ${symbolSafe}\n💧 Liquidity $${(liquidityUsd / 1_000).toFixed(1)}K < minimum $${(minLiq / 1_000).toFixed(1)}K`,
            "HTML"
          );
          return;
        }

        if (freshConfig?.honeypotCheck !== false) {
          const sec = await checkSolanaToken(mint).catch(() => null);
          if (sec?.isBlacklisted) {
            await queueMessage(telegramId, `⛔ <b>Auto-Snipe Blocked</b> — ${symbolSafe}\n📍 <code>${mint}</code>\nToken is blacklisted.`, "HTML");
            return;
          }
          if (sec?.hasMintAuthority) {
            await queueMessage(telegramId, `⛔ <b>Auto-Snipe Blocked</b> — ${symbolSafe}\n📍 <code>${mint}</code>\nMint authority is still active — high rug risk.`, "HTML");
            return;
          }
        }

        // Check balance right before firing
        const freshWallet = await db.query.walletsTable.findFirst({
          where: and(eq(walletsTable.userId, dbUserId), eq(walletsTable.chain, "SOL"), eq(walletsTable.isActive, true)),
        });
        if (!freshWallet) {
          await queueMessage(telegramId, `⚠️ <b>Auto-Snipe Skipped</b> — No SOL wallet found. Go to 💼 Wallet Manager to set one up.`, "HTML");
          return;
        }
        const currentBal = parseFloat(await getChainBalance("SOL", freshWallet.address).catch(() => "0"));
        const buyAmt = parseFloat(freshConfig?.autoBuyAmountNative ?? "0.1");
        if (currentBal < buyAmt) {
          await queueMessage(
            telegramId,
            [
              `⚠️ <b>Auto-Snipe Skipped — Insufficient Balance</b>`,
              `🪙 Token: <b>${symbolSafe}</b>`,
              `📍 CA: <code>${mint}</code>`,
              `💼 Your balance: <b>${currentBal.toFixed(4)} SOL</b>`,
              `🛒 Required: <b>${buyAmt} SOL</b>`,
              ``,
              `Fund your wallet — this token stays queued and will auto-buy the moment your balance covers it (checked every minute for the next hour).`,
            ].join("\n"),
            "HTML"
          );
          void queuePendingSnipe(dbUserId, telegramId, mint, symbol, name, priceUsd, liquidityUsd, buyAmt);
          return;
        }

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
  activeListeners.set(dbUserId, ws);
}
