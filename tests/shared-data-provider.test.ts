import assert from "node:assert/strict";
import test from "node:test";
import { createSharedDataClient, SharedDataError, validateSharedData } from "../api/shared-data/client.server";
import { TraderDataClient, TraderDataError } from "../clients/javascript/trader-data.mjs";

const env = { TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791", TRADER_TRADINGVIEW_SIDECAR_TOKEN: "test-private-token" };
function data(overrides = {}) { return { schemaVersion: "trader.shared-data.v1", dataset: "x-mentions", rows: [{ published_at: "2026-01-01T00:00:00Z", net_return: null }], columns: [{ key: "published_at", label: "published_at" }], source: { id: "x-finance", kind: "shared-store", access: "read-only-sqlite" }, provenance: { revision: "20260907T000000.000000Z-1234abcd", readAt: "2026-09-07T00:00:00Z", publishedAt: "2026-09-07T00:00:00Z" }, coverage: { status: "partial", returned: 1 }, pagination: { limit: 10, nextCursor: null, hasMore: false }, warnings: [], ...overrides }; }

test("shared reader retains native dates, coverage, provenance and nulls through the authenticated fixed endpoint", async () => {
  let called = false;
  const client = createSharedDataClient(env, async (url, init) => {
    called = true; assert.equal(String(url), "http://127.0.0.1:8791/v1/shared-data/x-mentions?symbol=AAPL");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-private-token");
    assert.equal(init?.redirect, "manual"); return Response.json(data());
  });
  const result = await client.get("x-mentions", new URLSearchParams({ symbol: "AAPL" }));
  assert.ok(called); assert.deepEqual(result, data());
});

test("shared transport rejects missing configuration, redirect and mismatched dataset/schema", async () => {
  await assert.rejects(createSharedDataClient({}).get("x-mentions", new URLSearchParams()), (error: unknown) => error instanceof SharedDataError && error.status === 503);
  await assert.rejects(createSharedDataClient(env, async () => new Response(null, { status: 302, headers: { Location: "https://example.invalid/private" } })).get("x-mentions", new URLSearchParams()), SharedDataError);
  for (const value of [data({ dataset: "x-posts" }), data({ rows: [null] }), data({ pagination: { limit: 1001, nextCursor: null } })]) assert.throws(() => validateSharedData(value, "x-mentions"), SharedDataError);
});

test("publication conflicts remain actionable while upstream details are sanitized", async () => {
  for (const [code, expected] of [["shared_cursor_revision_changed", "shared_cursor_revision_changed"], ["secret internal path", "unavailable"]]) {
    const client = createSharedDataClient(env, async () => Response.json({ error: code, message: "secret path" }, { status: 409 }));
    await assert.rejects(client.get("x-mentions", new URLSearchParams()), (error: unknown) => error instanceof SharedDataError && error.status === 409 && error.code === expected && !error.message.includes("secret"));
  }
});

test("JS client continues empty scan pages and preserves the native response", async () => {
  const urls: string[] = [];
  const client = new TraderDataClient({ fetch: async (url: URL | RequestInfo) => {
    urls.push(String(url)); return Response.json(data(urls.length === 1 ? { rows: [], pagination: { limit: 10, nextCursor: "next-1" } } : {}));
  } });
  const pages = [];
  for await (const page of client.pages("x-mentions", { symbol: "AAPL" }, { maxPages: 2 })) pages.push(page);
  assert.equal(pages.length, 2); assert.match(urls[1], /cursor=next-1/); assert.equal(pages[1].rows[0].net_return, null);
});

test("JS client rejects cursor loops and reports bounded pagination instead of silently truncating", async () => {
  const client = new TraderDataClient({ fetch: async () => Response.json(data({ pagination: { limit: 10, nextCursor: "repeat" } })) });
  await assert.rejects(async () => { for await (const page of client.pages("x-mentions", {}, { maxPages: 1 })) assert.ok(page); }, (error: unknown) => error instanceof TraderDataError && error.code === "page_limit");
  await assert.rejects(async () => { for await (const page of client.pages("x-mentions")) assert.ok(page); }, (error: unknown) => error instanceof TraderDataError && error.code === "invalid_cursor");
});
