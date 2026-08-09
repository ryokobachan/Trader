import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DEFAULT_WATCHLIST_NAME,
  DEFAULT_WATCHLIST_ITEMS,
  WatchlistInputError,
  normalizeReorderItemIds,
  normalizeWatchlistItemInput,
  normalizeWatchlistName,
} from "../app/platform/watchlist-contracts";

test("normalizes durable watchlist commands without accepting unsafe symbols or logo URLs", () => {
  assert.equal(DEFAULT_WATCHLIST_NAME, "Main Watchlist");
  assert.deepEqual(
    DEFAULT_WATCHLIST_ITEMS.map((item) => item.symbol),
    ["AAPL", "NVDA", "MSFT", "TSLA"],
  );
  assert.equal(normalizeWatchlistName("  AI・半導体  "), "AI・半導体");
  assert.deepEqual(
    normalizeWatchlistItemInput({
      instrumentId: "us_xnas_aapl",
      symbol: " aapl ",
      displayName: "Apple Inc.",
      exchange: "NASDAQ",
      logoUrl: "https://financialmodelingprep.com/image-stock/AAPL.png",
    }),
    {
      instrumentId: "us_xnas_aapl",
      symbol: "AAPL",
      displayName: "Apple Inc.",
      exchange: "NASDAQ",
      logoUrl: "https://financialmodelingprep.com/image-stock/AAPL.png",
    },
  );

  for (const input of [
    { instrumentId: "../aapl", symbol: "AAPL" },
    { instrumentId: "us_xnas_aapl", symbol: "../AAPL" },
    { instrumentId: "us_xnas_aapl", symbol: "AAPL", logoUrl: "javascript:alert(1)" },
  ]) {
    assert.throws(() => normalizeWatchlistItemInput(input), WatchlistInputError);
  }
});

test("requires a complete, duplicate-free order payload", () => {
  assert.deepEqual(normalizeReorderItemIds([]), []);
  assert.deepEqual(normalizeReorderItemIds(["one", "two"]), ["one", "two"]);
  assert.throws(() => normalizeReorderItemIds(["one", "one"]), WatchlistInputError);
  assert.throws(() => normalizeReorderItemIds("one"), WatchlistInputError);
});

test("generated D1 migration keeps transaction data relational and separate from market data", () => {
  const hosting = JSON.parse(readFileSync(".openai/hosting.json", "utf8")) as { d1: string | null };
  assert.equal(hosting.d1, "DB");

  const migration = readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`drizzle/${name}`, "utf8"))
    .join("\n")
    .replaceAll("--> statement-breakpoint", "");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(migration);

  const tableRows = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tableRows.map((row) => row.name),
    [
      "app_audit_events",
      "strategy_portfolio_transactions",
      "strategy_preferences",
      "watchlist_items",
      "watchlists",
    ],
  );
  assert.equal(tableRows.some((row) => /market|bar|fundamental/i.test(row.name)), false);

  db.exec(`
    INSERT INTO watchlists
      (id, owner_id, name, sort_order, is_default, version, created_at, updated_at)
    VALUES ('list-1', 'owner-1', 'Main', 0, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO watchlist_items
      (id, watchlist_id, owner_id, instrument_id, symbol, position, created_at, updated_at)
    VALUES ('item-1', 'list-1', 'owner-1', 'us_xnas_aapl', 'AAPL', 0,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `);
  assert.throws(
    () => db.exec(`INSERT INTO watchlist_items
      (id, watchlist_id, owner_id, instrument_id, symbol, position, created_at, updated_at)
      VALUES ('item-2', 'list-1', 'owner-1', 'us_xnas_aapl', 'AAPL', 1,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`),
    /UNIQUE constraint failed/,
  );
  db.exec("DELETE FROM watchlists WHERE id = 'list-1'");
  const remaining = db.prepare("SELECT COUNT(*) AS count FROM watchlist_items").get() as {
    count: number;
  };
  assert.equal(remaining.count, 0);
  db.close();
});
