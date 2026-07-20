import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const sniperConfigsTable = pgTable("bot_sniper_configs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id)
    .unique(),
  minLiquidityUsd: text("min_liquidity_usd").notNull().default("5000"),
  maxTaxPercent: integer("max_tax_percent").notNull().default(10),
  honeypotCheck: boolean("honeypot_check").notNull().default(true),
  autoBuyAmountNative: text("auto_buy_amount_native").notNull().default("0.1"),
  slippageBps: integer("slippage_bps").notNull().default(1000),
  jitoTipLamports: integer("jito_tip_lamports").notNull().default(10000),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SniperConfig = typeof sniperConfigsTable.$inferSelect;
