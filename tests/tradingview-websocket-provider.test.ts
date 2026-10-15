import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MARKET_BAR_COUNT,
  type Instrument,
  type MarketBarInterval,
  type MarketBarRange,
} from "../src/app/platform/provider-contracts";
import { createProviderRuntime } from "../api/index.server";
import {
  createTradingViewSidecarProvider,
  TradingViewSidecarError,
  tradingViewCandleCount,
  tradingViewMarketSessionState,
  tradingViewWebsocketProviderRegistration,
  type TradingViewSidecarFetch,
} from "../api/tradingview-websocket/index.server";

const INSTRUMENT = {
  instrumentId: "us:XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetType: "common_stock",
  active: true,
  listingCountry: "US",
  exchange: "NASDAQ Global Select Market",
  exchangeMic: "XNAS",
  currency: "USD",
  provenance: {
    providerId: "fixture",
    sourceId: "fixture:AAPL",
    asOf: "2026-08-08T00:00:00.000Z",
    ingestedAt: "2026-08-08T00:00:00.000Z",
  },
} as const satisfies Instrument;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function payload(interval: MarketBarInterval, range: MarketBarRange, requestedCount: number) {
  const items = [
    { time: "2026-08-06T13:30:00Z", open: 310, high: 314, low: 309, close: 312, volume: 100 },
    { time: "2026-08-07T13:30:00Z", open: 312, high: 316, low: 311, close: 315, volume: 120 },
  ];
  return {
    schemaVersion: "trader.tradingview-sidecar.v1",
    symbol: "AAPL",
    exchange: "NASDAQ",
    sourceSymbol: "NASDAQ:AAPL",
    interval,
    range,
    requestedCount,
    returnedCount: items.length,
    items,
    asOf: "2026-08-07T13:30:00Z",
    ingestedAt: "2026-08-08T00:00:00Z",
  };
}

function realtimePayload() {
  return {
    schemaVersion: "trader.tradingview-realtime-quotes.v1",
    state: "connected",
    items: [{
      symbol: "AAPL",
      sourceSymbol: "NASDAQ:AAPL",
      price: 315,
      previousClose: 312,
      change: 3,
      changePercent: (3 / 312) * 100,
      open: 312,
      high: 316,
      low: 311,
      volume: 120,
      currency: "USD",
      session: "regular",
      updatedAt: "2026-08-08T13:58:00Z",
      stale: false,
    }],
    ingestedAt: "2026-08-08T13:59:00Z",
  };
}

test("publishes a market-data-only TradingView websocket provider manifest", () => {
  assert.equal(tradingViewWebsocketProviderRegistration.manifest.id, "tradingview-websocket");
  assert.deepEqual(tradingViewWebsocketProviderRegistration.manifest.capabilities, [
    "market.quote",
    "market.bars",
    "market.synthetic_latest_close",
  ]);
  assert.deepEqual(tradingViewWebsocketProviderRegistration.manifest.requiredEnv, [
    "TRADER_TRADINGVIEW_SIDECAR_URL",
  ]);
});

test("strictly maps TradingView current_session values with a clock fallback for unknowns", () => {
  for (const value of ["market", "regular"] as const) {
    assert.equal(tradingViewMarketSessionState(value), "regular");
  }
  for (const value of ["pre_market", "premarket"] as const) {
    assert.equal(tradingViewMarketSessionState(value), "pre_market");
  }
  for (const value of ["post_market", "postmarket", "after_hours"] as const) {
    assert.equal(tradingViewMarketSessionState(value), "after_hours");
  }
  for (const value of ["closed", "out_of_session", "holiday", "night"] as const) {
    assert.equal(tradingViewMarketSessionState(value), "closed");
  }
  for (const value of ["extended", "MARKET", "", null, 1]) {
    assert.equal(tradingViewMarketSessionState(value), null);
  }
});

test("keeps adapter defaults available while allowing the chart's 10,000-bar request", () => {
  const intervals: readonly MarketBarInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1wk", "1mo"];
  for (const interval of intervals) {
    const count = tradingViewCandleCount("1y", interval);
    assert.ok(count >= 2 && count <= 5_000, interval);
  }
  assert.equal(MAX_MARKET_BAR_COUNT, 10_000);
  assert.equal(tradingViewCandleCount("5d", "1m"), 2_100);
  assert.equal(tradingViewCandleCount("5y", "1mo"), 61);
});

