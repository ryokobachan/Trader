import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

let runtimeD1Binding: D1Database | undefined;
let transactionSchemaPromise: Promise<void> | undefined;

export function installD1Binding(binding: D1Database | undefined): void {
  if (runtimeD1Binding !== binding) transactionSchemaPromise = undefined;
  runtimeD1Binding = binding;
}

export function getD1() {
  if (!runtimeD1Binding) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in src/worker/cloudflare.config.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return runtimeD1Binding;
}

export function getDb() {
  const d1 = getD1();

  return drizzle(d1, { schema });
}

const TRANSACTION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS watchlists (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_owner_name
    ON watchlists(owner_id, name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_owner_default
    ON watchlists(owner_id) WHERE is_default = 1`,
  `CREATE INDEX IF NOT EXISTS idx_watchlists_owner_order
    ON watchlists(owner_id, sort_order)`,
  `CREATE TABLE IF NOT EXISTS watchlist_items (
    id TEXT PRIMARY KEY NOT NULL,
    watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    display_name TEXT,
    exchange TEXT,
    logo_url TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_items_list_instrument
    ON watchlist_items(watchlist_id, instrument_id)`,
  `CREATE INDEX IF NOT EXISTS idx_watchlist_items_owner_list_position
    ON watchlist_items(owner_id, watchlist_id, position)`,
  `CREATE TABLE IF NOT EXISTS app_audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_app_audit_owner_created
    ON app_audit_events(owner_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_app_audit_owner_entity_action
    ON app_audit_events(owner_id, entity_type, entity_id, action)`,
  `CREATE TABLE IF NOT EXISTS strategy_portfolio_transactions (
    owner_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('buy', 'sell', 'dividend')),
    shares REAL NOT NULL CHECK(shares > 0),
    price REAL NOT NULL CHECK(price >= 0),
    fee REAL NOT NULL DEFAULT 0 CHECK(fee >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_strategy_portfolio_transactions
      PRIMARY KEY(owner_id, strategy_id, transaction_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_transactions_owner_strategy_date
    ON strategy_portfolio_transactions(owner_id, strategy_id, date DESC)`,
  `CREATE TABLE IF NOT EXISTS strategy_preferences (
    owner_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    name_override TEXT,
    headline_override TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_strategy_preferences PRIMARY KEY(owner_id, strategy_id),
    CONSTRAINT ck_strategy_preferences_name_length
      CHECK(name_override IS NULL OR length(name_override) BETWEEN 1 AND 120),
    CONSTRAINT ck_strategy_preferences_headline_length
      CHECK(headline_override IS NULL OR length(headline_override) BETWEEN 1 AND 500),
    CONSTRAINT ck_strategy_preferences_has_payload
      CHECK(name_override IS NOT NULL OR headline_override IS NOT NULL OR deleted_at IS NOT NULL)
  )`,
  `CREATE TABLE IF NOT EXISTS custom_strategies (
    owner_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
    definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_custom_strategies PRIMARY KEY(owner_id, strategy_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_custom_strategies_owner_deleted_updated
    ON custom_strategies(owner_id, deleted_at, updated_at)`,
] as const;

/**
 * Makes a fresh local preview usable before its first deployment migration.
 * Production deployments still apply the checked-in Drizzle migration.
 */
export function ensureTransactionDatabase(): Promise<void> {
  if (!transactionSchemaPromise) {
    const d1 = getD1();
    transactionSchemaPromise = d1
      .batch(TRANSACTION_SCHEMA_STATEMENTS.map((statement) => d1.prepare(statement)))
      .then(async () => {
        await d1.prepare("PRAGMA optimize").run();
      })
      .catch((error) => {
        transactionSchemaPromise = undefined;
        throw error;
      });
  }

  return transactionSchemaPromise;
}
