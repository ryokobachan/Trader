import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../app/api/v1/symbols/[symbol]/bars/route";
import type { MarketBarInterval, MarketBarsResponse } from "../app/platform/provider-contracts";

function context(symbol = "AAPL") {
  return { params: Promise.resolve({ symbol }) };
}

test("bars route accepts every chart resolution exposed by the toolbar", async () => {
  const intervals: readonly MarketBarInterval[] = [
    "1m",
    "5m",
    "15m",
    "1h",
    "4h",
    "1d",
    "1wk",
    "1mo",
  ];
  for (const interval of intervals) {
    const response = await GET(
      new Request(`http://localhost/api/v1/symbols/AAPL/bars?range=1d&interval=${interval}`),
      context(),
    );
    assert.equal(response.status, 200, interval);
    const payload = await response.json() as MarketBarsResponse;
    assert.equal(payload.bars.interval, interval);
    assert.equal(payload.returnedCount, payload.bars.items.length);
  }
});

test("bars route accepts an explicit 10,000-candle request and reports request/return counts", async () => {
  const response = await GET(
    new Request("http://localhost/api/v1/symbols/AAPL/bars?range=5y&interval=1h&count=10000"),
    context(),
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as MarketBarsResponse;
  assert.equal(payload.requestedCount, 10_000);
  assert.equal(payload.returnedCount, payload.bars.items.length);
  assert.ok(payload.returnedCount <= 10_000);
});

test("bars route rejects malformed and over-limit candle counts", async () => {
  for (const count of ["1", "2.5", "10001", "not-a-number"]) {
    const response = await GET(
      new Request(`http://localhost/api/v1/symbols/AAPL/bars?range=1y&interval=1d&count=${count}`),
      context(),
    );
    assert.equal(response.status, 400, count);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, "invalid_count", count);
  }
});

test("bars route continues to fail closed for unknown resolutions", async () => {
  const response = await GET(
    new Request("http://localhost/api/v1/symbols/AAPL/bars?range=1d&interval=2m"),
    context(),
  );
  assert.equal(response.status, 400);
  const payload = await response.json() as { error: { code: string } };
  assert.equal(payload.error.code, "invalid_request");
});
