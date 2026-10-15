import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import { createTradingViewSidecarProvider } from "../api/tradingview-websocket/index.server";
import { GET } from "../src/app/api/v1/watchlists/after-hours/stream/route";
import {
  isFreshSyntheticLatestClose,
  isNewerAfterHoursClose,
  parseWatchlistAfterHoursStreamMessage,
  pruneStaleAfterHoursCloses,
} from "../src/app/features/watchlist/after-hours-stream";
import type { SyntheticLatestClose } from "../src/app/platform/provider-contracts";

const EXCHANGES = ["BINANCE", "BITGET", "KUCOIN", "MEXC"] as const;

function latestClose(close: number, updatedAt: string): SyntheticLatestClose {
  return {
    symbol: "AAPL",
    sourceSymbol: "BINANCE:AAPLUSDT.P",
    close,
    currency: "USDT",
    source: "tradingview-websocket",
    updatedAt,
  };
}

function readyEvent(item: SyntheticLatestClose) {
  return {
    schemaVersion: "trader.tradingview-sidecar.v1",
    type: "ready",
    exchange: "BINANCE",
    exchanges: EXCHANGES,
    resolutionStrategy: "ordered_fallback",
    state: "connected",
    items: [item],
    ingestedAt: "2026-08-10T01:30:01Z",
  };
}

function quoteEvent(item: SyntheticLatestClose) {
  return {
    schemaVersion: "trader.tradingview-sidecar.v1",
    type: "quote",
    exchange: "BINANCE",
    exchanges: EXCHANGES,
    resolutionStrategy: "ordered_fallback",
    item,
    ingestedAt: "2026-08-10T01:30:02Z",
  };
}

function sidecarStream(...events: readonly [string, unknown][]) {
  return events.map(([name, payload]) => (
    `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
  )).join("");
}

async function readAll<T>(stream: ReadableStream<T>): Promise<readonly T[]> {
  const reader = stream.getReader();
  const values: T[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return values;
      values.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

test("streams server-derived USDT perpetual prices without exposing the bearer token", async () => {
  const first = latestClose(313.3, "2026-08-10T01:30:00Z");
  const second = latestClose(313.31, "2026-08-10T01:30:01Z");
  let requestUrl: URL | undefined;
  let requestBody: unknown;
  let authorization = "";
  const adapter = createTradingViewSidecarProvider({
    TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
    TRADER_TRADINGVIEW_SIDECAR_TOKEN: "stream-secret",
  }, {
    fetch: async (input, init) => {
      requestUrl = new URL(input instanceof Request ? input.url : String(input));
      requestBody = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(sidecarStream(
        ["ready", readyEvent(first)],
        ["quote", quoteEvent(second)],
      ), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    },
  });

  const stream = await adapter.syntheticMarket.getLatestCloseStream(
    ["aapl"],
    { requestId: "after-hours-stream-1" },
  );
  const values = await readAll(stream);

  assert.equal(requestUrl?.pathname, "/v1/latest-closes/stream");
  assert.equal(requestUrl?.search, "");
  assert.ok(!requestUrl?.toString().includes("stream-secret"));
  assert.deepEqual(requestBody, { symbols: ["AAPL"] });
  assert.equal(authorization, "Bearer stream-secret");
  assert.deepEqual(values, [
    { ...first, updatedAt: "2026-08-10T01:30:00.000Z" },
    { ...second, updatedAt: "2026-08-10T01:30:01.000Z" },
  ]);
  assert.ok(values.every((item) => item.currency === "USDT"));
  assert.ok(values.every((item) => item.sourceSymbol.endsWith("USDT.P")));
});

test("rejects a stream item from an exchange outside the server-owned fallback list", async () => {
  const invalid = {
    ...latestClose(313.3, "2026-08-10T01:30:00Z"),
    sourceSymbol: "GATEIO:AAPLUSDT.P",
  };
  const adapter = createTradingViewSidecarProvider({
    TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
  }, {
    fetch: async () => new Response(sidecarStream(["ready", readyEvent(invalid)]), {
      headers: { "content-type": "text/event-stream" },
    }),
  });
  const stream = await adapter.syntheticMarket.getLatestCloseStream(
    ["AAPL"],
    { requestId: "after-hours-stream-invalid" },
  );

  await assert.rejects(() => readAll(stream));
});

test("rejects additional fields at the sidecar stream trust boundary", async () => {
  const item = latestClose(313.3, "2026-08-10T01:30:00Z");
  const adapter = createTradingViewSidecarProvider({
    TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
  }, {
    fetch: async () => new Response(sidecarStream([
      "ready",
      { ...readyEvent(item), unexpected: "field" },
    ]), { headers: { "content-type": "text/event-stream" } }),
  });
  const stream = await adapter.syntheticMarket.getLatestCloseStream(
    ["AAPL"],
    { requestId: "after-hours-stream-extra-field" },
  );

  await assert.rejects(() => readAll(stream));
});

test("same-origin watchlist route relays canonical stream messages and keeps USDT semantics", async () => {
  const first = latestClose(313.3, "2026-08-10T01:30:00Z");
  const second = latestClose(313.31, "2026-08-10T01:30:01Z");
  let capturedPath = "";
  let capturedBody = "";
  const server = createServer((request, response) => {
    capturedPath = request.url ?? "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { capturedBody += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.end(sidecarStream(
        ["ready", readyEvent(first)],
        ["quote", quoteEvent(second)],
      ));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const previousUrl = process.env.TRADER_TRADINGVIEW_SIDECAR_URL;
  process.env.TRADER_TRADINGVIEW_SIDECAR_URL = `http://127.0.0.1:${address.port}`;
  try {
    const response = await GET(new Request(
      "http://localhost/api/v1/watchlists/after-hours/stream?symbols=AAPL",
      { headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } },
    ));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const body = await response.text();
    const dataLines = body.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

    assert.equal(capturedPath, "/v1/latest-closes/stream");
    assert.deepEqual(JSON.parse(capturedBody), { symbols: ["AAPL"] });
    assert.equal(dataLines.length, 2);
    assert.ok(dataLines.every(
      (message) => message.schemaVersion === "trader.watchlist-after-hours-stream.v1",
    ));
    assert.deepEqual(dataLines.map((message) => message.type), ["quote", "quote"]);
    assert.deepEqual(
      dataLines.map((message) => (message.item as Record<string, unknown>).currency),
      ["USDT", "USDT"],
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close(
      (error) => error ? reject(error) : resolve(),
    ));
    if (previousUrl === undefined) delete process.env.TRADER_TRADINGVIEW_SIDECAR_URL;
    else process.env.TRADER_TRADINGVIEW_SIDECAR_URL = previousUrl;
  }
});

