/**
 * Returns true if the given Telegram user ID matches one of the two admin IDs.
 */
export function isAdmin(telegramId: number): boolean {
  const id1 = process.env["ADMIN_TELEGRAM_ID_1"];
  const id2 = process.env["ADMIN_TELEGRAM_ID_2"];
  return (
    (!!id1 && String(telegramId) === id1) ||
    (!!id2 && String(telegramId) === id2)
  );
}
