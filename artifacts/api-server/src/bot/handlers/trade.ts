/**
 * Trade execution handler.
 * SOL: Jupiter V6 → simulate → Jito bundle (1% platform fee via platformFeeBps)
 * EVM: 1inch swap → eth_call simulate → direct/Flashbots
 *
 * Also exports triggerAutoSnipeBuy — used by the PumpFun listener for auto-sniping —
 * and handleLivePrice — the live price tracker with entry P&L.
 *
 * NOTE: no handler here calls ctx.answerCbQuery — the global middleware in
 * bot/index.ts answers every callback instantly; answering twice throws.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import {
  usersTable,
  walletsTable,
  tradesTable,
  sniperConfigsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { decrypt } from "../../lib/encryption";
import { getBotRef } from "../../lib/botRef";
import { getJupiterQuote, buildJupiterSwapTx, simulateSolanaTx } from "../../services/jupiter";
import { sendJitoBundle, getJitoTipLamports } from "../../services/jito";
import { get1inchSwap } from "../../services/evmSwap";
import { simulateEvmTx } from "../../services/flashbots";
import { getPairsByToken } from "../../services/dexscreener";
import { logger } from "../../lib/logger";
import { registerPendingClearer } from "../../lib/pendingFlows";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const EVM_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const PLATFORM_FEE_BPS = 100; // 1%

// ── Pending custom buy state ──────────────────────────────────────────────
const pendingCustomBuy = new Map<number, { ca: string }>();
registerPendingClearer((id) => pendingCustomBuy.delete(id));

export function getPendingCustomBuy(telegramId: number): { ca: string } | null {
  return pendingCustomBuy.get(telegramId) ?? null;
}

export async function processCustomBuyAmount(ctx: Context, amount: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const state = pendingCustomBuy.get(telegramId);
  if (!state) return;
  pendingCustomBuy.delete(telegramId);

  const parsed = parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    await ctx.reply("❌ Invalid amount — send a positive number like <b>0.25</b>.", {
      parse_mode: "HTML",
    });
    return;
  }
  await executeBuy(ctx, state.ca, parsed);
}

export async function handleBuy(ctx: Context, ca: string, amountStr: string): Promise<void> {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) { await ctx.reply("❌ Invalid amount."); return; }
  await executeBuy(ctx, ca, amount);
}

export async function handleBuyCustom(ctx: Context, ca: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  pendingCustomBuy.set(telegramId, { ca });
  await ctx.reply("💬 Send the amount to buy in native token (e.g. <b>0.25</b>):", { parse_mode: "HTML" });
}

export async function handleSell(ctx: Context, ca: string, percentStr: string): Promise<void> {
  const percent = parseInt(percentStr, 10);
  if (isNaN(percent) || percent <= 0 || percent > 100) { await ctx.reply("❌ Invalid percent."); return; }
  await executeSell(ctx, ca, percent);
}

// ── Core SOL buy execution (shared between manual + auto-snipe) ───────────

interface SolBuyParams {
  walletAddress: string;
  encryptedPrivateKey: string;
  ca: string;
  lamports: number;
  slippageBps: number;
  jitoTipLamports: number;
}

interface SolBuyResult {
  txHash: string;
  outAmount: string;
}

async function executeSolBuy(params: SolBuyParams): Promise<SolBuyResult> {
  const { walletAddress, encryptedPrivateKey, ca, lamports, slippageBps, jitoTipLamports } = params;

  const quote = await getJupiterQuote(SOL_MINT, ca, lamports, slippageBps);
  if (!quote) throw new Error("Jupiter quote failed — token may have no liquidity");

  const swapTx = await buildJupiterSwapTx(quote, walletAddress, jitoTipLamports);
  if (!swapTx) throw new Error("Jupiter swap TX build failed");

  const sim = await simulateSolanaTx(swapTx);
  if (!sim.success) throw new Error(`Simulation failed: ${sim.error}`);

  const privateKey = decrypt(encryptedPrivateKey);
  const { Keypair, VersionedTransaction } = await import("@solana/web3.js");
  const bs58 = await import("bs58");
  const kp = Keypair.fromSecretKey(bs58.default.decode(privateKey));
  const txBytes = Buffer.from(swapTx, "base64");
  const vTx = VersionedTransaction.deserialize(txBytes);
  vTx.sign([kp]);
  const signedBase64 = Buffer.from(vTx.serialize()).toString("base64");

  const txHash = await sendJitoBundle([signedBase64]);
  if (!txHash) throw new Error("Jito bundle rejected");

  return { txHash, outAmount: quote.outAmount };
}

// ── Manual buy (ctx-based) ────────────────────────────────────────────────

async function executeBuy(ctx: Context, ca: string, amount: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Type /start first."); return; }

  const wallet = await db.query.walletsTable.findFirst({
    where: and(
      eq(walletsTable.userId, user.id),
      eq(walletsTable.chain, user.activeChain),
      eq(walletsTable.isActive, true)
    ),
  });
  if (!wallet) {
    await ctx.reply(
      "❌ No active wallet for this chain. Add one in 💼 Wallet Manager.",
      Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]])
    );
    return;
  }

  const config = await db.query.sniperConfigsTable.findFirst({
    where: eq(sniperConfigsTable.userId, user.id),
  });
  const slippageBps = config?.slippageBps ?? 1000;

  const pairs = await getPairsByToken(ca);
  const pair = pairs[0];
  const priceUsd = pair?.priceUsd ?? "0";
  const tokenSymbol = pair?.baseToken.symbol ?? "UNKNOWN";
  const tokenName = pair?.baseToken.name ?? "UNKNOWN";

  const [trade] = await db.insert(tradesTable).values({
    userId: user.id,
    chain: user.activeChain,
    tokenAddress: ca,
    tokenSymbol,
    tokenName,
    side: "BUY",
    amountIn: String(amount),
    feeBps: PLATFORM_FEE_BPS,
    priceUsd,
    status: "PENDING",
  }).returning();

  await ctx.reply(
    `⏳ <b>Buy Order Submitted</b>\n💰 Buying ${amount} ${user.activeChain} of <b>${tokenSymbol}</b>\n🔐 Simulating transaction…`,
    { parse_mode: "HTML" }
  );

  try {
    let txHash: string | null = null;

    if (user.activeChain === "SOL") {
      const lamports = Math.round(amount * 1e9);
      const jitoTip = config?.jitoTipLamports ?? getJitoTipLamports();
      const result = await executeSolBuy({
        walletAddress: wallet.address,
        encryptedPrivateKey: wallet.encryptedPrivateKey,
        ca,
        lamports,
        slippageBps,
        jitoTipLamports: jitoTip,
      });
      txHash = result.txHash;
    } else {
            if (!process.env["ZEROX_API_KEY"]) {
        const dexUrl = `https://app.uniswap.org/#/swap?outputCurrency=${ca}`;
        await ctx.reply(
          `⚠️ <b>In-bot EVM swaps require a 0x API key.</b>\n\nTrade directly:\n<a href="${dexUrl}">🔗 Uniswap — ${ca.slice(0, 8)}…</a>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
        return;
      }
      const amountWei = BigInt(Math.round(amount * 1e18)).toString();
      const swap = await get1inchSwap(user.activeChain, EVM_NATIVE, ca, amountWei, wallet.address, slippageBps / 100);
      if (!swap) throw new Error("1inch quote failed");
      const simResult = await simulateEvmTx(wallet.address, swap.to, swap.data, user.activeChain);
      if (!simResult.success) throw new Error(`EVM simulation failed: ${simResult.error}`);
      const { Wallet, JsonRpcProvider } = await import("ethers");
      const rpcMap: Record<string, string> = { ETH: "ETH_RPC_URL", BASE: "BASE_RPC_URL", BSC: "BSC_RPC_URL" };
      const rpcUrl = process.env[rpcMap[user.activeChain] ?? ""] ?? "";
      const provider = new JsonRpcProvider(rpcUrl);
      const pk = decrypt(wallet.encryptedPrivateKey);
      const evmWallet = new Wallet(pk, provider);
      const tx = await evmWallet.sendTransaction({
        to: swap.to, data: swap.data, value: BigInt(swap.value),
        gasLimit: BigInt(Math.round(swap.gas * 1.2)),
      });
      txHash = tx.hash;
    }

    await db.update(tradesTable)
      .set({ status: "CONFIRMED", txHash: txHash ?? undefined })
      .where(eq(tradesTable.id, trade!.id));

    await ctx.reply(
      [
        `✅ <b>Buy Confirmed!</b>`,
        `🪙 <b>${tokenName}</b> [${tokenSymbol}] — ${user.activeChain}`,
        `💰 Spent: <b>${amount} ${user.activeChain}</b>`,
        `💲 Price at entry: <b>${parseFloat(priceUsd).toFixed(8)}</b>`,
        `🔗 TX: <code>${txHash}</code>`,
        `💸 1% platform fee applied`,
        `—`,
        `Use the buttons below to sell your position.`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("📤 Sell 25%", `sell:${ca}:25`),
            Markup.button.callback("📤 Sell 50%", `sell:${ca}:50`),
          ],
          [
            Markup.button.callback("📤 Sell 75%", `sell:${ca}:75`),
            Markup.button.callback("📤 Sell 100%", `sell:${ca}:100`),
          ],
          [
            Markup.button.callback("📊 Live Price", `price:${ca}`),
            Markup.button.callback("🔍 Analyze Token", `analyze:${ca}`),
          ],
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Buy execution failed");
    await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
    await ctx.reply(
      `❌ <b>Buy Failed</b>\n${String(err).slice(0, 200)}`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]]) }
    );
  }
}

// ── Auto-snipe buy (no ctx — sends via bot.telegram) ─────────────────────

export interface AutoSnipeParams {
  dbUserId: number;
  telegramId: number;
  ca: string;
  tokenSymbol: string;
  tokenName: string;
  priceUsd: string;
  liquidityUsd: number;
}

// Token names/symbols come from external feeds — escape before HTML render
function escapeSnipeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Triggered by the PumpFun listener when a new token is detected
 * and the user has autoSnipe=true. Runs the full SOL buy flow without ctx.
 * Notifies the user about the coin at every stage: trigger → confirmed/failed.
 */
