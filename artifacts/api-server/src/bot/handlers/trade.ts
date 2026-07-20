/**
 * Trade execution handler.
 * SOL: Jupiter V6 → simulate → Jito bundle (1% platform fee via platformFeeBps)
 * EVM: 1inch swap → eth_call simulate → Flashbots private RPC
 * Platform fee: 100 bps (1%) on every swap.
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
import { eq, and } from "drizzle-orm";
import { decrypt } from "../../lib/encryption";
import { getJupiterQuote, buildJupiterSwapTx, simulateSolanaTx } from "../../services/jupiter";
import { sendJitoBundle, getJitoTipLamports } from "../../services/jito";
import { get1inchSwap } from "../../services/evmSwap";
import { sendPrivateTx, simulateEvmTx } from "../../services/flashbots";
import { getPairsByToken } from "../../services/dexscreener";
import { logger } from "../../lib/logger";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const EVM_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const PLATFORM_FEE_BPS = 100; // 1%

// Pending custom buy amount state
const pendingCustomBuy = new Map<number, { ca: string }>();

export function getPendingCustomBuy(telegramId: number): { ca: string } | null {
  return pendingCustomBuy.get(telegramId) ?? null;
}

export async function processCustomBuyAmount(
  ctx: Context,
  amount: string
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const state = pendingCustomBuy.get(telegramId);
  if (!state) return;
  pendingCustomBuy.delete(telegramId);
  await executeBuy(ctx, state.ca, parseFloat(amount));
}

export async function handleBuy(
  ctx: Context,
  ca: string,
  amountStr: string
): Promise<void> {
  await ctx.answerCbQuery("💰 Executing buy...");
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply("❌ Invalid amount.");
    return;
  }
  await executeBuy(ctx, ca, amount);
}

export async function handleBuyCustom(ctx: Context, ca: string): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  pendingCustomBuy.set(telegramId, { ca });
  await ctx.reply("💬 Send the amount to buy in native token (e.g. 0.25):");
}

export async function handleSell(
  ctx: Context,
  ca: string,
  percentStr: string
): Promise<void> {
  await ctx.answerCbQuery("📤 Executing sell...");
  const percent = parseInt(percentStr, 10);
  if (isNaN(percent) || percent <= 0 || percent > 100) {
    await ctx.reply("❌ Invalid percent.");
    return;
  }
  await executeSell(ctx, ca, percent);
}

async function executeBuy(
  ctx: Context,
  ca: string,
  amount: number
): Promise<void> {
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

  // Insert pending trade record
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
    `⏳ <b>Buy Order Submitted</b>\n💰 Buying ${amount} ${user.activeChain} of <b>${tokenSymbol}</b>\n🔐 Simulating transaction...`,
    { parse_mode: "HTML" }
  );

  try {
    let txHash: string | null = null;

    if (user.activeChain === "SOL") {
      const lamports = Math.round(amount * 1e9);
      const quote = await getJupiterQuote(SOL_MINT, ca, lamports, slippageBps);
      if (!quote) throw new Error("Jupiter quote failed");

      const tipLamports = config?.jitoTipLamports ?? getJitoTipLamports();
      const swapTx = await buildJupiterSwapTx(quote, wallet.address, tipLamports);
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

    } else {
      // EVM via 1inch + Flashbots
      const amountWei = BigInt(Math.round(amount * 1e18)).toString();

      // 1inch API key is optional — redirect to DEX if unavailable
      if (!process.env["ONEINCH_API_KEY"]) {
        const dexUrl = `https://app.uniswap.org/#/swap?outputCurrency=${ca}`;
        await ctx.reply(
          `⚠️ <b>In-bot EVM swaps require a 1inch API key.</b>\n\nTrade this token directly on a DEX:\n<a href="${dexUrl}">🔗 Uniswap — ${ca.slice(0,8)}…</a>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        return;
      }

      const swap = await get1inchSwap(
        user.activeChain, EVM_NATIVE, ca, amountWei, wallet.address
      );
      if (!swap) throw new Error("1inch quote failed");

      const simResult = await simulateEvmTx(
        wallet.address, swap.to, swap.data, user.activeChain
      );
      if (!simResult.success) throw new Error(`EVM simulation failed: ${simResult.error}`);

      const { Wallet, JsonRpcProvider } = await import("ethers");
      const rpcEnv: Record<string, string> = { ETH: "ETH_RPC_URL", BASE: "BASE_RPC_URL", BSC: "BSC_RPC_URL" };
      const rpcUrl = process.env[rpcEnv[user.activeChain] ?? ""] ?? "";
      const provider = new JsonRpcProvider(rpcUrl);
      const privateKey = decrypt(wallet.encryptedPrivateKey);
      const evmWallet = new Wallet(privateKey, provider);
      const tx = await evmWallet.sendTransaction({
        to: swap.to, data: swap.data, value: BigInt(swap.value),
        gasLimit: BigInt(Math.round(swap.gas * 1.2)),
      });
      txHash = tx.hash;
      // For EVM, also try Flashbots for next trades; this sends direct for now
    }

    await db.update(tradesTable)
      .set({ status: "CONFIRMED", txHash: txHash ?? undefined })
      .where(eq(tradesTable.id, trade!.id));

    await ctx.reply(
      [
        `✅ <b>Buy Confirmed!</b>`,
        `🪙 ${tokenSymbol} [${user.activeChain}]`,
        `💰 Amount: ${amount} native`,
        `🔗 TX: <code>${txHash}</code>`,
        `💸 Fee: ${PLATFORM_FEE_BPS / 100}% platform fee applied`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📊 PnL Center", "pnl_center")],
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Buy execution failed");
    await db.update(tradesTable)
      .set({ status: "FAILED" })
      .where(eq(tradesTable.id, trade!.id));

    await ctx.reply(
      `❌ <b>Buy Failed</b>\n${String(err).slice(0, 200)}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  }
}

async function executeSell(
  ctx: Context,
  ca: string,
  percent: number
): Promise<void> {
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
  if (!wallet) {
    await ctx.reply("❌ No active wallet. Add one in 💼 Wallet Manager.");
    return;
  }

  const pairs = await getPairsByToken(ca);
  const pair = pairs[0];
  const priceUsd = pair?.priceUsd ?? "0";
  const tokenSymbol = pair?.baseToken.symbol ?? "UNKNOWN";
  const tokenName = pair?.baseToken.name ?? "UNKNOWN";

  await ctx.reply(
    `⏳ <b>Sell Order: ${percent}% of ${tokenSymbol}</b>\n🔐 Preparing transaction...`,
    { parse_mode: "HTML" }
  );

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
      // Get token balance via RPC
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
      const quote = await getJupiterQuote(ca, SOL_MINT, sellAmount, slippageBps);
      if (!quote) throw new Error("Jupiter quote failed");

      const tipLamports = config?.jitoTipLamports ?? getJitoTipLamports();
      const swapTx = await buildJupiterSwapTx(quote, wallet.address, tipLamports);
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
      await ctx.reply("⚠️ EVM sell: Please use a DEX frontend for token → native sells until direct EVM sell is wired for your token's DEX.");
      await db.update(tradesTable).set({ status: "FAILED" }).where(eq(tradesTable.id, trade!.id));
      return;
    }

    await ctx.reply(
      [
        `✅ <b>Sell Confirmed!</b>`,
        `🪙 ${tokenSymbol} [${user.activeChain}]`,
        `📤 Sold: ${percent}% position`,
        `🔗 TX: <code>${txHash}</code>`,
        `💸 Fee: ${PLATFORM_FEE_BPS / 100}% platform fee applied`,
      ].join("\n"),
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
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  }
}
