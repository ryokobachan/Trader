import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  IDLE_MARKET_BARS_REFRESH_MS,
  LIVE_DAILY_BARS_REFRESH_MS,
  LIVE_HOURLY_BARS_REFRESH_MS,
  LIVE_INTRADAY_BARS_REFRESH_MS,
  advanceMarketDataRequestGeneration,
  didMarketDataRequestStayInNominalSession,
  isCurrentMarketDataRequestGeneration,
  isQuoteNewerThan,
  marketBarsRefreshDelay,
  mergeLiveQuoteIntoWorkspace,
  prioritizedWatchlistQuoteSymbols,
} from "../src/app/features/live-market-data";
import {
  SYMBOL_WORKSPACE_SCHEMA_VERSION,
  type Instrument,
  type Quote,
  type SymbolWorkspace,
} from "../src/app/platform/provider-contracts";

const instrument: Instrument = {
  instrumentId: "us:XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetType: "common_stock",
  active: true,
  listingCountry: "US",
  exchange: "NASDAQ",
  exchangeMic: "XNAS",
  currency: "USD",
  provenance: {
    providerId: "test",
    sourceId: "instrument:AAPL",
    asOf: "2026-08-10T16:59:00.000Z",
    ingestedAt: "2026-08-10T16:59:01.000Z",
  },
};

test("a forced refresh invalidates an in-flight market-data generation", () => {
  let latestGeneration = 0;
  const initialRequest = advanceMarketDataRequestGeneration(latestGeneration);
  latestGeneration = initialRequest;
  assert.equal(
    isCurrentMarketDataRequestGeneration(initialRequest, latestGeneration),
    true,
  );

  latestGeneration = advanceMarketDataRequestGeneration(latestGeneration);
  assert.equal(
    isCurrentMarketDataRequestGeneration(initialRequest, latestGeneration),
    false,
    "the response started before focus or a session boundary cannot commit",
  );

  const forcedRequest = advanceMarketDataRequestGeneration(latestGeneration);
  latestGeneration = forcedRequest;
  assert.equal(
    isCurrentMarketDataRequestGeneration(forcedRequest, latestGeneration),
    true,
    "the pending forced response becomes the only committable generation",
  );
});

