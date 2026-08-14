import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GET } from "../src/app/api/v1/watchlists/quotes/stream/route";
import {
  WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION,
  type Quote,
  type WatchlistQuoteStreamMessage,
} from "../src/app/platform/provider-contracts";
import {
  isNewerWatchlistQuote,
  parseWatchlistQuoteStreamMessage,
} from "../src/app/features/watchlist/quote-stream";

const TEST_NOW = Date.now();
const AS_OF = new Date(TEST_NOW - 3_000).toISOString();
const INGESTED_AT = new Date(TEST_NOW - 2_000).toISOString();
const NEWER_AS_OF = new Date(TEST_NOW - 1_000).toISOString();

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    instrumentId: "us:XNAS:AAPL",
    price: 313.33,
    change: 0.92,
    changePercent: 0.29,
    previousClose: 312.41,
    open: 312.5,
    high: 314,
    low: 311.8,
    volume: 1_234_567,
    currency: "USD",
    marketState: "regular",
    delaySeconds: 0,
    provenance: {
      providerId: "tradingview-websocket",
      sourceId: "tradingview-websocket:NASDAQ:AAPL:realtime-quote",
      asOf: AS_OF,
      ingestedAt: INGESTED_AT,
      sourceUrl: "wss://data.tradingview.com/socket.io/websocket",
    },
    ...overrides,
  };
}

function streamMessage(value: Quote): WatchlistQuoteStreamMessage {
  return {
    schemaVersion: WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION,
    type: "quote",
    symbol: "AAPL",
    quote: value,
  };
}

