import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const tradesTable = pgTable("bot_trades", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  chain: text("chain").notNull(),
  tokenAddress: text("token_address").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  tokenName: text("token_name").notNull(),
  side: text("side").notNull(), // BUY | SELL
  amountIn: text("amount_in").notNull(),
  amountOut: text("amount_out").notNull().default("0"),
  priceUsd: text("price_usd").notNull().default("0"),
  txHash: text("tx_hash"),
  status: text("status").notNull().default("PENDING"), // PENDING | CONFIRMED | FAILED
  feeBps: integer("fee_bps").notNull().default(100),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Trade = typeof tradesTable.$inferSelect;