test("a watchlist quote response cannot commit across a nominal session boundary", () => {
  assert.equal(
    didMarketDataRequestStayInNominalSession(
      new Date("2026-08-10T13:29:59.000Z"),
      new Date("2026-08-10T13:30:00.000Z"),
    ),
    false,
  );
  assert.equal(
    didMarketDataRequestStayInNominalSession(
      new Date("2026-08-10T19:59:59.000Z"),
      new Date("2026-08-10T20:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    didMarketDataRequestStayInNominalSession(
      new Date("2026-08-10T17:00:00.000Z"),
      new Date("2026-08-10T17:00:02.000Z"),
    ),
    true,
  );
});

function quote(
  asOf: string,
  ingestedAt: string,
  overrides: Partial<Quote> = {},
): Quote {
  return {
    instrumentId: instrument.instrumentId,
    price: 220,
    change: 1,
    changePercent: 0.46,
    previousClose: 219,
    open: 219.5,
    high: 221,
    low: 218.5,
    volume: 1_000_000,
    currency: "USD",
    marketState: "regular",
    delaySeconds: 0,
    provenance: {
      providerId: "test",
      sourceId: "quote:AAPL",
      asOf,
      ingestedAt,
    },
    ...overrides,
  };
}

function workspace(value: Quote): SymbolWorkspace {
  return {
    schemaVersion: SYMBOL_WORKSPACE_SCHEMA_VERSION,
    instrument,
    quote: value,
    profile: null,
    fundamentals: null,
    earnings: [],
    analyst: null,
    news: [],
    selectedProviders: { instrument: "test", market: "test" },
    dataMode: "provider",
    status: "partial",
    warnings: [],
    asOf: value.provenance.asOf,
  };
}

test("uses a bounded live candle cadence only while the provider or clock says regular", () => {
  const now = new Date("2026-08-10T17:00:00.000Z");
  const regular = { state: "regular", observedAt: Date.parse("2026-08-10T16:59:50.000Z") } as const;
  const closed = { state: "closed", observedAt: Date.parse("2026-08-10T16:59:50.000Z") } as const;

  for (const interval of ["1m", "5m", "15m"] as const) {
    assert.equal(marketBarsRefreshDelay(interval, regular, now), LIVE_INTRADAY_BARS_REFRESH_MS);
  }
  for (const interval of ["1h", "4h"] as const) {
    assert.equal(marketBarsRefreshDelay(interval, regular, now), LIVE_HOURLY_BARS_REFRESH_MS);
  }
  for (const interval of ["1d", "1wk", "1mo"] as const) {
    assert.equal(marketBarsRefreshDelay(interval, regular, now), LIVE_DAILY_BARS_REFRESH_MS);
  }
  assert.equal(marketBarsRefreshDelay("1m", closed, now), IDLE_MARKET_BARS_REFRESH_MS);
  assert.equal(
    marketBarsRefreshDelay("1m", undefined, now),
    LIVE_INTRADAY_BARS_REFRESH_MS,
    "the New York clock is the no-quote fallback",
  );
  assert.equal(
    marketBarsRefreshDelay(
      "1m",
      { state: "regular", observedAt: Date.parse("2026-08-10T16:58:00.000Z") },
      now,
    ),
    LIVE_INTRADAY_BARS_REFRESH_MS,
    "a stale provider state falls back to the nominal session",
  );
  assert.equal(
    marketBarsRefreshDelay(
      "1m",
      { state: "regular", observedAt: Date.parse("2026-08-10T20:00:01.000Z") },
      new Date("2026-08-10T20:00:01.000Z"),
    ),
    IDLE_MARKET_BARS_REFRESH_MS,
    "a lagging provider state cannot keep live polling after 16:00 New York",
  );
  assert.equal(
    marketBarsRefreshDelay(
      "1d",
      { state: "closed", observedAt: Date.parse("2026-09-07T13:59:50.000Z") },
      new Date("2026-09-07T14:00:00.000Z"),
    ),
    IDLE_MARKET_BARS_REFRESH_MS,
    "fresh provider closure prevents holiday polling at the regular cadence",
  );
});

test("merges only a newer matching live quote into the selected workspace", () => {
  const initial = quote("2026-08-10T17:00:00.000Z", "2026-08-10T17:00:01.000Z");
  const snapshot = workspace(initial);
  const older = quote("2026-08-10T16:59:59.000Z", "2026-08-10T17:00:02.000Z", { price: 219 });
  assert.equal(isQuoteNewerThan(older, initial), false);
  assert.equal(mergeLiveQuoteIntoWorkspace(snapshot, older), snapshot);

  const wrongInstrument = quote("2026-08-10T17:00:02.000Z", "2026-08-10T17:00:03.000Z", {
    instrumentId: "us:XNAS:MSFT",
  });
  assert.equal(mergeLiveQuoteIntoWorkspace(snapshot, wrongInstrument), snapshot);

  const newer = quote("2026-08-10T17:00:02.000Z", "2026-08-10T17:00:03.000Z", { price: 221 });
  const merged = mergeLiveQuoteIntoWorkspace(snapshot, newer);
  assert.notEqual(merged, snapshot);
  assert.equal(merged.quote, newer);
  assert.equal(merged.asOf, newer.provenance.asOf);
  assert.equal(merged.profile, snapshot.profile);

  const laterIngestion = quote(newer.provenance.asOf, "2026-08-10T17:00:04.000Z", {
    price: 221.5,
  });
  assert.equal(isQuoteNewerThan(laterIngestion, newer), true);
  assert.equal(mergeLiveQuoteIntoWorkspace(merged, laterIngestion).quote, laterIngestion);
});

test("visible watchlist rows keep every quote slot ahead of a removed selection", () => {
  const watched = Array.from({ length: 50 }, (_, index) => `S${index}`);
  const symbols = prioritizedWatchlistQuoteSymbols(watched, "TSLA", 50);
  assert.deepEqual(symbols, watched);
  assert.equal(symbols.includes("TSLA"), false);

  assert.deepEqual(
    prioritizedWatchlistQuoteSymbols(["AAPL", "TSLA", "NVDA"], "TSLA", 50),
    ["AAPL", "TSLA", "NVDA"],
  );
});

test("the selected chart, daily summary bars, and workspace quote all refresh without navigation", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /prioritizedWatchlistQuoteSymbols\(\s*watchedTickers,\s*selectedTicker,/);
  assert.match(pageSource, /const marketDataSurfaceVisible = primaryView !== "strategy";/);
  assert.match(pageSource, /if \(!marketDataSurfaceVisible\) return;/);
  assert.match(pageSource, /forceChartBarsRefreshRef\.current\?\.\(\)/);
  assert.match(pageSource, /forceDailyBarsRefreshRef\.current\?\.\(\)/);
  assert.match(pageSource, /window\.addEventListener\("focus", recheckVisibleSession\)/);
  assert.match(pageSource, /window\.addEventListener\("pageshow", recheckVisibleSession\)/);
  assert.match(pageSource, /marketBarsRefreshDelay\(\s*interval,/);
  assert.match(pageSource, /marketBarsRefreshDelay\(\s*"1d",/);
  assert.match(pageSource, /fresh:\s*"1"/);
  assert.match(pageSource, /cache: "no-store"/);
  assert.match(pageSource, /if \(requestInFlight\) \{\s*if \(force\) forceRefreshPending = true;/);
  assert.match(pageSource, /if \(forceRefreshPending && !document\.hidden\)/);
  assert.match(
    pageSource,
    /if \(force\) \{\s*forceRefreshPending = true;\s*latestRequestGeneration = advanceMarketDataRequestGeneration/,
  );
  assert.ok(
    [...pageSource.matchAll(/!isCurrentMarketDataRequestGeneration\(/g)].length >= 4,
    "both chart and daily responses and errors use the generation guard",
  );
  const boundaryGuardIndex = pageSource.indexOf(
    "if (!requestStayedInsideTheSameNominalSession) return;",
  );
  const snapshotMergeIndex = pageSource.indexOf(
    "if (item.quote) mergeLiveQuote(item.quote);",
    boundaryGuardIndex,
  );
  assert.ok(boundaryGuardIndex >= 0);
  assert.ok(
    snapshotMergeIndex > boundaryGuardIndex,
    "the nominal-boundary guard precedes every snapshot quote commit",
  );
  assert.match(pageSource, /activeController\?\.abort\(\)/);
  assert.match(pageSource, /window\.addEventListener\("online", refreshNow\)/);
  assert.match(pageSource, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(pageSource, /mergeLiveQuote\(quote\);/);
  assert.match(pageSource, /if \(item\.quote\) mergeLiveQuote\(item\.quote\);/);
  assert.match(pageSource, /mergeLiveQuoteIntoWorkspace\(mergedSnapshot, latestLiveQuote\)/);
  assert.match(pageSource, /snapshot\.instrument\.symbol !== selectedTicker/);
  assert.match(pageSource, /response\.instrument\.symbol !== selectedTicker/);
});