export async function triggerAutoSnipeBuy(params: AutoSnipeParams): Promise<void> {
  const { dbUserId, telegramId, ca, tokenSymbol, tokenName, priceUsd, liquidityUsd } = params;
  const bot = getBotRef();
  if (!bot) return;

  const symbolSafe = escapeSnipeHtml(tokenSymbol);
  const nameSafe = escapeSnipeHtml(tokenName);
  const entryPrice = Number(priceUsd) > 0 ? `${Number(priceUsd).toFixed(8)}` : "— (fresh mint)";
  const liqLabel = liquidityUsd > 0 ? `${(liquidityUsd / 1_000).toFixed(1)}K` : "— (fresh mint)";

  const send = (msg: string, keyboard?: { text: string; callback_data: string }[][]) =>
    bot.telegram
      .sendMessage(telegramId, msg, {
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      })
      .catch(() => undefined);

  try {
    const wallet = await db.query.walletsTable.findFirst({
      where: and(
        eq(walletsTable.userId, dbUserId),
        eq(walletsTable.chain, "SOL"),
        eq(walletsTable.isActive, true)
      ),
    });
    if (!wallet) {
      await send(`⚡ <b>Auto-Snipe skipped</b> — no active SOL wallet.\n🪙 Token: <b>${symbolSafe}</b> <code>${ca}</code>`);
      return;
    }

    const config = await db.query.sniperConfigsTable.findFirst({
      where: eq(sniperConfigsTable.userId, dbUserId),
    });

    const buyAmount = parseFloat(config?.autoBuyAmountNative ?? "0.1");
    const slippageBps = config?.slippageBps ?? 1500; // wider for fast snipe
    const jitoTip = config?.jitoTipLamports ?? getJitoTipLamports();

    // ── Filter: min liquidity (race guard — listener already notified) ────
    const minLiq = parseFloat(config?.minLiquidityUsd ?? "0");
    if (minLiq > 0 && liquidityUsd < minLiq) {
      logger.info({ ca, liquidityUsd, minLiq }, "Auto-snipe skipped: liquidity below filter");
      return;
    }

    // ── Notify: snipe triggered, full coin card ───────────────────────────
    await send(
      [
        `⚡ <b>Auto-Snipe Triggered!</b>`,
        `━━━━━━━━━━━━━━━━━`,
        `🪙 <b>${nameSafe}</b> (${symbolSafe})`,
        `📍 CA: <code>${ca}</code>`,
        `💲 Price: ${entryPrice}`,
        `💧 Liquidity: ${liqLabel}`,
        `━━━━━━━━━━━━━━━━━`,
        `💰 Buying: <b>${buyAmount} SOL</b> | 📉 Slippage: ${(slippageBps / 100).toFixed(1)}%`,
        `🚀 Sending via Jito bundle…`,
      ].join("\n")
    );

    const [trade] = await db.insert(tradesTable).values({
      userId: dbUserId,
      chain: "SOL",
      tokenAddress: ca,
      tokenSymbol,
      tokenName,
      side: "BUY",
      amountIn: String(buyAmount),
      feeBps: PLATFORM_FEE_BPS,
      priceUsd,
      status: "PENDING",
    }).returning();

    const lamports = Math.round(buyAmount * 1e9);
    const result = await executeSolBuy({
      walletAddress: wallet.address,
      encryptedPrivateKey: wallet.encryptedPrivateKey,
      ca,
      lamports,
      slippageBps,
      jitoTipLamports: jitoTip,
    });

    await db.update(tradesTable)
      .set({ status: "CONFIRMED", txHash: result.txHash })
      .where(eq(tradesTable.id, trade!.id));

    // ── Notify: position opened, with manage buttons ──────────────────────
    await send(
      [
        `✅ <b>Auto-Snipe Confirmed!</b>`,
        `━━━━━━━━━━━━━━━━━`,
        `🪙 <b>${nameSafe}</b> (${symbolSafe})`,
        `📍 CA: <code>${ca}</code>`,
        `💰 Spent: <b>${buyAmount} SOL</b>`,
        `💲 Entry: ${entryPrice}`,
        `🔗 TX: <code>${result.txHash}</code>`,
        `💸 1% platform fee applied`,
        ``,
        `Manage your new position below 👇`,
      ].join("\n"),
      [
        [
          { text: "📊 Live Price", callback_data: `price:${ca}` },
          { text: "🔍 Analyze", callback_data: `analyze:${ca}` },
        ],
        [
          { text: "📤 Sell 25%", callback_data: `sell:${ca}:25` },
          { text: "📤 Sell 50%", callback_data: `sell:${ca}:50` },
        ],
        [
          { text: "📤 Sell 75%", callback_data: `sell:${ca}:75` },
          { text: "📤 Sell 100%", callback_data: `sell:${ca}:100` },
        ],
      ]
    );

    logger.info({ ca, txHash: result.txHash, telegramId }, "Auto-snipe executed");
  } catch (err) {
    logger.error({ err, ca, telegramId }, "Auto-snipe buy failed");
    await send(
      [
        `❌ <b>Auto-Snipe Failed</b>`,
        `🪙 <b>${nameSafe}</b> (${symbolSafe})`,
        `📍 CA: <code>${ca}</code>`,
        `⚠️ ${escapeSnipeHtml(String(err).slice(0, 200))}`,
      ].join("\n"),
      [[{ text: "🔍 Analyze Token", callback_data: `analyze:${ca}` }]]
    );
  }
}

