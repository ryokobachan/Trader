import assert from "node:assert/strict";
import test from "node:test";
import { migrateProductStorage } from "../src/app/platform/product-storage-migration";

test("product migration copies legacy preferences and preserves newer values and original keys", () => {
  const values = new Map([
    ["unicorn.locale", "ja"],
    ["unicorn.chart-templates.v1", '{"schemaVersion":"unicorn.chart-templates.v1"}'],
    ["unicorn.active-watchlist.v1", "old"],
    ["trader.active-watchlist.v1", "new"],
    ["other.preference", "untouched"],
  ]);
  const storage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as Storage;
  migrateProductStorage(storage);
  migrateProductStorage(storage);
  assert.equal(values.get("trader.locale"), "ja");
  assert.equal(values.get("trader.chart-templates.v1"), '{"schemaVersion":"trader.chart-templates.v1"}');
  assert.equal(values.get("trader.active-watchlist.v1"), "new");
  assert.equal(values.get("unicorn.locale"), "ja");
  assert.equal(values.get("other.preference"), "untouched");
});

test("product migration tolerates unavailable storage", () => {
  assert.doesNotThrow(() => migrateProductStorage({ get length(): number { throw new Error("disabled"); } } as unknown as Storage));
});
