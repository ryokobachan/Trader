import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { POST } from "../src/app/api/v1/watchlists/quotes/route";
import type {
  Instrument,
  InstrumentProvider,
  MarketDataProvider,
  Quote,
  WatchlistQuotesResponse,
} from "../src/app/platform/provider-contracts";
import {
  isUsableCurrentQuote,
  loadWatchlistQuotes,
} from "../src/app/platform/watchlist-quotes.server";

const AS_OF = "2026-08-09T10:00:00.000Z";

function instrument(symbol: string): Instrument {
  return {
    instrumentId: `us:XNAS:${symbol}`,
    symbol,
    name: symbol,
    assetType: "common_stock",
    active: true,
    listingCountry: "US",
    exchange: "NASDAQ",
    exchangeMic: "XNAS",
    currency: "USD",
    provenance: {
      providerId: "fixture",
      sourceId: `fixture:${symbol}`,
      asOf: AS_OF,
      ingestedAt: AS_OF,
    },
  };
}

function quote(value: Instrument, price: number, instrumentId = value.instrumentId): Quote {
  return {
    instrumentId,
    price,
    change: 1,
    changePercent: 1,
    previousClose: Math.max(1, price - 1),
    open: Math.max(1, price - 0.5),
    high: Math.max(1, price + 1),
    low: Math.max(1, price - 1),
    volume: 100,
    currency: "USD",
    marketState: "regular",
    delaySeconds: 0,
    provenance: {
      providerId: "fixture",
      sourceId: `fixture:${value.symbol}:quote`,
      asOf: AS_OF,
      ingestedAt: AS_OF,
    },
  };
}

test("loads watchlist quotes in order while preserving missing and invalid prices as null", async () => {
  let active = 0;
  let maximumActive = 0;
  const instruments: InstrumentProvider = {
    searchUSStocks: async () => [],
    getUSStockBySymbol: async (symbol) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (symbol === "MISS") return null;
      if (symbol === "ERROR") throw new Error("temporary provider failure");
      return instrument(symbol);
    },
  };
  const market: MarketDataProvider = {
    getQuote: async (value) => {
      if (value.symbol === "ZERO") return quote(value, 0);
      if (value.symbol === "MISMATCH") return quote(value, 125, "wrong-instrument");
      return quote(value, 312.5);
    },
  };

  const items = await loadWatchlistQuotes(
    ["AAPL", "ZERO", "MISS", "MISMATCH", "ERROR"],
    { instrument: instruments, market },
    { requestId: "watchlist-quotes-test" },
    2,
  );

  assert.deepEqual(items.map((item) => item.symbol), ["AAPL", "ZERO", "MISS", "MISMATCH", "ERROR"]);
  assert.equal(items[0]?.quote?.price, 312.5);
  assert.equal(items[1]?.quote, null, "zero must not become a visible current price");
  assert.equal(items[2]?.instrument, null);
  assert.equal(items[2]?.quote, null);
  assert.equal(items[3]?.quote, null);
  assert.equal(items[4]?.quote, null);
  assert.equal(maximumActive, 2);
  assert.equal(isUsableCurrentQuote(quote(instrument("AAPL"), 312.5)), true);
  assert.equal(isUsableCurrentQuote(quote(instrument("ZERO"), 0)), false);
  assert.equal(isUsableCurrentQuote(null), false);
});

