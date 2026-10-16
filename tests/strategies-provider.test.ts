import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  GET as listStrategiesRoute,
  POST as createStrategyRoute,
} from "../src/app/api/v1/strategies/route";
import {
  DELETE as deleteStrategyRoute,
  GET as getStrategyRoute,
  PATCH as updateStrategyRoute,
} from "../src/app/api/v1/strategies/[strategyId]/route";
import {
  GET as listTransactionsRoute,
  POST as createTransactionRoute,
} from "../src/app/api/v1/strategy-portfolios/[strategyId]/transactions/route";
import {
  DELETE as deleteTransactionRoute,
  GET as getTransactionRoute,
  PATCH as updateTransactionRoute,
} from "../src/app/api/v1/strategy-portfolios/[strategyId]/transactions/[transactionId]/route";
import {
  StrategyInputError,
  normalizeCreateStrategyInput,
  normalizeUpdateStrategyInput,
  performanceFromTransactionLedger,
  type StrategyDetailResponse,
  type StrategyRecord,
} from "../src/app/platform/strategy-contracts";
import { installD1Binding } from "../src/db";

type SqlValue = string | number | null;

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SqlValue[] = [],
  ) {}

  bind(...values: SqlValue[]) {
    return new SqliteD1Statement(this.database, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      results: this.database.prepare(this.sql).all(...this.values) as T[],
      success: true,
      meta: {},
    };
  }

  async run() {
    return this.runImmediately();
  }

  runImmediately() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

