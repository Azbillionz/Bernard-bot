  const text = [
    `⚙️ <b>Manage Wallet</b>`,
    `—`,
    `🏷 <b>Label:</b> ${escapeHtml(wallet.label)}`,
    `⛓ <b>Chain:</b> ${wallet.chain}`,
    `📬 <b>Address:</b>`,
    `<code>${wallet.address}</code>`,
    `💰 <b>Balance:</b> ${balance} ${symbol}`,
    wallet.isActive
      ? `🟢 This is your <b>active</b> ${wallet.chain} wallet`
      : `⚪ Not active — trades on ${wallet.chain} use your active wallet`,
    wallet.isTradeable
      ? `🔁 <b>In rotation</b> — snipes may use this wallet automatically`
      : `⏸ Not in rotation — mark tradeable to include it in auto-rotation`,
    `📅 Created: ${wallet.createdAt.toISOString().slice(0, 10)}`,
    `—`,
    `✏️ Rename · ✅ Set Active · 🔁 Tradeable · 🔑 Export Key · 🗑 Delete`,
  ].join("\n");

  const rows = [
    [
      Markup.button.callback("✏️ Rename", `wallet_rename:${wallet.id}`),
      Markup.button.callback("🔑 Export Key", `wallet_export:${wallet.id}`),
    ],
    ...(wallet.isActive
      ? []
      : [[Markup.button.callback("✅ Set as Active Wallet", `wallet_activate:${wallet.id}`)]]),
    [
      Markup.button.callback(
        wallet.isTradeable ? "⏸ Remove from Rotation" : "🔁 Add to Rotation",
        `wallet_toggle_tradeable:${wallet.id}`
      ),
    ],
    [
      Markup.button.callback(`💳 Deposit`, `deposit:${wallet.chain}`),
      Markup.button.callback("🗑 Delete Wallet", `wallet_del:${wallet.id}`),
    ],
    [Markup.button.callback("⬅️ Wallet Manager", "wallet_manager")],
  ];

  await sendOrEdit(ctx, text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
}

/**
 * Toggles a wallet in/out of the multi-wallet trading rotation. When 2+
 * wallets on the same chain are tradeable, buys rotate between them
 * (services/walletRotation.ts). Independent of "active" — a wallet can be
 * tradeable without being the active one, and vice versa.
 */
export async function handleToggleTradeable(ctx: Context, walletId: number): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const owned = await getOwnedWallet(telegramId, walletId);
  if (!owned) return;

  await db
    .update(walletsTable)
    .set({ isTradeable: !owned.wallet.isTradeable })
    .where(eq(walletsTable.id, walletId));

  await handleWalletDetail(ctx, walletId);
}
