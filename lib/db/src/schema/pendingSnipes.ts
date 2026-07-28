import { pgTable, serial, integer, bigint, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const pendingSnipesTable = pgTable("bot_pending_snipes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
  chain: text("chain").notNull(),
  tokenAddress: text("token_address").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  tokenName: text("token_name").notNull(),
  priceUsd: text("price_usd").notNull().default("0"),
  liquidityUsd: text("liquidity_usd").notNull().default("0"),
  buyAmountNative: text("buy_amount_native").notNull(),
  fulfilled: boolean("fulfilled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export type PendingSnipe = typeof pendingSnipesTable.$inferSelect;