class SqliteD1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string) {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runImmediately());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function migrations(): string {
  return readdirSync("src/db/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`src/db/migrations/${name}`, "utf8"))
    .join("\n")
    .replaceAll("--> statement-breakpoint", "");
}

function strategyContext(strategyId: string) {
  return { params: Promise.resolve({ strategyId }) };
}

function transactionContext(strategyId: string, transactionId: string) {
  return { params: Promise.resolve({ strategyId, transactionId }) };
}

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

test("validates custom strategy definitions and optimistic versions", () => {
  assert.deepEqual(
    normalizeCreateStrategyInput({
      strategyId: "custom.agent-demo.v1",
      name: " Agent demo ",
      headline: " Managed through the public API. ",
      sourceLabels: ["Close", "SMA 50"],
      performance: { netReturn: 8.25, trades: 12 },
    }),
    {
      strategyId: "custom.agent-demo.v1",
      name: "Agent demo",
      headline: "Managed through the public API.",
      sourceLabels: ["Close", "SMA 50"],
      performance: { netReturn: 8.25, trades: 12 },
    },
  );
  assert.deepEqual(normalizeUpdateStrategyInput({ expectedVersion: 2, name: "New name" }), {
    expectedVersion: 2,
    name: "New name",
  });
  for (const input of [
    { name: "No headline" },
    { name: "Name", headline: "Headline", performance: { provenance: "fabricated" } },
    { name: "Name", headline: "Headline", sourceLabels: ["Price", "Price"] },
  ]) {
    assert.throws(() => normalizeCreateStrategyInput(input), StrategyInputError);
  }
  assert.throws(() => normalizeUpdateStrategyInput({ expectedVersion: 1 }), StrategyInputError);
  assert.deepEqual(
    performanceFromTransactionLedger(
      {
        provenance: "unavailable",
        netReturn: null,
        maxDrawdown: null,
        recoveryFactor: null,
        sharpe: null,
        forwardReturn: null,
        winRate: null,
        trades: null,
        symbols: null,
        cash: null,
      },
      [{ symbol: "AAPL" }, { symbol: "AAPL" }, { symbol: "MSFT" }],
    ),
    {
      provenance: "transaction_snapshot",
      netReturn: null,
      maxDrawdown: null,
      recoveryFactor: null,
      sharpe: null,
      forwardReturn: null,
      winRate: null,
      trades: 3,
      symbols: 2,
      cash: null,
    },
  );
});

test("unified APIs manage owner-scoped strategies and transaction items without read seeding", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(migrations());
  installD1Binding(new SqliteD1Database(sqlite) as unknown as D1Database);
  const strategyId = "custom.agent-demo.v1";
  const transactionId = "agent-trade-1";
  try {
    const initial = await listStrategiesRoute(
      new Request("http://localhost/api/v1/strategies?locale=en"),
    );
    assert.equal(initial.status, 200);
    const packagedStrategies = (
      await initial.json() as { strategies: StrategyRecord[] }
    ).strategies;
    assert.deepEqual(
      packagedStrategies.map((strategy) => strategy.id),
      [
        "portfolio-golden-cross",
        "portfolio-lightgbm-ranking",
        "portfolio-fundamental-quality-value",
      ],
    );
    assert.equal(packagedStrategies.every((strategy) => strategy.origin === "built_in"), true);
    const [goldenCross, lightgbm, fundamental] = packagedStrategies;
    assert.ok(goldenCross && lightgbm && fundamental);
    assert.equal(goldenCross.performance.provenance, "backtest_artifact");
    assert.equal(goldenCross.performance.trades, 1107);
    assert.equal(goldenCross.performance.symbols, 10);
    assert.equal(lightgbm.performance.provenance, "unavailable");
    assert.equal(
      Object.values(lightgbm.performance).slice(1).every((value) => value === null),
      true,
    );
    assert.deepEqual(fundamental.performance, {
      provenance: "backtest_artifact",
      netReturn: 368.1025793434192,
      maxDrawdown: -17.05929982739528,
      recoveryFactor: 21.57782459232522,
      sharpe: 1.3382241005530606,
      forwardReturn: null,
      winRate: 64.62585034013605,
      trades: 302,
      symbols: 14,
      cash: 79.49085385585573,
    });

    const packageTransactions = await listTransactionsRoute(
      new Request("http://localhost/api/v1/strategy-portfolios/portfolio-golden-cross/transactions"),
      strategyContext("portfolio-golden-cross"),
    );
    assert.equal(packageTransactions.status, 200);
    const packagedTransactions = (await packageTransactions.json() as {
      transactions: Array<{ date: string; symbol: string; side: string }>;
    }).transactions;
    assert.equal(packagedTransactions.length, 1107);
    assert.deepEqual(
      packagedTransactions[0],
      {
        ...packagedTransactions[0],
        date: "2025-12-03",
        symbol: "AAPL",
        side: "sell",
      },
    );
    assert.equal(
      packagedTransactions.every((transaction, index) => (
        index === 0 || packagedTransactions[index - 1]!.date >= transaction.date
      )),
      true,
      "package transactions must be newest first",
    );
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM strategy_portfolio_transactions").get() as {
        count: number;
      }).count,
      0,
      "package reads must not seed the owner ledger",
    );

    const fundamentalTransactionsResponse = await listTransactionsRoute(
      new Request("http://localhost/api/v1/strategy-portfolios/portfolio-fundamental-quality-value/transactions"),
      strategyContext("portfolio-fundamental-quality-value"),
    );
    assert.equal(fundamentalTransactionsResponse.status, 200);
    const fundamentalTransactions = (await fundamentalTransactionsResponse.json() as {
      transactions: Array<{ date: string; symbol: string; side: string }>;
    }).transactions;
    assert.equal(fundamentalTransactions.length, 302);
    assert.deepEqual(fundamentalTransactions[0], {
      ...fundamentalTransactions[0],
      date: "2025-12-09",
      symbol: "PG",
      side: "sell",
    });

    const packageMutation = await createTransactionRoute(
      jsonRequest(
        "/api/v1/strategy-portfolios/portfolio-golden-cross/transactions",
        "POST",
        {
          transactionId: "must-not-write",
          date: "2026-08-10",
          symbol: "AAPL",
          side: "buy",
          shares: 1,
          price: 220,
          fee: 0,
        },
      ),
      strategyContext("portfolio-golden-cross"),
    );
    assert.equal(packageMutation.status, 409);
    assert.equal(
      (await packageMutation.json() as { error: { code: string } }).error.code,
      "strategy_package_transactions_read_only",
    );

    const create = await createStrategyRoute(jsonRequest(
      "/api/v1/strategies",
      "POST",
      {
        strategyId,
        name: "Agent demo",
        headline: "Managed through the canonical strategy API.",
        category: "Automation",
        sourceLabels: ["Close"],
        performance: { netReturn: 4.5, sharpe: null },
      },
    ));
    assert.equal(create.status, 201);
    const created = (await create.json() as { strategy: StrategyRecord }).strategy;
    assert.equal(created.origin, "custom");
    assert.equal(created.version, 1);
    assert.equal(created.performance.provenance, "user_supplied");

    const duplicate = await createStrategyRoute(jsonRequest(
      "/api/v1/strategies",
      "POST",
      { strategyId, name: "Duplicate", headline: "Must not replace existing data." },
    ));
    assert.equal(duplicate.status, 409);
    assert.equal(
      (await duplicate.json() as { error: { code: string } }).error.code,
      "strategy_id_conflict",
    );

    const emptyTransactions = await listTransactionsRoute(
      new Request(`http://localhost/api/v1/strategy-portfolios/${strategyId}/transactions`),
      strategyContext(strategyId),
    );
    assert.equal(emptyTransactions.status, 200);
    assert.deepEqual(
      (await emptyTransactions.json() as { transactions: unknown[] }).transactions,
      [],
      "GET must never seed sample rows",
    );

    const transactionInput = {
      transactionId,
      date: "2026-08-10",
      symbol: "AAPL",
      side: "buy",
      shares: 5,
      price: 220.25,
      fee: 1,
    };
    const addTransaction = await createTransactionRoute(
      jsonRequest(
        `/api/v1/strategy-portfolios/${strategyId}/transactions`,
        "POST",
        transactionInput,
      ),
      strategyContext(strategyId),
    );
    assert.equal(addTransaction.status, 201);

    const concurrentId = "agent-concurrent-trade";
    const concurrentInput = { ...transactionInput, transactionId: concurrentId };
    const concurrentResponses = await Promise.all([
      createTransactionRoute(
        jsonRequest(
          `/api/v1/strategy-portfolios/${strategyId}/transactions`,
          "POST",
          concurrentInput,
        ),
        strategyContext(strategyId),
      ),
      createTransactionRoute(
        jsonRequest(
          `/api/v1/strategy-portfolios/${strategyId}/transactions`,
          "POST",
          concurrentInput,
        ),
        strategyContext(strategyId),
      ),
    ]);
    assert.deepEqual(
      concurrentResponses.map(({ status }) => status).sort(),
      [200, 201],
      "the same idempotency key must create once and replay once",
    );
    const concurrentAuditCount = sqlite.prepare(
      `SELECT COUNT(*) AS count FROM app_audit_events
       WHERE owner_id = 'local-workspace'
         AND action = 'strategy_portfolio.transaction.created'
         AND json_extract(payload_json, '$.transactionId') = ?`,
    ).get(concurrentId) as { count: number };
    assert.equal(concurrentAuditCount.count, 1);

    const detail = await getStrategyRoute(
      new Request(
        `http://localhost/api/v1/strategies/${strategyId}?include=transactions,performance`,
      ),
      strategyContext(strategyId),
    );
    assert.equal(detail.status, 200);
    const detailPayload = await detail.json() as StrategyDetailResponse;
    assert.equal(detailPayload.transactions?.length, 2);
    assert.equal(detailPayload.performance?.provenance, "user_supplied");

    const getTransaction = await getTransactionRoute(
      new Request(
        `http://localhost/api/v1/strategy-portfolios/${strategyId}/transactions/${transactionId}`,
      ),
      transactionContext(strategyId, transactionId),
    );
    assert.equal(getTransaction.status, 200);
    const transactionBeforeUpdate = (await getTransaction.json() as {
      transaction: { updatedAt: string };
    }).transaction;

    const missingLockToken = await updateTransactionRoute(
      jsonRequest(
        `/api/v1/strategy-portfolios/${strategyId}/transactions/${transactionId}`,
        "PATCH",
        { ...transactionInput, transactionId: undefined, price: 221.75 },
      ),
      transactionContext(strategyId, transactionId),
    );
    assert.equal(missingLockToken.status, 400);

    const updateTransaction = await updateTransactionRoute(
      jsonRequest(
        `/api/v1/strategy-portfolios/${strategyId}/transactions/${transactionId}`,
        "PATCH",
        {
          ...transactionInput,
          transactionId: undefined,
          price: 221.75,
          expectedUpdatedAt: transactionBeforeUpdate.updatedAt,
        },
      ),
      transactionContext(strategyId, transactionId),
    );
    assert.equal(updateTransaction.status, 200);
    const updatedTransaction = (await updateTransaction.json() as {
      transaction: { price: number; updatedAt: string };
    }).transaction;
    assert.equal(updatedTransaction.price, 221.75);
    assert.notEqual(updatedTransaction.updatedAt, transactionBeforeUpdate.updatedAt);

    const staleTransactionUpdate = await updateTransactionRoute(
      jsonRequest(
        `/api/v1/strategy-portfolios/${strategyId}/transactions/${transactionId}`,
        "PATCH",
        {
          ...transactionInput,
          transactionId: undefined,
          price: 999,
          expectedUpdatedAt: transactionBeforeUpdate.updatedAt,
        },
      ),
      transactionContext(strategyId, transactionId),
    );
    assert.equal(staleTransactionUpdate.status, 409);
    assert.equal(
      (await staleTransactionUpdate.json() as { error: { code: string } }).error.code,
      "transaction_changed",
    );
    const transactionAfterConflict = await getTransactionRoute(
      new Request(
        `http://localhost/api/v1/strategy-portfolios/${strategyId}/transactions/${transactionId}`,
      ),
      transactionContext(strategyId, transactionId),
    );
    assert.equal(
      (await transactionAfterConflict.json() as { transaction: { price: number } }).transaction.price,
      221.75,
      "a stale PATCH must not overwrite the winning transaction",
    );

    const staleUpdate = await updateStrategyRoute(
      jsonRequest(`/api/v1/strategies/${strategyId}`, "PATCH", {
        expectedVersion: 7,
        name: "Stale edit",
      }),
      strategyContext(strategyId),
    );
    assert.equal(staleUpdate.status, 409);

    const update = await updateStrategyRoute(
      jsonRequest(`/api/v1/strategies/${strategyId}?locale=en`, "PATCH", {
        expectedVersion: 1,
        name: "Agent demo v2",
      }),
      strategyContext(strategyId),
    );
    assert.equal(update.status, 200);
    assert.equal((await update.json() as { strategy: StrategyRecord }).strategy.version, 2);

    const deleteTransaction = await deleteTransactionRoute(
      jsonRequest(
        `/api/v1/strategy-portfolios/${strategyId}/transactions/${transactionId}`,
        "DELETE",
      ),
      transactionContext(strategyId, transactionId),
    );
    assert.equal(deleteTransaction.status, 200);
    assert.equal((await deleteTransaction.json() as { deleted: boolean }).deleted, true);

    const repeatDeleteTransaction = await deleteTransactionRoute(
      jsonRequest(
        `/api/v1/strategy-portfolios/${strategyId}/transactions/${transactionId}`,
        "DELETE",
      ),
      transactionContext(strategyId, transactionId),
    );
    assert.equal(repeatDeleteTransaction.status, 200);
    assert.equal((await repeatDeleteTransaction.json() as { deleted: boolean }).deleted, false);

    const deleteStrategy = await deleteStrategyRoute(
      jsonRequest(`/api/v1/strategies/${strategyId}?expectedVersion=2`, "DELETE"),
      strategyContext(strategyId),
    );
    assert.equal(deleteStrategy.status, 200);
    assert.equal((await deleteStrategy.json() as { version: number }).version, 3);

    const repeatDeleteStrategy = await deleteStrategyRoute(
      jsonRequest(`/api/v1/strategies/${strategyId}?expectedVersion=2`, "DELETE"),
      strategyContext(strategyId),
    );
    assert.equal(repeatDeleteStrategy.status, 200);
    assert.equal((await repeatDeleteStrategy.json() as { version: number }).version, 3);

    const missing = await getStrategyRoute(
      new Request(`http://localhost/api/v1/strategies/${strategyId}`),
      strategyContext(strategyId),
    );
    assert.equal(missing.status, 404);

    const stored = sqlite.prepare(
      `SELECT version, deleted_at FROM custom_strategies
       WHERE owner_id = 'local-workspace' AND strategy_id = ?`,
    ).get(strategyId) as { version: number; deleted_at: string | null };
    assert.equal(stored.version, 3);
    assert.ok(stored.deleted_at);
    const audits = sqlite.prepare(
      `SELECT action FROM app_audit_events
       WHERE owner_id = 'local-workspace' ORDER BY created_at, action`,
    ).all() as Array<{ action: string }>;
    assert.equal(audits.some(({ action }) => action === "strategy.created"), true);
    assert.equal(audits.some(({ action }) => action === "strategy.updated"), true);
    assert.equal(audits.some(({ action }) => action === "strategy.deleted"), true);
    assert.equal(
      audits.some(({ action }) => action === "strategy_portfolio.transactions.seeded.v1"),
      false,
    );
  } finally {
    installD1Binding(undefined);
    sqlite.close();
  }
});

test("custom strategy migration enforces owner scope, versions, and valid JSON", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migrations());
  const insert = sqlite.prepare(
    `INSERT INTO custom_strategies
      (owner_id, strategy_id, version, definition_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  insert.run("owner-1", "custom.same-id", 1, "{}");
  insert.run("owner-2", "custom.same-id", 1, "{}");
  assert.throws(() => insert.run("owner-1", "custom.same-id", 1, "{}"), /UNIQUE/);
  assert.throws(() => insert.run("owner-1", "custom.zero", 0, "{}"), /CHECK/);
  assert.throws(() => insert.run("owner-1", "custom.invalid-json", 1, "{"), /CHECK/);
  sqlite.close();
});
