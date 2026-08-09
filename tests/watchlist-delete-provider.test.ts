import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { translate } from "../app/platform/i18n";
import {
  WatchlistStoreError,
  deleteWatchlist,
} from "../app/platform/watchlists.server";
import { installD1Binding } from "../db";

const pageSource = readFileSync("app/page.tsx", "utf8");
const routeSource = readFileSync("app/api/v1/watchlists/[watchlistId]/route.ts", "utf8");
const storeSource = readFileSync("app/platform/watchlists.server.ts", "utf8");

test("watchlist deletion is localized, confirmed, and unavailable for the last list", () => {
  assert.match(pageSource, /t\("watchlist\.delete"\)/);
  assert.match(pageSource, /setAppDialog\("watchlist-delete"\)/);
  assert.match(pageSource, /watchlists\.length <= 1/);
  assert.match(pageSource, /t\("watchlist\.deleteHelp", \{ name: activeWatchlist\.name \}\)/);
  assert.match(pageSource, /className="danger-action"/);

  assert.equal(translate("en", "watchlist.delete"), "Delete watchlist");
  assert.equal(translate("ja", "watchlist.delete"), "ウォッチリストを削除");
  assert.equal(
    translate("en", "watchlist.deleteSuccess", { name: "Momentum" }),
    "Deleted “Momentum”.",
  );
  assert.equal(
    translate("ja", "watchlist.deleteSuccess", { name: "モメンタム" }),
    "「モメンタム」を削除しました。",
  );
  assert.equal(translate("en", "watchlist.deleteLastRequired"), "At least one watchlist is required.");
  assert.equal(translate("ja", "watchlist.deleteLastRequired"), "ウォッチリストは1件以上必要です。");
});

test("successful deletion switches to the server-selected durable watchlist", () => {
  assert.match(pageSource, /method: "DELETE"/);
  assert.match(pageSource, /payload\.nextWatchlistId/);
  assert.match(pageSource, /selectWatchlist\(nextWatchlist\.id\)/);
  assert.match(pageSource, /isDefault: watchlist\.id === nextWatchlist\.id/);
  assert.match(routeSource, /type WatchlistDeletionResponse/);
  assert.match(routeSource, /\.\.\.deletion/);
});

test("D1 deletion protects only the last list and atomically promotes a replacement default", () => {
  assert.match(storeSource, /AND EXISTS \(/);
  assert.match(storeSource, /replacement\.owner_id = \? AND replacement\.id <> \?/);
  assert.match(storeSource, /"last_watchlist_required"/);
  assert.doesNotMatch(storeSource, /"default_watchlist_required"/);
  assert.match(storeSource, /SET is_default = 1, version = version \+ 1, updated_at = \?/);
  assert.match(storeSource, /WHERE changes\(\) = 1/);
  assert.match(storeSource, /const results = await db\.batch\(\[/);
  assert.match(storeSource, /watchlist\.default\.promoted/);
  assert.match(storeSource, /return \{ deletedId: watchlistId, nextWatchlistId: nextWatchlist\.id \}/);
});

type SqlValue = string | number | null;

class TwoReadBarrier {
  private arrivals = 0;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async wait(): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await this.released;
  }
}

class BarrierD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly barrier: TwoReadBarrier,
    private readonly values: SqlValue[] = [],
  ) {}

  bind(...values: SqlValue[]) {
    return new BarrierD1Statement(this.database, this.sql, this.barrier, values);
  }

  async first<T>(): Promise<T | null> {
    const value = (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
    if (this.sql === "SELECT * FROM watchlists WHERE owner_id = ? AND id = ? LIMIT 1") {
      await this.barrier.wait();
    }
    return value;
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

class BarrierD1Database {
  private readonly barrier = new TwoReadBarrier();

  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string) {
    return new BarrierD1Statement(this.database, sql, this.barrier);
  }

  async batch(statements: BarrierD1Statement[]) {
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
  return readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`drizzle/${name}`, "utf8"))
    .join("\n")
    .replaceAll("--> statement-breakpoint", "");
}

test("concurrent deletes cannot remove both of the final two watchlists", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(migrations());
  sqlite.exec(`
    INSERT INTO watchlists
      (id, owner_id, name, sort_order, is_default, version, created_at, updated_at)
    VALUES
      ('list-a', 'owner-race', 'A', 0, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('list-b', 'owner-race', 'B', 1, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  installD1Binding(new BarrierD1Database(sqlite) as unknown as D1Database);

  try {
    const results = await Promise.allSettled([
      deleteWatchlist("list-a", "owner-race"),
      deleteWatchlist("list-b", "owner-race"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof WatchlistStoreError);
    assert.equal(rejected.reason.code, "last_watchlist_required");

    const remaining = sqlite
      .prepare("SELECT id, is_default FROM watchlists WHERE owner_id = 'owner-race'")
      .all() as Array<{ id: string; is_default: number }>;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.is_default, 1);

    const deletionAudits = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM app_audit_events
        WHERE owner_id = 'owner-race' AND action = 'watchlist.deleted'`)
      .get() as { count: number };
    assert.equal(deletionAudits.count, 1);
  } finally {
    installD1Binding(undefined);
    sqlite.close();
  }
});