function withEnvironment(
  values: Readonly<Record<string, string | undefined>>,
  operation: () => Promise<void>,
) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return operation().finally(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("strictly parses canonical USD quote events and rejects malformed or stale candidates", () => {
  const valid = quote();
  assert.deepEqual(
    parseWatchlistQuoteStreamMessage(JSON.stringify(streamMessage(valid))),
    streamMessage(valid),
  );

  for (const invalid of [
    "not-json",
    JSON.stringify({ ...streamMessage(valid), schemaVersion: "wrong" }),
    JSON.stringify({ ...streamMessage(valid), symbol: "bad symbol" }),
    JSON.stringify(streamMessage(quote({ price: 0 }))),
    JSON.stringify(streamMessage(quote({ currency: "USDT" as "USD" }))),
    JSON.stringify(streamMessage(quote({ delaySeconds: Number.NaN }))),
    JSON.stringify(streamMessage(quote({
      provenance: { ...valid.provenance, asOf: "not-a-date" },
    }))),
  ]) {
    assert.equal(parseWatchlistQuoteStreamMessage(invalid), null);
  }

  assert.equal(isNewerWatchlistQuote(valid, undefined), true);
  assert.equal(isNewerWatchlistQuote(valid, AS_OF), true);
  assert.equal(isNewerWatchlistQuote(valid, NEWER_AS_OF), false);
});

test("stream route rejects cross-site requests before provider access", async () => {
  const response = await GET(new Request(
    "http://localhost/api/v1/watchlists/quotes/stream?symbols=AAPL",
    {
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    },
  ));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("stream route reports a configured market without streaming support", async () => {
  await withEnvironment({
    UNICORN_INSTRUMENT_PROVIDER: "mock",
    UNICORN_MARKET_PROVIDER: "mock",
    UNICORN_BARS_PROVIDER: "mock",
  }, async () => {
    const response = await GET(new Request(
      "http://localhost/api/v1/watchlists/quotes/stream?symbols=AAPL",
    ));
    assert.equal(response.status, 409);
    const payload = await response.json() as { error?: { code?: string } };
    assert.equal(payload.error?.code, "stream_not_configured");
  });
});

test("snapshot mode gates SSE so fixture quote events cannot reach the UI", async () => {
  const [snapshotRouteSource, streamRouteSource, pageSource] = await Promise.all([
    readFile(new URL("../src/app/api/v1/watchlists/quotes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/v1/watchlists/quotes/stream/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(snapshotRouteSource, /dataMode === "provider" && Boolean\(runtime\.market\.getQuoteStream\)/);
  assert.match(streamRouteSource, /watchlistQuoteDataMode\([\s\S]*?runtime\.selectedProviderIds\.instrument,[\s\S]*?runtime\.selectedProviderIds\.market,[\s\S]*?\) !== "provider"/);
  assert.match(pageSource, /providerQuotesEnabled = response\.dataMode === "provider"/);
  assert.match(pageSource, /if \(!providerQuotesEnabled \|\| !symbolSet\.has\(symbol\)\) return;/);
});

test("stream route refuses a real market stream when instrument identity is fixture", async () => {
  const secret = "test-sidecar-secret";
  const originalFetch = globalThis.fetch;
  let requestedBody: unknown;
  let requestedUrl: URL | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    requestedBody = JSON.parse(String(init?.body));
    const item = {
      symbol: "AAPL",
      sourceSymbol: "NASDAQ:AAPL",
      price: 313.33,
      change: 0.92,
      changePercent: 0.29,
      previousClose: 312.41,
      open: 312.5,
      high: 314,
      low: 311.8,
      volume: 1_234_567,
      currency: "USD",
      session: "regular",
      updatedAt: AS_OF,
      stale: false,
    };
    const upstream = [
      `event: ready\ndata: ${JSON.stringify({
        schemaVersion: "unicorn.tradingview-realtime-quotes.v1",
        type: "ready",
        state: "connected",
        items: [item],
        ingestedAt: INGESTED_AT,
      })}`,
      `event: quote\ndata: ${JSON.stringify({
        schemaVersion: "unicorn.tradingview-realtime-quotes.v1",
        type: "quote",
        item: {
          ...item,
          price: 313.5,
          change: 1.09,
          changePercent: (1.09 / 312.41) * 100,
          updatedAt: NEWER_AS_OF,
        },
        ingestedAt: new Date(TEST_NOW).toISOString(),
      })}`,
      "",
    ].join("\n\n");
    return new Response(upstream, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  };

  try {
    await withEnvironment({
      UNICORN_INSTRUMENT_PROVIDER: "mock",
      UNICORN_MARKET_PROVIDER: "tradingview-websocket",
      UNICORN_BARS_PROVIDER: "mock",
      UNICORN_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
      UNICORN_TRADINGVIEW_SIDECAR_TOKEN: secret,
    }, async () => {
      const response = await GET(new Request(
        "http://localhost/api/v1/watchlists/quotes/stream?symbols=AAPL",
        { headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } },
      ));
      assert.equal(response.status, 409);
      const body = await response.json() as { error?: { code?: string } };
      assert.equal(body.error?.code, "stream_not_configured");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestedUrl, undefined, "fixture identity must be rejected before upstream access");
  assert.equal(requestedBody, undefined);
});

test("watchlist UI treats SSE or HTTPS long poll as primary and retains snapshot fallback", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /new EventSource\(`\/api\/v1\/watchlists\/quotes\/stream\?\$\{query\}`\)/);
  assert.match(pageSource, /providerQuotesEnabled = response\.dataMode === "provider"/);
  assert.match(pageSource, /streamSupported = providerQuotesEnabled && response\.streamSupported === true/);
  assert.match(pageSource, /longPollSupported = providerQuotesEnabled[\s\S]*?response\.longPollSupported === true[\s\S]*?&& !streamSupported/);
  assert.match(pageSource, /fetch\("\/api\/v1\/watchlists\/quotes\/poll"/);
  assert.match(pageSource, /JSON\.stringify\(\{ symbols, cursors: quoteLongPollCursors\(\) \}\)/);
  assert.match(pageSource, /longPollController\?\.abort\("quote long poll stopped"\)/);
  assert.match(pageSource, /scheduleQuoteLongPoll\(longPollRetryDelay === 1_000 \? 0 : longPollRetryDelay\)/);
  assert.match(pageSource, /streamSupported !== true/);
  assert.doesNotMatch(pageSource, /source\.onopen[\s\S]{0,180}streamConnected = true/);
  assert.match(pageSource, /const message = parseWatchlistQuoteStreamMessage\(event\.data\);[\s\S]*?if \(!message\) return;[\s\S]*?streamConnected = true;[\s\S]*?reconnectDelay = 1_000;/);
  assert.match(pageSource, /if \(disposed \|\| eventSource !== source \|\| streamConnected\) return;[\s\S]*?10_000/);
  assert.match(pageSource, /WATCHLIST_QUOTE_REFRESH_MS = 15_000/);
  assert.match(pageSource, /const resolvedSymbols = new Set<string>\(\);/);
  assert.match(pageSource, /streamConnected && resolvedSymbols\.size >= symbols\.length/);
  assert.match(pageSource, /Focus, pageshow, and exact market boundaries always require a fresh/);
  assert.match(pageSource, /window\.addEventListener\("pageshow", refreshNow\)/);
  assert.match(pageSource, /forceWatchlistQuoteSnapshotRef\.current = refreshNow/);
  assert.match(pageSource, /if \(document\.hidden\) \{[\s\S]*?disconnectStream\(\);/);
  assert.match(pageSource, /const previousAsOf = latestAsOf\.get\(symbol\);[\s\S]*?isNewerWatchlistQuote\(quote, previousAsOf\)/);
});
