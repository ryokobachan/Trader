import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DELETE, PATCH } from "../app/api/v1/strategy-preferences/[strategyId]/route";
import { GET } from "../app/api/v1/strategy-preferences/route";
import { SAMPLE_STRATEGY_DEFINITIONS } from "../app/features/strategy/sample-strategies";
import {
  StrategyPreferenceInputError,
  normalizeStrategyPreferenceId,
  normalizeStrategyPreferenceInput,
  type StrategyPreference,
} from "../app/platform/strategy-preference-contracts";
import {
  listStrategyPreferences,
  updateStrategyPreference,
} from "../app/platform/strategy-preferences.server";
import { installD1Binding } from "../db";

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

function context(strategyId: string) {
  return { params: Promise.resolve({ strategyId }) };
}

function request(method: "PATCH" | "DELETE", strategyId: string, body?: unknown) {
  return new Request(
    `http://localhost/api/v1/strategy-preferences/${encodeURIComponent(strategyId)}`,
    {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    },
  );
}

function migrations(): string {
  return readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`drizzle/${name}`, "utf8"))
    .join("\n")
    .replaceAll("--> statement-breakpoint", "");
}

test("validates the editable strategy surface without accepting arbitrary fields", () => {
  assert.equal(
    normalizeStrategyPreferenceId(" sample.rsi-14-mean-reversion.v1 "),
    "sample.rsi-14-mean-reversion.v1",
  );
  assert.deepEqual(
    normalizeStrategyPreferenceInput({
      name: "  RSI Pullback  ",
      headline: " Buy liquid shares after an oversold reading. ",
    }),
    {
      name: "RSI Pullback",
      headline: "Buy liquid shares after an oversold reading.",
    },
  );

  for (const input of [
    {},
    { name: "" },
    { headline: "line one\nline two" },
    { category: "User supplied" },
    { name: "x".repeat(121) },
    { headline: "x".repeat(501) },
  ]) {
    assert.throws(
      () => normalizeStrategyPreferenceInput(input),
      StrategyPreferenceInputError,
    );
  }
});

test("rejects an unknown built-in strategy before accessing D1", async () => {
  installD1Binding(undefined);
  const strategyId = "sample.not-in-catalog.v1";
  const response = await DELETE(
    request("DELETE", strategyId),
    context(strategyId),
  );
  assert.equal(response.status, 404);
  assert.equal(
    (await response.json() as { error: { code: string } }).error.code,
    "strategy_not_found",
  );
});