test("normalizes bars and direct USD quote while keeping the sidecar token out of URLs and provenance", async () => {
  const secret = "local-sidecar-secret";
  const requests: URL[] = [];
  const requestBodies: unknown[] = [];
  const fetch: TradingViewSidecarFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    if (url.pathname === "/v1/realtime-quotes") {
      assert.equal(init?.method, "POST");
      requestBodies.push(JSON.parse(String(init?.body)));
      return json(realtimePayload());
    }
    const interval = url.searchParams.get("interval") as MarketBarInterval;
    const range = url.searchParams.get("range") as MarketBarRange;
    const requestedCount = Number(url.searchParams.get("count"));
    return json(payload(interval, range, requestedCount));
  };
  const adapter = createTradingViewSidecarProvider({
    TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8765",
    TRADER_TRADINGVIEW_SIDECAR_TOKEN: secret,
  }, {
    fetch,
    now: () => new Date("2026-08-08T14:00:00Z"),
  });
  assert.ok(adapter.market?.getBars);

  const bars = await adapter.market.getBars(INSTRUMENT, { range: "5d", interval: "5m" });
  assert.equal(bars?.items.length, 2);
  assert.equal(bars?.interval, "5m");
  assert.equal(bars?.adjustment, "split_adjusted");
  assert.equal(bars?.provenance.providerId, "tradingview-websocket");
  assert.equal(bars?.provenance.sourceUrl, "wss://data.tradingview.com/socket.io/websocket");
  assert.equal(bars?.requestedCount, 420);
  assert.equal(bars?.returnedCount, 2);

  const deepHistory = await adapter.market.getBars(INSTRUMENT, {
    range: "5y",
    interval: "1h",
    count: 10_000,
  });
  assert.equal(deepHistory?.requestedCount, 10_000);
  assert.equal(deepHistory?.returnedCount, 2);

  const quote = await adapter.market.getQuote(INSTRUMENT, { requestId: "quote-test" });
  assert.equal(quote?.price, 315);
  assert.equal(quote?.previousClose, 312);
  assert.equal(quote?.change, 3);
  assert.equal(quote?.marketState, "regular");
  assert.equal(quote?.currency, "USD");
  assert.equal(quote?.provenance.sourceId, "tradingview-websocket:NASDAQ:AAPL:realtime-quote");
  assert.equal(requests[0]?.searchParams.get("exchange"), "NASDAQ");
  assert.equal(requests[0]?.searchParams.get("count"), "420");
  assert.equal(requests[1]?.searchParams.get("count"), "10000");
  assert.equal(requests[2]?.pathname, "/v1/realtime-quotes");
  assert.equal(requests[2]?.search, "");
  assert.deepEqual(requestBodies, [{ items: [{ symbol: "AAPL", mic: "XNAS" }] }]);
  assert.ok(!JSON.stringify(requestBodies).includes("USDT.P"));
  assert.ok(requests.every((url) => !url.toString().includes(secret)));
});

test("preserves explicit zero volume and rejects malformed OHLCV candles", async () => {
  const validZeroVolume = {
    time: "2026-08-07T13:30:00Z",
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 0,
  };
  let currentItem: Record<string, unknown> = validZeroVolume;
  const adapter = createTradingViewSidecarProvider({
    TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8765",
  }, {
    fetch: async (input) => {
      const url = new URL(String(input));
      const interval = url.searchParams.get("interval") as MarketBarInterval;
      const range = url.searchParams.get("range") as MarketBarRange;
      const requestedCount = Number(url.searchParams.get("count"));
      return json({
        ...payload(interval, range, requestedCount),
        returnedCount: 1,
        items: [currentItem],
      });
    },
  });

  const valid = await adapter.market!.getBars!(INSTRUMENT, { range: "5d", interval: "5m" });
  assert.equal(valid?.items[0]?.volume, 0);

  const missingVolume = {
    time: validZeroVolume.time,
    open: validZeroVolume.open,
    high: validZeroVolume.high,
    low: validZeroVolume.low,
    close: validZeroVolume.close,
  };
  const malformed: readonly Record<string, unknown>[] = [
    missingVolume,
    { ...validZeroVolume, volume: null },
    { ...validZeroVolume, volume: -1 },
    ...(["open", "high", "low", "close"] as const).map((field) => ({
      ...validZeroVolume,
      [field]: 0,
    })),
    { ...validZeroVolume, open: 103 },
    { ...validZeroVolume, low: 101.5 },
  ];
  for (const item of malformed) {
    currentItem = item;
    await assert.rejects(
      () => adapter.market!.getBars!(INSTRUMENT, { range: "5d", interval: "5m" }),
      (error: unknown) => error instanceof TradingViewSidecarError && error.code === "invalid_response",
    );
  }
});

