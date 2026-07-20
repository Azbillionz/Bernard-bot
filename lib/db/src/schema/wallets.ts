import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const walletsTable = pgTable("bot_wallets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  chain: text("chain").notNull(), // SOL | ETH | BASE | BSC
  address: text("address").notNull(),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  label: text("label").notNull().default("Main Wallet"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Wallet = typeof walletsTable.$inferSelect;