// ── Sell (ctx-based) ──────────────────────────────────────────────────────

async function executeSell(ctx: Context, ca: string, percent: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found."); return; }

  const wallet = await db.query.walletsTable.findFirst({
    where: and(
      eq(walletsTable.userId, user.id),
      eq(walletsTable.chain, user.activeChain),
      eq(walletsTable.isActive, true)
    ),
  });
  if (!wallet) { await ctx.reply("❌ No active wallet. Add one in 💼 Wallet Manager."); return; }

  const pairs = await getPairsByToken(ca);
  const pair = pairs[0];
  const priceUsd = pair?.priceUsd ?? "0";
  const tokenSymbol = pair?.baseToken.symbol ?? "UNKNOWN";
  const tokenName = pair?.baseToken.name ?? "UNKNOWN";

  await ctx.reply(`⏳ <b>Sell Order: ${percent}% of ${tokenSymbol}</b>\n🔐 Preparing transaction…`, { parse_mode: "HTML" });

  const [trade] = await db.insert(tradesTable).values({
    userId: user.id,
    chain: user.activeChain,
    tokenAddress: ca,
    tokenSymbol,
    tokenName,
    side: "SELL",
    amountIn: `${percent}%`,
    feeBps: PLATFORM_FEE_BPS,
    priceUsd,
    status: "PENDING",
  }).returning();

  try {
    let txHash: string | null = null;

    if (user.activeChain === "SOL") {
      const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
      const balRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTokenAccountsByOwner",
          params: [wallet.address, { mint: ca }, { encoding: "jsonParsed" }],
        }),
      });
      const balData = await balRes.json() as {
        result?: { value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[] };
      };
      const rawAmount = balData.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0";
      const sellAmount = Math.floor(parseInt(rawAmount, 10) * percent / 100);
      if (sellAmount === 0) throw new Error("No token balance to sell");

      const config = await db.query.sniperConfigsTable.findFirst({
        where: eq(sniperConfigsTable.userId, user.id),
      });
      const slippageBps = config?.slippageBps ?? 1000;
      const jitoTip = config?.jitoTipLamports ?? getJitoTipLamports();

      const quote = await getJupiterQuote(ca, SOL_MINT, sellAmount, slippageBps);
      if (!quote) throw new Error("Jupiter quote failed");

      const swapTx = await buildJupiterSwapTx(quote, wallet.address, jitoTip);
      if (!swapTx) throw new Error("Jupiter swap TX build failed");

      const sim = await simulateSolanaTx(swapTx);
      if (!sim.success) throw new Error(`Simulation failed: ${sim.error}`);

      const privateKey = decrypt(wallet.encryptedPrivateKey);
      const { Keypair, VersionedTransaction } = await import("@solana/web3.js");
      const bs58 = await import("bs58");
      const kp = Keypair.fromSecretKey(bs58.default.decode(privateKey));
      const txBytes = Buffer.from(swapTx, "base64");
      const vTx = VersionedTransaction.deserialize(txBytes);
      vTx.sign([kp]);
      const signedBase64 = Buffer.from(vTx.serialize()).toString("base64");

      txHash = await sendJitoBundle([signedBase64]);
      if (!txHash) throw new Error("Jito bundle rejected");

      const solOut = parseFloat(quote.outAmount) / 1e9;
      await db.update(tradesTable)
        .set({ status: "CONFIRMED", txHash, amountOut: String(solOut) })
        .where(eq(tradesTable.id, trade!.id));
    } else {
      await ctx.reply("⚠️ EVM sell: use a DEX frontend (Uniswap/PancakeSwap) until native EVM sell is available.");
      await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
      return;
    }

    await ctx.reply(
      [`✅ <b>Sell Confirmed!</b>`, `🪙 ${tokenSymbol} [${user.activeChain}]`,
       `📤 Sold: ${percent}% position`, `🔗 TX: <code>${txHash}</code>`,
       `💸 1% platform fee applied`].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📊 PnL Center", "pnl_center")],
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Sell execution failed");
    await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
    await ctx.reply(
      `❌ <b>Sell Failed</b>\n${String(err).slice(0, 200)}`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]]) }
    );
  }
}

