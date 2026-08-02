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
  // 0 = no minimum/maximum set (filter not applied)
  minMarketCapUsd: text("min_market_cap_usd").notNull().default("0"),
  maxMarketCapUsd: text("max_market_cap_usd").notNull().default("0"),
  minAgeMinutes: integer("min_age_minutes").notNull().default(0),
  maxAgeMinutes: integer("max_age_minutes").notNull().default(0),
  minBuyRatioPercent: integer("min_buy_ratio_percent").notNull().default(0),
  // "fixed" = always buy autoBuyAmountNative; "percent" = buy positionSizePercent% of current wallet balance
  buySizeMode: text("buy_size_mode").notNull().default("fixed"),
  positionSizePercent: integer("position_size_percent").notNull().default(10),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SniperConfig = typeof sniperConfigsTable.$inferSelect;