test("does not trust a cached market session while the realtime source reconnects", async () => {
  const adapter = createTradingViewSidecarProvider({
    TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8765",
  }, {
    fetch: async () => json({
      ...realtimePayload(),
      state: "reconnecting",
      items: [{
        ...realtimePayload().items[0],
        session: "out_of_session",
        updatedAt: "2026-08-10T13:29:00Z",
        stale: true,
      }],
      ingestedAt: "2026-08-10T13:30:00Z",
    }),
    now: () => new Date("2026-08-10T13:30:00Z"),
  });

  const quote = await adapter.market!.getQuote(INSTRUMENT, { requestId: "reconnecting-quote" });
  assert.equal(quote?.price, 315, "the last validated price may remain visible");
  assert.equal(quote?.marketState, "regular", "the stale closed session must fall back to the clock");
});

test("keeps quote and chart-bar provider selection independent", () => {
  const runtime = createProviderRuntime({
    TRADER_INSTRUMENT_PROVIDER: "mock",
    TRADER_MARKET_PROVIDER: "mock",
    TRADER_BARS_PROVIDER: "tradingview-websocket",
    TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8765",
  });
  assert.equal(runtime.selectedProviderIds.market, "mock");
  assert.equal(runtime.selectedProviderIds.bars, "tradingview-websocket");
  assert.equal(typeof runtime.market.getQuote, "function");
  assert.equal(typeof runtime.market.getBars, "function");
});

test("rejects unsafe sidecar locations and malformed response data without leaking configuration", async () => {
  assert.throws(
    () => createTradingViewSidecarProvider({
      TRADER_TRADINGVIEW_SIDECAR_URL: "http://public.example.test:8765",
    }),
    (error: unknown) => error instanceof TradingViewSidecarError && error.code === "configuration",
  );
  assert.throws(
    () => createTradingViewSidecarProvider({
      TRADER_TRADINGVIEW_SIDECAR_URL: "https://sidecar.example.test",
    }),
    (error: unknown) => error instanceof TradingViewSidecarError && error.code === "configuration",
  );

  const adapter = createTradingViewSidecarProvider({
    TRADER_TRADINGVIEW_SIDECAR_URL: "http://localhost:8765",
  }, {
    fetch: async (input) => {
      const url = new URL(String(input));
      const requestedCount = Number(url.searchParams.get("count"));
      return json({
        ...payload("1d", "1y", requestedCount),
        returnedCount: 1,
        items: [{ time: "bad", open: 1 }],
      });
    },
  });
  await assert.rejects(
    () => adapter.market!.getBars!(INSTRUMENT, { range: "1y", interval: "1d" }),
    (error: unknown) => error instanceof TradingViewSidecarError && error.code === "invalid_response",
  );
});

test("honors a lower deployment ceiling without exposing configuration in the request URL", async () => {
  let captured: URL | undefined;
  const adapter = createTradingViewSidecarProvider({
    TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8765",
    TRADER_TRADINGVIEW_MAX_CANDLES: "6000",
  }, {
    fetch: async (input) => {
      captured = new URL(String(input));
      const requestedCount = Number(captured.searchParams.get("count"));
      return json(payload("1h", "5y", requestedCount));
    },
  });

  const bars = await adapter.market!.getBars!(INSTRUMENT, {
    range: "5y",
    interval: "1h",
    count: 10_000,
  });
  assert.equal(captured?.searchParams.get("count"), "6000");
  assert.equal(bars?.requestedCount, 6_000);
  assert.ok(!captured?.toString().includes("TRADER_TRADINGVIEW_MAX_CANDLES"));
});