test("persists owner-scoped overrides and tombstones while protecting the last strategy", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  installD1Binding(new SqliteD1Database(sqlite) as unknown as D1Database);
  try {
    const initial = await GET(new Request("http://localhost/api/v1/strategy-preferences"));
    assert.equal(initial.status, 200);
    assert.deepEqual(
      (await initial.json() as { preferences: StrategyPreference[] }).preferences,
      [],
    );

    const strategyId = SAMPLE_STRATEGY_DEFINITIONS[0].id;
    const firstPatch = await PATCH(
      request("PATCH", strategyId, { name: "Technology Core" }),
      context(strategyId),
    );
    assert.equal(firstPatch.status, 200);
    assert.equal(
      (await firstPatch.json() as { preference: StrategyPreference }).preference.name,
      "Technology Core",
    );

    const secondPatch = await PATCH(
      request("PATCH", strategyId, { headline: "A customized sample strategy." }),
      context(strategyId),
    );
    const edited = (await secondPatch.json() as { preference: StrategyPreference }).preference;
    assert.equal(edited.name, "Technology Core");
    assert.equal(edited.headline, "A customized sample strategy.");
    assert.equal(edited.isDeleted, false);

    const otherOwnerStrategyId = SAMPLE_STRATEGY_DEFINITIONS[1].id;
    await updateStrategyPreference(
      otherOwnerStrategyId,
      { name: "Another owner's strategy" },
      "other-owner",
    );
    assert.deepEqual(
      (await listStrategyPreferences("other-owner")).map((preference) => preference.name),
      ["Another owner's strategy"],
    );
    sqlite.prepare(
      `INSERT INTO strategy_preferences
        (owner_id, strategy_id, name_override, created_at, updated_at)
       VALUES ('local-workspace', 'sample.retired.v1', 'Retired catalog item',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    const localBeforeDelete = await GET(
      new Request("http://localhost/api/v1/strategy-preferences"),
    );
    assert.equal(
      (await localBeforeDelete.json() as { preferences: StrategyPreference[] }).preferences
        .some((preference) => preference.name === "Another owner's strategy"),
      false,
    );
    assert.equal(
      (await listStrategyPreferences()).some(
        (preference) => preference.strategyId === "sample.retired.v1",
      ),
      false,
    );

    const firstDelete = await DELETE(
      request("DELETE", strategyId),
      context(strategyId),
    );
    assert.equal(firstDelete.status, 200);
    const firstTombstone = (await firstDelete.json() as {
      deletedId: string;
      preference: StrategyPreference;
    });
    assert.equal(firstTombstone.deletedId, strategyId);
    assert.equal(firstTombstone.preference.isDeleted, true);
    assert.ok(firstTombstone.preference.deletedAt);

    const repeatedDelete = await DELETE(
      request("DELETE", strategyId),
      context(strategyId),
    );
    assert.equal(repeatedDelete.status, 200);
    assert.equal(
      (await repeatedDelete.json() as { preference: StrategyPreference }).preference.deletedAt,
      firstTombstone.preference.deletedAt,
    );

    const editDeleted = await PATCH(
      request("PATCH", strategyId, { name: "Cannot restore by editing" }),
      context(strategyId),
    );
    assert.equal(editDeleted.status, 409);
    assert.equal(
      (await editDeleted.json() as { error: { code: string } }).error.code,
      "strategy_deleted",
    );

    for (const definition of SAMPLE_STRATEGY_DEFINITIONS.slice(1, -1)) {
      const response = await DELETE(
        request("DELETE", definition.id),
        context(definition.id),
      );
      assert.equal(response.status, 200);
    }

    const finalDefinition = SAMPLE_STRATEGY_DEFINITIONS.at(-1);
    assert.ok(finalDefinition);
    const lastDelete = await DELETE(
      request("DELETE", finalDefinition.id),
      context(finalDefinition.id),
    );
    assert.equal(lastDelete.status, 409);
    assert.equal(
      (await lastDelete.json() as { error: { code: string } }).error.code,
      "last_visible_strategy",
    );

    const list = await GET(new Request("http://localhost/api/v1/strategy-preferences"));
    const payload = await list.json() as { ownerId: string; preferences: StrategyPreference[] };
    assert.equal(payload.ownerId, "local-workspace");
    assert.equal(payload.preferences.filter((preference) => preference.isDeleted).length, 9);
    assert.equal(
      payload.preferences.some((preference) => preference.strategyId === finalDefinition.id),
      false,
    );

    const auditCount = sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM app_audit_events
         WHERE owner_id = 'local-workspace' AND entity_type = 'strategy_preference'`,
      )
      .get() as { count: number };
    assert.equal(auditCount.count, 11);
  } finally {
    installD1Binding(undefined);
    sqlite.close();
  }
});

test("migration separates strategy preferences from transactions and market data", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migrations());
  const insert = sqlite.prepare(
    `INSERT INTO strategy_preferences
      (owner_id, strategy_id, name_override, created_at, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );
  insert.run("owner-1", "sample.strategy.v1", "Owner one");
  insert.run("owner-2", "sample.strategy.v1", "Owner two");
  assert.throws(
    () => insert.run("owner-1", "sample.strategy.v1", "Duplicate"),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => insert.run("owner-1", "sample.blank.v1", ""),
    /CHECK constraint failed/,
  );

  const plan = sqlite
    .prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM strategy_preferences
       WHERE owner_id = ? ORDER BY strategy_id ASC`,
    )
    .all("owner-1") as Array<{ detail: string }>;
  assert.equal(plan.some((row) => row.detail.includes("USING INDEX")), true);

  const tables = sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  assert.equal(tables.some((row) => row.name === "strategy_preferences"), true);
  assert.equal(tables.some((row) => row.name === "strategy_portfolio_transactions"), true);
  assert.equal(tables.some((row) => /market|bar|fundamental/i.test(row.name)), false);
  sqlite.close();
});
