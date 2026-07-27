import { pgTable, serial, integer, bigint, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const activeSnipesTable = pgTable("bot_active_snipes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
  chain: text("chain").notNull(),
  tokenAddress: text("token_address").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  tokenName: text("token_name").notNull(),
  entryPriceUsd: text("entry_price_usd").notNull().default("0"),
  active: boolean("active").notNull().default(true),
  lastNotifiedAt: timestamp("last_notified_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ActiveSnipe = typeof activeSnipesTable.$inferSelect;