// ── Live Price Tracker ────────────────────────────────────────────────────

function fmtPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "0";
  return p >= 1 ? p.toFixed(4) : p.toFixed(8);
}

/**
 * Edit-in-place when triggered from a button (so Refresh updates the same
 * message); falls back to a new reply from command context. A failed edit
 * with "message is not modified" is silently ignored (price unchanged).
 */
async function editOrReply(
  ctx: Context,
  text: string,
  extra: Parameters<Context["reply"]>[1]
): Promise<void> {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, extra as Parameters<Context["editMessageText"]>[1]);
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
      // fall through to reply
    }
  }
  await ctx.reply(text, extra);
}

export async function handleLivePrice(ctx: Context, ca: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) { await ctx.reply("❌ User not found. Type /start first."); return; }

  const pairs = await getPairsByToken(ca);
  const pair = pairs[0];

  if (!pair) {
    await editOrReply(ctx, `❌ No live market data found for:\n<code>${ca}</code>`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("🔄 Retry", `price:${ca}`),
          Markup.button.callback("🔍 Analyze", `analyze:${ca}`),
        ],
        [Markup.button.callback("⬅️ My Trades", "my_trades")],
      ]),
    });
    return;
  }

  const current = parseFloat(pair.priceUsd ?? "0");
  const tokenSymbol = pair.baseToken.symbol ?? "?";
  const tokenName = pair.baseToken.name ?? "Unknown";

  // Most recent confirmed BUY of this token → entry price for P&L
  const lastBuy = await db.query.tradesTable.findFirst({
    where: and(
      eq(tradesTable.userId, user.id),
      eq(tradesTable.tokenAddress, ca),
      eq(tradesTable.side, "BUY"),
      eq(tradesTable.status, "CONFIRMED")
    ),
    orderBy: [desc(tradesTable.createdAt)],
  });

  const lines = [
    `📊 <b>Live Price — ${tokenSymbol}</b>`,
    `—`,
    `🪙 <b>${tokenName}</b> [${tokenSymbol}]`,
    `📬 <code>${ca}</code>`,
    `—`,
    `💲 <b>Current Price:</b> $${fmtPrice(current)}`,
  ];

  if (lastBuy) {
    const entry = parseFloat(lastBuy.priceUsd);
    lines.push(`🎯 <b>Your Entry:</b> $${fmtPrice(entry)}`);
    if (entry > 0 && current > 0) {
      const pct = ((current - entry) / entry) * 100;
      lines.push(
        `${pct >= 0 ? "🟢" : "🔴"} <b>P&L:</b> ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% from entry`
      );
    }
    lines.push(`💰 <b>Position:</b> ${lastBuy.amountIn} ${lastBuy.chain} spent`);
  } else {
    lines.push(`ℹ️ No confirmed buys of this token yet.`);
  }

  lines.push(`—`, `🕐 Updated: ${new Date().toISOString().slice(11, 19)} UTC`);

  const sellRows = lastBuy
    ? [[
        Markup.button.callback("📤 25%", `sell:${ca}:25`),
        Markup.button.callback("📤 50%", `sell:${ca}:50`),
        Markup.button.callback("📤 75%", `sell:${ca}:75`),
        Markup.button.callback("📤 100%", `sell:${ca}:100`),
      ]]
    : [];

  await editOrReply(ctx, lines.join("\n"), {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("🔄 Refresh", `price:${ca}`),
        Markup.button.callback("🔍 Analyze", `analyze:${ca}`),
      ],
      ...sellRows,
      [Markup.button.callback("⬅️ My Trades", "my_trades")],
    ]),
  });
}
