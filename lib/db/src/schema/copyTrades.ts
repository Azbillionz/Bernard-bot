import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const copyTradesTable = pgTable("bot_copy_trades", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  targetWallet: text("target_wallet").notNull(),
  chain: text("chain").notNull(),
  label: text("label").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CopyTrade = typeof copyTradesTable.$inferSelect;
