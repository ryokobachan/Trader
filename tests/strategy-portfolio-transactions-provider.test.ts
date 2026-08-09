import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { GET } from "../app/api/v1/strategy-portfolios/[strategyId]/transactions/route";
import {
  INITIAL_STRATEGY_PORTFOLIO_TRANSACTIONS,
  StrategyPortfolioTransactionInputError,
  normalizeStrategyId,
  normalizeStrategyPortfolioTransactionInput,
} from "../app/platform/strategy-portfolio-contracts";
import { installD1Binding } from "../db";

function migrations(): string {
  return readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`drizzle/${name}`, "utf8"))
    .join("\n")
    .replaceAll("--> statement-breakpoint", "");
}

test("preserves the current strategy fixture through the canonical transaction contract", () => {
  assert.deepEqual(
    INITIAL_STRATEGY_PORTFOLIO_TRANSACTIONS.map(({ symbol, side }) => [symbol, side]),
    [
      ["NVDA", "buy"],
      ["AAPL", "buy"],
      ["MSFT", "dividend"],
      ["TSLA", "sell"],
      ["AAPL", "dividend"],
    ],
  );
  assert.equal(normalizeStrategyId("sample.rsi-14-mean-reversion.v1"), "sample.rsi-14-mean-reversion.v1");
  assert.deepEqual(
    normalizeStrategyPortfolioTransactionInput({
      transactionId: "ui-transaction-1",
      date: "2026-08-09",
      symbol: " aapl ",
      side: "buy",
      shares: 10.5,
      price: 231.41,
    }),
    {
      transactionId: "ui-transaction-1",
      date: "2026-08-09",
      symbol: "AAPL",
      side: "buy",
      shares: 10.5,
      price: 231.41,
      fee: 0,
    },
  );
});

test("rejects invalid strategy transaction dates, sides, symbols, and amounts", () => {
  const valid = {
    date: "2026-08-09",
    symbol: "AAPL",
    side: "buy",
    shares: 10,
    price: 231.41,
    fee: 0,
  };
  for (const input of [
    { ...valid, date: "2026-02-30" },
    { ...valid, side: "買付" },
    { ...valid, symbol: "../AAPL" },
    { ...valid, shares: 0 },
    { ...valid, price: -1 },
    { ...valid, fee: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => normalizeStrategyPortfolioTransactionInput(input),
      StrategyPortfolioTransactionInputError,
    );
  }
  assert.throws(() => normalizeStrategyId("../strategy"), StrategyPortfolioTransactionInputError);
});

test("rejects an invalid strategy route before accessing D1", async () => {
  const response = await GET(
    new Request("http://localhost/api/v1/strategy-portfolios/bad%2Fid/transactions"),
    { params: Promise.resolve({ strategyId: "bad/id" }) },
  );
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: { code: string } };
  assert.equal(payload.error.code, "invalid_request");
});

test("rejects an unknown well-formed strategy before GET can seed D1", async () => {
  installD1Binding(undefined);
  const strategyId = "sample.not-in-catalog.v1";
  const response = await GET(
    new Request(`http://localhost/api/v1/strategy-portfolios/${strategyId}/transactions`),
    { params: Promise.resolve({ strategyId }) },
  );
  assert.equal(response.status, 404);
  const payload = await response.json() as { error: { code: string } };
  assert.equal(payload.error.code, "strategy_not_found");
});

test("migration scopes transaction ids by owner and strategy and uses the ordered-query index", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migrations());
  const insert = db.prepare(`
    INSERT INTO strategy_portfolio_transactions
      (owner_id, strategy_id, transaction_id, date, symbol, side, shares, price, fee,
       created_at, updated_at)
    VALUES (?, ?, ?, '2026-08-09', 'AAPL', 'buy', 10, 231.41, 0,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  insert.run("owner-1", "strategy-a", "transaction-1");
  insert.run("owner-1", "strategy-b", "transaction-1");
  insert.run("owner-2", "strategy-a", "transaction-1");
  assert.throws(
    () => insert.run("owner-1", "strategy-a", "transaction-1"),
    /UNIQUE constraint failed/,
  );

  const plan = db
    .prepare(`EXPLAIN QUERY PLAN
      SELECT * FROM strategy_portfolio_transactions
      WHERE owner_id = ? AND strategy_id = ?
      ORDER BY date DESC`)
    .all("owner-1", "strategy-a") as Array<{ detail: string }>;
  assert.equal(
    plan.some((row) => row.detail.includes("idx_strategy_transactions_owner_strategy_date")),
    true,
  );

  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  assert.equal(tables.some((row) => /market|bar|fundamental/i.test(row.name)), false);
  db.close();
});
