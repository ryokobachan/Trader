import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * User-owned transactional state only. Market bars, fundamentals, provider
 * payloads, and backtest artifacts intentionally live outside this database.
 */
export const watchlists = sqliteTable(
  "watchlists",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "ck_watchlists_name_length",
      sql`length(${table.name}) BETWEEN 1 AND 60`,
    ),
    check(
      "ck_watchlists_is_default_boolean",
      sql`${table.isDefault} IN (0, 1)`,
    ),
    uniqueIndex("idx_watchlists_owner_name").on(table.ownerId, table.name),
    uniqueIndex("idx_watchlists_owner_default")
      .on(table.ownerId)
      .where(sql`${table.isDefault} = 1`),
    index("idx_watchlists_owner_order").on(table.ownerId, table.sortOrder),
  ],
);

export const watchlistItems = sqliteTable(
  "watchlist_items",
  {
    id: text("id").primaryKey(),
    watchlistId: text("watchlist_id")
      .notNull()
      .references(() => watchlists.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    instrumentId: text("instrument_id").notNull(),
    symbol: text("symbol").notNull(),
    displayName: text("display_name"),
    exchange: text("exchange"),
    logoUrl: text("logo_url"),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_watchlist_items_list_instrument").on(
      table.watchlistId,
      table.instrumentId,
    ),
    index("idx_watchlist_items_owner_list_position").on(
      table.ownerId,
      table.watchlistId,
      table.position,
    ),
  ],
);

export const appAuditEvents = sqliteTable(
  "app_audit_events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_app_audit_owner_created").on(table.ownerId, table.createdAt),
    index("idx_app_audit_owner_entity_action").on(
      table.ownerId,
      table.entityType,
      table.entityId,
      table.action,
    ),
  ],
);

export const strategyPortfolioTransactions = sqliteTable(
  "strategy_portfolio_transactions",
  {
    ownerId: text("owner_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    transactionId: text("transaction_id").notNull(),
    date: text("date").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side", { enum: ["buy", "sell", "dividend"] }).notNull(),
    shares: real("shares").notNull(),
    price: real("price").notNull(),
    fee: real("fee").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "ck_strategy_transactions_side",
      sql`${table.side} IN ('buy', 'sell', 'dividend')`,
    ),
    check("ck_strategy_transactions_shares", sql`${table.shares} > 0`),
    check("ck_strategy_transactions_price", sql`${table.price} >= 0`),
    check("ck_strategy_transactions_fee", sql`${table.fee} >= 0`),
    primaryKey({
      name: "pk_strategy_portfolio_transactions",
      columns: [table.ownerId, table.strategyId, table.transactionId],
    }),
    index("idx_strategy_transactions_owner_strategy_date").on(
      table.ownerId,
      table.strategyId,
      table.date,
    ),
  ],
);

/**
 * Owner-scoped presentation overrides for the immutable sample catalog.
 * A non-null deletedAt is a soft-delete tombstone; the deployment-owned
 * strategy definition and its portfolio transactions remain untouched.
 */
export const strategyPreferences = sqliteTable(
  "strategy_preferences",
  {
    ownerId: text("owner_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    nameOverride: text("name_override"),
    headlineOverride: text("headline_override"),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({
      name: "pk_strategy_preferences",
      columns: [table.ownerId, table.strategyId],
    }),
    check(
      "ck_strategy_preferences_name_length",
      sql`${table.nameOverride} IS NULL OR length(${table.nameOverride}) BETWEEN 1 AND 120`,
    ),
    check(
      "ck_strategy_preferences_headline_length",
      sql`${table.headlineOverride} IS NULL OR length(${table.headlineOverride}) BETWEEN 1 AND 500`,
    ),
    check(
      "ck_strategy_preferences_has_payload",
      sql`${table.nameOverride} IS NOT NULL OR ${table.headlineOverride} IS NOT NULL OR ${table.deletedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * Owner-scoped strategies created through the UI, CLI, or an AI agent.
 *
 * The versioned JSON definition keeps this user-facing extension point compact
 * while the surrounding columns provide ownership, optimistic concurrency,
 * soft deletion, and efficient listing without exposing implementation data.
 */
export const customStrategies = sqliteTable(
  "custom_strategies",
  {
    ownerId: text("owner_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    version: integer("version").notNull().default(1),
    definitionJson: text("definition_json").notNull(),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({
      name: "pk_custom_strategies",
      columns: [table.ownerId, table.strategyId],
    }),
    check("ck_custom_strategies_version", sql`${table.version} >= 1`),
    check(
      "ck_custom_strategies_definition_json",
      sql`json_valid(${table.definitionJson})`,
    ),
    index("idx_custom_strategies_owner_deleted_updated").on(
      table.ownerId,
      table.deletedAt,
      table.updatedAt,
    ),
  ],
);