test("uses one market batch and caches instrument identities between refreshes", async () => {
  let identityCalls = 0;
  let batchCalls = 0;
  let individualQuoteCalls = 0;
  const instruments: InstrumentProvider = {
    searchUSStocks: async () => [],
    getUSStockBySymbol: async (symbol) => {
      identityCalls += 1;
      return symbol === "MISS" ? null : instrument(symbol);
    },
  };
  const market: MarketDataProvider = {
    getQuote: async (value) => {
      individualQuoteCalls += 1;
      return quote(value, 999);
    },
    getQuotes: async (values) => {
      batchCalls += 1;
      return values.map((value) => quote(value, value.symbol === "ZERO" ? 0 : 312.5));
    },
  };
  const runtime = {
    instrument: instruments,
    market,
    selectedProviderIds: {
      instrument: "batch-identity-fixture",
      market: "batch-market-fixture",
      bars: "batch-market-fixture",
    },
  } as const;

  const first = await loadWatchlistQuotes(
    ["AAPL", "ZERO", "MISS"],
    runtime,
    { requestId: "watchlist-batch-first" },
  );
  const second = await loadWatchlistQuotes(
    ["AAPL", "ZERO", "MISS"],
    runtime,
    { requestId: "watchlist-batch-second" },
  );

  assert.equal(identityCalls, 3, "positive and negative identities should be reused by later polls");
  assert.equal(batchCalls, 1, "adjacent refreshes should reuse the short server-side batch cache");
  assert.equal(individualQuoteCalls, 0);
  assert.equal(first[0]?.quote?.price, 312.5);
  assert.equal(first[1]?.quote, null);
  assert.equal(first[2]?.instrument, null);
  assert.deepEqual(second.map((item) => item.quote?.price ?? null), [312.5, null, null]);
});

test("watchlist quotes API returns one ordered batch with positive prices", async () => {
  const previousInstrument = process.env.UNICORN_INSTRUMENT_PROVIDER;
  const previousMarket = process.env.UNICORN_MARKET_PROVIDER;
  process.env.UNICORN_INSTRUMENT_PROVIDER = "mock";
  process.env.UNICORN_MARKET_PROVIDER = "mock";
  try {
    const response = await POST(new Request("http://localhost/api/v1/watchlists/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols: ["aapl", "NVDA", "AAPL"] }),
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as WatchlistQuotesResponse;
    assert.equal(payload.schemaVersion, "unicorn.watchlist-quotes.v1");
    assert.deepEqual(payload.items.map((item) => item.symbol), ["AAPL", "NVDA"]);
    assert.ok(payload.items.every((item) => item.quote !== null && item.quote.price > 0));
    assert.deepEqual(payload.selectedProviders, { instrument: "mock", market: "mock" });
  } finally {
    if (previousInstrument === undefined) delete process.env.UNICORN_INSTRUMENT_PROVIDER;
    else process.env.UNICORN_INSTRUMENT_PROVIDER = previousInstrument;
    if (previousMarket === undefined) delete process.env.UNICORN_MARKET_PROVIDER;
    else process.env.UNICORN_MARKET_PROVIDER = previousMarket;
  }
});

test("watchlist quotes API rejects invalid and oversized batches", async () => {
  for (const symbols of [
    [],
    ["AAPL", "bad symbol"],
    Array.from({ length: 51 }, (_, index) => `A${index}`),
  ]) {
    const response = await POST(new Request("http://localhost/api/v1/watchlists/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols }),
    }));
    assert.equal(response.status, 400);
  }
});

test("watchlist UI refreshes visible quotes and resumes immediately after tab or network return", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /\/api\/v1\/watchlists\/quotes/);
  assert.match(pageSource, /watchlistQuoteStock\(item, next\[item\.symbol\]\)/);
  assert.match(pageSource, /WATCHLIST_QUOTE_REFRESH_MS = 15_000/);
  assert.match(pageSource, /WATCHLIST_AFTER_HOURS_REFRESH_MS = 60_000/);
  assert.match(pageSource, /window\.setTimeout\(\(\) => \{\s*refreshTimer = undefined;\s*refresh\(\);\s*\}, WATCHLIST_QUOTE_REFRESH_MS\)/);
  assert.match(pageSource, /requestInFlight/);
  assert.match(pageSource, /window\.addEventListener\("focus", refreshNow\)/);
  assert.match(pageSource, /window\.addEventListener\("online", refreshNow\)/);
  assert.match(pageSource, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(pageSource, /document\.hidden/);
  assert.match(pageSource, /!Number\.isFinite\(value\) \|\| value <= 0 \? "-"/);
  assert.doesNotMatch(pageSource, /setAfterHoursBySymbol\(\{\}\);\s*\}\);/);
});
