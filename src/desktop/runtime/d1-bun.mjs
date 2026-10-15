import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

function statementMeta(result = {}) {
  return {
    duration: 0,
    changes: Number(result.changes ?? 0),
    last_row_id: Number(result.lastInsertRowid ?? 0),
    changed_db: Number(result.changes ?? 0) > 0,
    size_after: 0,
    rows_read: 0,
    rows_written: Number(result.changes ?? 0),
  };
}

function normalizeBinding(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

class BunD1PreparedStatement {
  #database;
  #query;
  #bindings;

  constructor(database, query, bindings = []) {
    this.#database = database;
    this.#query = query;
    this.#bindings = bindings;
  }

  bind(...values) {
    return new BunD1PreparedStatement(
      this.#database,
      this.#query,
      values.map(normalizeBinding),
    );
  }

  async first(columnName) {
    const row = this.#database.prepare(this.#query).get(...this.#bindings);
    if (row == null) return null;
    return columnName === undefined ? row : row[columnName] ?? null;
  }

  async all() {
    const results = this.#database.prepare(this.#query).all(...this.#bindings);
    return { success: true, results, meta: statementMeta() };
  }

  async run() {
    return this.execute();
  }

  async raw(options = {}) {
    const statement = this.#database.prepare(this.#query);
    const columnNames = statement.columnNames;
    const rows = statement.values(...this.#bindings);
    return options.columnNames ? [columnNames, ...rows] : rows;
  }

  execute() {
    const result = this.#database.prepare(this.#query).run(...this.#bindings);
    return { success: true, results: [], meta: statementMeta(result) };
  }
}

/**
 * Minimal D1-compatible wrapper over Bun's native SQLite implementation.
 * It covers the D1 surface Trader currently uses: prepare/bind/first/all/run
 * and atomic batch execution. Keeping this boundary D1-shaped lets the built
 * Worker and all existing route handlers run unchanged in the desktop app.
 */
export class BunD1Database {
  #database;

  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath, { create: true });
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = NORMAL");
    this.#database.exec("PRAGMA busy_timeout = 5000");
  }

  prepare(query) {
    return new BunD1PreparedStatement(this.#database, query);
  }

  async batch(statements) {
    const execute = this.#database.transaction(() => (
      statements.map((statement) => statement.execute())
    ));
    return execute.immediate();
  }

  async exec(query) {
    this.#database.exec(query);
    return { count: 0, duration: 0 };
  }

  close() {
    this.#database.close(false);
  }
}
