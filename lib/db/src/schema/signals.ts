import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const signalsTable = pgTable("bot_signals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  tokenAddress: text("token_address").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  chain: text("chain").notNull(),
  source: text("source").notNull(), // PUMPFUN | GROUP_SCAN | MANUAL | RUNNER | TRENDING
  priceUsd: text("price_usd").notNull().default("0"),
  triggeredAt: timestamp("triggered_at").notNull().defaultNow(),
});

export type Signal = typeof signalsTable.$inferSelect;