test("watchlist stream rejects cross-origin and malformed symbol requests before the sidecar", async () => {
  const forbidden = await GET(new Request(
    "http://localhost/api/v1/watchlists/after-hours/stream?symbols=AAPL",
    { headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" } },
  ));
  assert.equal(forbidden.status, 403);

  const malformed = await GET(new Request(
    "http://localhost/api/v1/watchlists/after-hours/stream?symbols=AAPL,bad%20symbol",
  ));
  assert.equal(malformed.status, 400);
});

test("browser stream parser rejects mislabeled or malformed perpetual prices", () => {
  const item = latestClose(313.3, "2026-08-10T01:30:00Z");
  const valid = JSON.stringify({
    schemaVersion: "trader.watchlist-after-hours-stream.v1",
    type: "quote",
    item,
  });
  assert.deepEqual(parseWatchlistAfterHoursStreamMessage(valid)?.item, item);

  for (const invalid of [
    { ...item, close: 0 },
    { ...item, currency: "USD" },
    { ...item, sourceSymbol: "NASDAQ:AAPL" },
    { ...item, sourceSymbol: "BINANCE:TSLAUSDT.P" },
    { ...item, updatedAt: "not-a-date" },
  ]) {
    assert.equal(parseWatchlistAfterHoursStreamMessage(JSON.stringify({
      schemaVersion: "trader.watchlist-after-hours-stream.v1",
      type: "quote",
      item: invalid,
    })), null);
  }
});

test("browser keeps the newest streamed reference price and wires snapshot fallback", async () => {
  const older = latestClose(313.29, "2026-08-10T01:29:59Z");
  const current = latestClose(313.3, "2026-08-10T01:30:00Z");
  const newer = latestClose(313.31, "2026-08-10T01:30:01Z");
  assert.equal(isNewerAfterHoursClose(older, current.updatedAt), false);
  assert.equal(isNewerAfterHoursClose(current, current.updatedAt), true);
  assert.equal(isNewerAfterHoursClose(newer, current.updatedAt), true);

  const observedAt = Date.parse("2026-08-10T01:35:00.000Z");
  const exactBoundary = latestClose(313.3, "2026-08-10T01:30:00.000Z");
  const oneMillisecondStale = latestClose(313.3, "2026-08-10T01:29:59.999Z");
  const currentTick = latestClose(313.3, "2026-08-10T01:34:59.999Z");
  assert.equal(isFreshSyntheticLatestClose(exactBoundary, observedAt), true);
  assert.equal(isFreshSyntheticLatestClose(oneMillisecondStale, observedAt), false);
  assert.equal(isFreshSyntheticLatestClose(currentTick, observedAt), true);
  const unpruned = { AAPL: exactBoundary };
  assert.equal(pruneStaleAfterHoursCloses(unpruned, observedAt), unpruned);
  assert.deepEqual(
    pruneStaleAfterHoursCloses({ AAPL: oneMillisecondStale, NVDA: currentTick }, observedAt),
    { NVDA: currentTick },
  );

  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(
    pageSource,
    /new EventSource\(`\/api\/v1\/watchlists\/after-hours\/stream\?\$\{query\}`\)/,
  );
  assert.match(pageSource, /parseWatchlistAfterHoursStreamMessage\(event\.data\)/);
  assert.match(pageSource, /isNewerAfterHoursClose\(item, previousUpdatedAt\)/);
  assert.match(pageSource, /item\.close === null && item\.updatedAt === null/);
  assert.match(pageSource, /pruneExpiredCloses\(\)/);
  assert.match(pageSource, /fetch\("\/api\/v1\/watchlists\/after-hours"/);
  assert.match(pageSource, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(pageSource, /window\.addEventListener\("online", refreshNow\)/);
});

test("sidecar shares one quote broker between direct USD and USDT perpetual streams", async () => {
  const source = await readFile(
    new URL("../api/tradingview-websocket/sidecar.py", import.meta.url),
    "utf8",
  );

  assert.match(source, /self\.realtime_quotes = RealtimeQuoteBroker\(timeout_seconds\)/);
  assert.match(source, /send_latest_close_stream/);
  assert.match(source, /synthetic_realtime_items\(symbols, exchanges\)/);
  assert.match(source, /"sourceSymbol": f"\{exchange\}:\{symbol\}USDT\.P"/);
  assert.match(source, /expected_currency = requested\["currency"\]/);
  assert.match(source, /quote_remove_symbols/);
  assert.match(source, /"currency": "USDT"/);
  assert.match(source, /continuous_reference_is_fresh\(updated_at, observed_at\)/);
  assert.match(source, /value\.get\("stale"\) is False/);
  assert.match(source, /emitted_expiry = False/);
  assert.match(source, /value and not continuous_reference_is_fresh/);
  assert.doesNotMatch(source, /source_symbol.*request/i);
});

test("shared Python broker keeps USD listings and USDT fallback candidates distinct", () => {
  const script = String.raw`
import importlib.util
import sys
import time
from datetime import datetime, timedelta, timezone

spec = importlib.util.spec_from_file_location("trader_sidecar", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.RealtimeQuoteBroker._run = lambda self: None
broker = module.RealtimeQuoteBroker(2.0)
now_epoch = int(time.time())

direct = module.parse_realtime_items({"items": [{"symbol": "AAPL", "mic": "XNAS"}]})
synthetic = module.synthetic_realtime_items(["AAPL"], ("BINANCE", "BITGET"))
direct_subscriber, _ = broker.subscribe(direct, "direct-owner")
synthetic_subscriber, _ = broker.subscribe(synthetic, "synthetic-owner")

assert broker._publish_quote("NASDAQ:AAPL", {
    "lp": 313.30, "lp_time": now_epoch, "currency_code": "USD"
})
assert broker._publish_quote("BITGET:AAPLUSDT.P", {
    "lp": 313.25, "lp_time": now_epoch, "currency_code": "USDT"
})
values = dict(broker._latest)
assert values["NASDAQ:AAPL"]["currency"] == "USD"
assert values["BITGET:AAPLUSDT.P"]["currency"] == "USDT"
selected = module.synthetic_latest_close_item("AAPL", ("BINANCE", "BITGET"), values)
assert selected["sourceSymbol"] == "BITGET:AAPLUSDT.P"

assert broker._publish_quote("BINANCE:AAPLUSDT.P", {
    "lp": 313.26, "lp_time": now_epoch + 1, "currency_code": "USDT"
})
selected = module.synthetic_latest_close_item(
    "AAPL", ("BINANCE", "BITGET"), dict(broker._latest)
)
assert selected["sourceSymbol"] == "BINANCE:AAPLUSDT.P"
assert selected["close"] == 313.26 and selected["currency"] == "USDT"

observed_at = datetime(2026, 8, 13, 7, 0, tzinfo=timezone.utc)
boundary_values = {
    "BINANCE:AAPLUSDT.P": {
        "price": 303.0,
        "currency": "USDT",
        "updatedAt": (observed_at - timedelta(minutes=5)).isoformat(),
        "stale": False,
    }
}
assert module.synthetic_latest_close_item(
    "AAPL", ("BINANCE",), boundary_values, observed_at
)["close"] == 303.0
boundary_values["BINANCE:AAPLUSDT.P"]["updatedAt"] = (
    observed_at - timedelta(minutes=5, microseconds=1000)
).isoformat()
assert module.synthetic_latest_close_item(
    "AAPL", ("BINANCE",), boundary_values, observed_at
)["close"] is None
boundary_values["BINANCE:AAPLUSDT.P"]["updatedAt"] = observed_at.isoformat()
boundary_values["BINANCE:AAPLUSDT.P"]["stale"] = True
assert module.synthetic_latest_close_item(
    "AAPL", ("BINANCE",), boundary_values, observed_at
)["close"] is None

broker.unsubscribe(synthetic_subscriber.subscriber_id)
assert "NASDAQ:AAPL" in broker._source_refcounts
broker.unsubscribe(direct_subscriber.subscriber_id)
broker.close()
print("ok")
`;
  const result = spawnSync("python3", [
    "-c",
    script,
    new URL("../api/tradingview-websocket/sidecar.py", import.meta.url).pathname,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), "ok");
});
