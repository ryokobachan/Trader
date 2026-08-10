import assert from "node:assert/strict";
import test from "node:test";

import type { Instrument, MarketBars } from "../src/app/platform/provider-contracts";
import {
  YahooProviderError,
  yahooProviderRegistration,
} from "../api/yahoo/index.server";

const ENABLED_ENV = {
  UNICORN_USAGE_MODE: "personal",
  UNICORN_ENABLE_YAHOO_COMPAT: "true",
} as const;

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const AAPL: Instrument = {
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
    providerId: "yahoo",
    sourceId: "test",
    asOf: "2026-08-07T20:00:00.000Z",
    ingestedAt: "2026-08-07T20:00:01.000Z",
  },
};

const MSFT: Instrument = {
  ...AAPL,
  instrumentId: "us:XNAS:MSFT",
  symbol: "MSFT",
  name: "Microsoft Corporation",
};

const NBIS: Instrument = {
  ...AAPL,
  instrumentId: "us:XNAS:NBIS",
  symbol: "NBIS",
  name: "Nebius Group N.V.",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function searchPayload() {
  return {
    quotes: [
      {
        symbol: "AAPL",
        quoteType: "EQUITY",
        longname: "Apple Inc.",
        exchange: "NMS",
        exchDisp: "NASDAQ",
        currency: "USD",
        region: "US",
        market: "us_market",
        isYahooFinance: true,
        regularMarketTime: 1_775_774_400,
        sector: "Technology",
        industry: "Consumer Electronics",
      },
      {
        symbol: "SONY",
        quoteType: "EQUITY",
        longname: "Sony Group Corporation American Depositary Shares",
        exchange: "NYQ",
        currency: "USD",
        region: "US",
        market: "us_market",
      },
      {
        symbol: "SPY",
        quoteType: "ETF",
        longname: "SPDR S&P 500 ETF Trust",
        exchange: "PCX",
        currency: "USD",
        region: "US",
      },
      {
        symbol: "VTSAX",
        quoteType: "MUTUALFUND",
        longname: "Vanguard Total Stock Market Index Fund",
        exchange: "NAS",
        currency: "USD",
        region: "US",
      },
      {
        symbol: "7203.T",
        quoteType: "EQUITY",
        longname: "Toyota Motor Corporation",
        exchange: "JPX",
        currency: "JPY",
        region: "JP",
      },
      {
        symbol: "OTCM",
        quoteType: "EQUITY",
        longname: "OTC Markets Group Inc.",
        exchange: "PNK",
        currency: "USD",
        region: "US",
      },
    ],
  };
}

function chartPayload() {
  return {
    chart: {
      error: null,
      result: [{
        meta: {
          symbol: "AAPL",
          currency: "USD",
          exchangeName: "NMS",
          instrumentType: "EQUITY",
          chartPreviousClose: 225,
          regularMarketOpen: 226,
          regularMarketDayHigh: 231,
          regularMarketDayLow: 224,
          regularMarketVolume: 42_000_000,
          marketCap: 3_400_000_000_000,
          exchangeDataDelayedBy: 0,
          currentTradingPeriod: {
            pre: { start: 1_775_746_800, end: 1_775_766_600 },
            regular: { start: 1_775_766_600, end: 1_775_790_000 },
            post: { start: 1_775_790_000, end: 1_775_804_400 },
          },
        },
        timestamp: [1_775_766_600, 1_775_766_900, 1_775_767_200],
        indicators: {
          quote: [{
            open: [226, null, 228],
            high: [227, null, 230],
            low: [225, null, 227],
            close: [226.5, null, 229.5],
            volume: [1000, null, 1400],
          }],
          adjclose: [{ adjclose: [226.25, null, 229.25] }],
        },
      }],
    },
  };
}

function sparkResponse(
  symbol: string,
  previousClose: number,
  closes: readonly number[],
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    symbol,
    response: [{
      meta: {
        symbol,
        currency: "USD",
        exchangeName: "NMS",
        instrumentType: "EQUITY",
        chartPreviousClose: previousClose,
        regularMarketDayHigh: Math.max(...closes),
        regularMarketDayLow: Math.min(...closes),
        regularMarketVolume: 1_000_000,
        exchangeDataDelayedBy: 0,
        dataGranularity: "1m",
        currentTradingPeriod: {
          pre: { start: 1_775_746_800, end: 1_775_766_600 },
          regular: { start: 1_775_766_600, end: 1_775_790_000 },
          post: { start: 1_775_790_000, end: 1_775_804_400 },
        },
        ...overrides,
      },
      timestamp: closes.map((_, index) => 1_775_766_600 + index * 60),
      indicators: { quote: [{ close: closes }] },
    }],
  };
}

function fundamentalResult(
  type: string,
  points: readonly Readonly<{ date: string; value: number; dataValue?: boolean }>[],
) {
  return {
    meta: { symbol: ["AAPL"], type: [type] },
    [type]: points.map((point) => ({
      asOfDate: point.date,
      periodType: type.startsWith("annual") ? "12M" : "TTM",
      currencyCode: "USD",
      ...(point.dataValue
        ? { dataValue: point.value }
        : { reportedValue: { raw: point.value } }),
    })),
  };
}

function quoteSummaryPayload() {
  return {
    quoteSummary: {
      error: null,
      result: [{
        assetProfile: {
          longBusinessSummary: "Apple designs and sells consumer technology products.",
          website: "https://www.apple.com/",
          sector: "Technology",
          industry: "Consumer Electronics",
          country: "United States",
          city: "Cupertino",
          fullTimeEmployees: 164_000,
        },
        summaryDetail: {
          beta: { raw: 1.2 },
          marketCap: { raw: 2_000 },
          trailingPE: { raw: 25 },
          forwardPE: { raw: 22 },
          priceToSalesTrailing12Months: { raw: 3 },
          dividendYield: { raw: 0.01 },
          trailingAnnualDividendRate: { raw: 1.2 },
          payoutRatio: { raw: 0.25 },
        },
        defaultKeyStatistics: {
          priceToBook: { raw: 5 },
          enterpriseValue: { raw: 2_100 },
          enterpriseToRevenue: { raw: 1.75 },
          enterpriseToEbitda: { raw: 7 },
          pegRatio: { raw: 1.4 },
          bookValue: { raw: 4 },
          sharesOutstanding: { raw: 100 },
        },
        financialData: {
          totalRevenue: { raw: 1_150 },
          revenueGrowth: { raw: 0.15 },
          earningsGrowth: { raw: 0.3 },
          returnOnEquity: { raw: 0.4 },
          returnOnAssets: { raw: 0.2 },
          grossMargins: { raw: 0.48 },
          operatingMargins: { raw: 0.24 },
          ebitdaMargins: { raw: 0.29 },
          ebitda: { raw: 350 },
          profitMargins: { raw: 0.18 },
          operatingCashflow: { raw: 250 },
          freeCashflow: { raw: 180 },
          totalCash: { raw: 500 },
          totalDebt: { raw: 700 },
          currentRatio: { raw: 0.9 },
          quickRatio: { raw: 0.75 },
          debtToEquity: { raw: 152 },
        },
        price: {
          marketCap: { raw: 2_000 },
          regularMarketTime: 1_775_774_400,
          firstTradeDateMilliseconds: 345_427_200_000,
        },
        calendarEvents: {
          earnings: {
            earningsDate: [{ raw: 1_777_507_200 }, { raw: 1_777_593_600 }],
            earningsAverage: { raw: 1.75 },
            revenueAverage: { raw: 98_000_000_000 },
          },
        },
      }],
    },
  };
}

test("requires both explicit personal-use Yahoo compatibility opt-ins", () => {
  for (const env of [
    {},
    { UNICORN_USAGE_MODE: "personal" },
    { UNICORN_ENABLE_YAHOO_COMPAT: "true" },
    { UNICORN_USAGE_MODE: "hosted", UNICORN_ENABLE_YAHOO_COMPAT: "true" },
  ]) {
    assert.throws(
      () => yahooProviderRegistration.create(env),
      (error: unknown) => error instanceof YahooProviderError
        && error.code === "usage_not_permitted",
    );
  }
});

test("searches arbitrary names and fails closed to US equities on known exchanges", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v1/finance/search");
    assert.equal(url.searchParams.get("q"), "Apple & Sony");
    assert.equal(url.searchParams.get("quotesCount"), "20");
    assert.equal(url.searchParams.has("apikey"), false);
    assert.equal(url.searchParams.has("token"), false);
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return jsonResponse(searchPayload());
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.instrument);

  const instruments = await adapter.instrument.searchUSStocks(
    { query: "Apple & Sony", limit: 20 },
    { requestId: "search-test" },
  );

  assert.deepEqual(instruments.map((instrument) => instrument.symbol), ["AAPL", "SONY"]);
  assert.equal(instruments[0]?.instrumentId, "us:XNAS:AAPL");
  assert.equal(instruments[0]?.sector, "Technology");
  assert.equal(instruments[0]?.industry, "Consumer Electronics");
  assert.equal(
    instruments[0]?.logoPath,
    "https://financialmodelingprep.com/image-stock/AAPL.png",
  );
  assert.equal(instruments[1]?.assetType, "adr");
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("returns cached popular US stocks for an empty query without an API key", async (t) => {
  const expected = ["AAPL", "MSFT", "NVDA"];
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    const symbol = url.searchParams.get("q") ?? "";
    assert.ok(expected.includes(symbol));
    assert.equal(url.searchParams.has("apikey"), false);
    assert.equal(url.searchParams.has("token"), false);
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return jsonResponse({
      quotes: [{
        symbol,
        quoteType: "EQUITY",
        longname: `${symbol} Corporation`,
        exchange: "NMS",
        currency: "USD",
        region: "US",
        market: "us_market",
        isYahooFinance: true,
      }],
    });
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.instrument);

  const first = await adapter.instrument.searchUSStocks(
    { query: "", limit: 3 },
    { requestId: "popular-first" },
  );
  const second = await adapter.instrument.searchUSStocks(
    { query: "   ", limit: 3 },
    { requestId: "popular-cached" },
  );

  assert.deepEqual(first.map((instrument) => instrument.symbol), expected);
  assert.deepEqual(second.map((instrument) => instrument.symbol), expected);
  assert.equal(fetchMock.mock.callCount(), 3);
});

test("keeps Apple and Palantir company-name search stable and normalizes BRK.B", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: FetchInput) => {
    const query = new URL(String(input)).searchParams.get("q");
    if (query === "Apple") {
      return jsonResponse(searchPayload());
    }
    if (query === "Palantir") {
      return jsonResponse({
        quotes: [
          {
            symbol: "PLTR.TO",
            quoteType: "ETF",
            longname: "PALANTIR CDR (CAD HEDGED)",
            exchange: "TOR",
            currency: "CAD",
            region: "CA",
          },
          {
            symbol: "PLTR",
            quoteType: "EQUITY",
            longname: "Palantir Technologies Inc.",
            exchange: "NMS",
            currency: "USD",
            region: "US",
            market: "us_market",
          },
        ],
      });
    }
    assert.equal(query, "BRK-B");
    return jsonResponse({
      quotes: [
        {
          symbol: "BRKC",
          quoteType: "ETF",
          longname: "YieldMax BRK.B Option Income Strategy ETF",
          exchange: "PCX",
          currency: "USD",
          region: "US",
        },
        {
          symbol: "BRK-B",
          quoteType: "EQUITY",
          longname: "Berkshire Hathaway Inc.",
          exchange: "NYQ",
          currency: "USD",
          region: "US",
          market: "us_market",
        },
      ],
    });
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.instrument);

  const context = { requestId: "stable-search" } as const;
  const apple = await adapter.instrument.searchUSStocks({ query: "Apple", limit: 5 }, context);
  const palantir = await adapter.instrument.searchUSStocks({ query: "Palantir", limit: 5 }, context);
  const berkshire = await adapter.instrument.searchUSStocks({ query: "BRK.B", limit: 5 }, context);

  assert.equal(apple[0]?.symbol, "AAPL");
  assert.deepEqual(palantir.map((instrument) => instrument.symbol), ["PLTR"]);
  assert.deepEqual(berkshire.map((instrument) => instrument.symbol), ["BRK-B"]);
  assert.equal(fetchMock.mock.callCount(), 3);
});

test("normalizes class-share symbols before exact identity lookup", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: FetchInput) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("q"), "BRK-B");
    return jsonResponse({
      quotes: [{
        symbol: "BRK-B",
        quoteType: "EQUITY",
        longname: "Berkshire Hathaway Inc.",
        exchange: "NYQ",
        currency: "USD",
        region: "US",
        market: "us_market",
      }],
    });
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.instrument);

  const instrument = await adapter.instrument.getUSStockBySymbol(
    " brk.b ",
    { requestId: "identity-test" },
  );
  assert.equal(instrument?.symbol, "BRK-B");
  assert.equal(instrument?.exchangeMic, "XNYS");
});

test("builds a quote from validated Chart metadata and the latest complete bar", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: FetchInput) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v8/finance/chart/AAPL");
    assert.equal(url.searchParams.get("range"), "1d");
    assert.equal(url.searchParams.get("interval"), "1m");
    assert.equal(url.searchParams.get("includePrePost"), "true");
    return jsonResponse(chartPayload());
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.market);

  const quote = await adapter.market.getQuote(AAPL, {
    requestId: "quote-test",
    asOf: new Date(1_775_767_200 * 1_000).toISOString(),
  });
  assert.equal(quote?.price, 229.5);
  assert.equal(quote?.previousClose, 225);
  assert.equal(quote?.change, 4.5);
  assert.equal(quote?.changePercent, 2);
  assert.equal(quote?.open, 226);
  assert.equal(quote?.high, 231);
  assert.equal(quote?.low, 224);
  assert.equal(quote?.marketState, "regular");
  assert.equal(quote?.delaySeconds, 0);
  assert.equal(quote?.provenance.providerId, "yahoo");
});

test("batches Spark quotes in one request, preserves input order, and drops invalid rows", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v7/finance/spark");
    assert.equal(url.searchParams.get("symbols"), "MSFT,NBIS,AAPL");
    assert.equal(url.searchParams.get("range"), "1d");
    assert.equal(url.searchParams.get("interval"), "1m");
    assert.equal(url.searchParams.get("indicators"), "close");
    assert.equal(url.searchParams.get("includePrePost"), "true");
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get("user-agent"),
      "Mozilla/5.0 UnicornWorkspace/1.0 (live price refresh)",
    );
    return jsonResponse({
      spark: {
        error: null,
        result: [
          sparkResponse("AAPL", 225, [226, 229.5]),
          sparkResponse("NBIS", 60, [61, 62], { instrumentType: "CRYPTOCURRENCY" }),
          sparkResponse("MSFT", 500, [498, 501]),
        ],
      },
    });
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.market?.getQuotes);

  const quotes = await adapter.market.getQuotes(
    [MSFT, NBIS, AAPL],
    {
      requestId: "spark-quotes-test",
      asOf: new Date(1_775_766_660 * 1_000).toISOString(),
    },
  );

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(quotes.map((quote) => quote.instrumentId), [MSFT.instrumentId, AAPL.instrumentId]);
  assert.deepEqual(quotes.map((quote) => quote.price), [501, 229.5]);
  assert.equal(quotes[0]?.open, 498);
  assert.equal(quotes[0]?.marketState, "regular");
  assert.equal(quotes[0]?.provenance.sourceId, "yahoo-spark:MSFT:quote");
  assert.equal(quotes[0]?.provenance.sourceUrl, "https://query1.finance.yahoo.com/v7/finance/spark");
  assert.equal(quotes[0]?.provenance.sourceUrl?.includes("AAPL"), false);
});

test("does not call Spark when no valid symbols are provided", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.market?.getQuotes);

  const quotes = await adapter.market.getQuotes(
    [{ ...AAPL, symbol: "../../" }],
    { requestId: "empty-spark-quotes-test" },
  );

  assert.deepEqual(quotes, []);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("returns raw Chart bars and drops rows with null OHLC values", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: FetchInput) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v8/finance/chart/AAPL");
    assert.equal(url.searchParams.get("range"), "1mo");
    assert.equal(url.searchParams.get("interval"), "1d");
    assert.equal(url.searchParams.get("includePrePost"), "false");
    return jsonResponse(chartPayload());
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.market?.getBars);

  const bars = await adapter.market.getBars(
    AAPL,
    { range: "1mo", interval: "1d" },
    { requestId: "bars-test" },
  );
  assert.equal(bars?.adjustment, "raw");
  assert.equal(bars?.items.length, 2);
  assert.deepEqual(bars?.items.map((bar) => bar.close), [226.5, 229.5]);
  assert.deepEqual(bars?.items.map((bar) => bar.adjustedClose), [226.25, 229.25]);
});

test("passes supported resolutions through and rebuilds four-hour Yahoo bars", async (t) => {
  const expected = [
    { requested: "1m", upstream: "1m", range: "1d" },
    { requested: "4h", upstream: "1h", range: "1mo" },
    { requested: "1wk", upstream: "1wk", range: "6mo" },
    { requested: "1mo", upstream: "1mo", range: "1y" },
  ] as const;
  let callIndex = 0;
  t.mock.method(globalThis, "fetch", async (input: FetchInput) => {
    const expectation = expected[callIndex];
    assert.ok(expectation);
    callIndex += 1;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("range"), expectation.range);
    assert.equal(url.searchParams.get("interval"), expectation.upstream);
    return jsonResponse(chartPayload());
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.market?.getBars);

  for (const request of expected) {
    const bars: MarketBars | null = await adapter.market.getBars(
      AAPL,
      { range: request.range, interval: request.requested },
      { requestId: `bars-${request.requested}` },
    );
    assert.equal(bars?.interval, request.requested);
    if (request.requested === "4h") {
      assert.equal(bars?.items.length, 1);
      assert.deepEqual(bars?.items[0], {
        time: "2026-04-09T20:30:00.000Z",
        open: 226,
        high: 230,
        low: 225,
        close: 229.5,
        volume: 2400,
        adjustedClose: 229.25,
      });
    }
  }
  assert.equal(callIndex, expected.length);
});

test("surfaces sanitized upstream status and timeout errors", async (t) => {
  const upstreamMock = t.mock.method(globalThis, "fetch", async () => jsonResponse({}, 429));
  let adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.instrument);
  await assert.rejects(
    adapter.instrument.searchUSStocks({ query: "AAPL" }, { requestId: "429-test" }),
    (error: unknown) => error instanceof YahooProviderError
      && error.code === "upstream_error"
      && error.status === 429,
  );
  upstreamMock.mock.restore();

  t.mock.method(globalThis, "fetch", (_input: FetchInput, init?: FetchInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  }));
  adapter = yahooProviderRegistration.create({
    ...ENABLED_ENV,
    UNICORN_YAHOO_TIMEOUT_MS: "10",
  });
  assert.ok(adapter.instrument);
  await assert.rejects(
    adapter.instrument.searchUSStocks({ query: "AAPL" }, { requestId: "timeout-test" }),
    (error: unknown) => error instanceof YahooProviderError
      && error.code === "request_timeout",
  );
});

test("normalizes keyless Yahoo Search news and rejects invalid or duplicate items", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v1/finance/search");
    assert.equal(url.searchParams.get("q"), "AAPL");
    assert.equal(url.searchParams.get("quotesCount"), "0");
    assert.equal(url.searchParams.get("newsCount"), "20");
    assert.equal(url.searchParams.has("apikey"), false);
    assert.equal(url.searchParams.has("token"), false);
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return jsonResponse({
      news: [
        {
          uuid: "newer",
          title: "Apple launches a new product",
          publisher: "Reuters",
          link: "https://finance.yahoo.com/news/apple-new-product.html",
          providerPublishTime: 1_775_775_000,
          relatedTickers: ["AAPL", "MSFT"],
          thumbnail: {
            resolutions: [
              { url: "javascript:alert(1)", tag: "140x140" },
              { url: "https://s.yimg.com/apple-original.jpg", tag: "original" },
            ],
          },
        },
        {
          uuid: "older",
          title: "Apple supplier outlook improves",
          publisher: "Example Wire",
          link: "https://finance.yahoo.com/news/apple-supplier.html",
          providerPublishTime: 1_775_774_000,
          relatedTickers: ["AAPL"],
        },
        {
          uuid: "newer",
          title: "Duplicate UUID",
          publisher: "Duplicate Wire",
          link: "https://finance.yahoo.com/news/different-link.html",
          providerPublishTime: 1_775_773_000,
          relatedTickers: ["AAPL"],
        },
        {
          uuid: "duplicate-url",
          title: "Duplicate URL",
          publisher: "Duplicate Wire",
          link: "https://finance.yahoo.com/news/apple-supplier.html",
          providerPublishTime: 1_775_772_000,
          relatedTickers: ["AAPL"],
        },
        {
          uuid: "wrong-symbol",
          title: "Microsoft only",
          publisher: "Example Wire",
          link: "https://finance.yahoo.com/news/microsoft.html",
          providerPublishTime: 1_775_771_000,
          relatedTickers: ["MSFT"],
        },
        {
          uuid: "unsafe-url",
          title: "Unsafe URL",
          publisher: "Example Wire",
          link: "javascript:alert(1)",
          providerPublishTime: 1_775_770_000,
          relatedTickers: ["AAPL"],
        },
        {
          uuid: "invalid-time",
          title: "Invalid time",
          publisher: "Example Wire",
          link: "https://finance.yahoo.com/news/invalid-time.html",
          providerPublishTime: 0,
          relatedTickers: ["AAPL"],
        },
      ],
    });
  });
  assert.ok(yahooProviderRegistration.manifest.capabilities.includes("news.company"));
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.news);

  const news = await adapter.news.getCompanyNews(AAPL, { requestId: "news-test" });
  assert.equal(news.length, 2);
  assert.deepEqual(news.map((item) => item.id), ["yahoo:newer", "yahoo:older"]);
  assert.equal(news[0]?.instrumentId, AAPL.instrumentId);
  assert.equal(news[0]?.imageUrl, "https://s.yimg.com/apple-original.jpg");
  assert.equal(news[0]?.provenance.providerId, "yahoo");
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("uses the existing sanitized timeout and upstream error policy for news", async (t) => {
  const upstreamMock = t.mock.method(globalThis, "fetch", async () => jsonResponse({}, 503));
  let adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.news);
  await assert.rejects(
    adapter.news.getCompanyNews(AAPL, { requestId: "news-503" }),
    (error: unknown) => error instanceof YahooProviderError
      && error.code === "upstream_error"
      && error.status === 503,
  );
  upstreamMock.mock.restore();

  t.mock.method(globalThis, "fetch", (_input: FetchInput, init?: FetchInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  adapter = yahooProviderRegistration.create({
    ...ENABLED_ENV,
    UNICORN_YAHOO_TIMEOUT_MS: "10",
  });
  assert.ok(adapter.news);
  await assert.rejects(
    adapter.news.getCompanyNews(AAPL, { requestId: "news-timeout" }),
    (error: unknown) => error instanceof YahooProviderError
      && error.code === "request_timeout",
  );
});

test("normalizes partial Yahoo timeseries and financialData without API credentials", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(url.searchParams.has("apikey"), false);
    assert.equal(url.searchParams.has("token"), false);
    assert.equal(headers.has("authorization"), false);

    if (url.hostname === "fc.yahoo.com") {
      return new Response("", {
        status: 404,
        headers: { "set-cookie": "A3=anonymous-cookie; Path=/; Secure" },
      });
    }
    if (url.pathname === "/v1/test/getcrumb") {
      assert.equal(headers.get("cookie"), "A3=anonymous-cookie");
      return new Response("anonymous-crumb");
    }
    if (url.pathname === "/v10/finance/quoteSummary/AAPL") {
      assert.equal(headers.get("cookie"), "A3=anonymous-cookie");
      assert.equal(url.searchParams.get("crumb"), "anonymous-crumb");
      assert.ok(url.searchParams.get("modules")?.includes("financialData"));
      return jsonResponse(quoteSummaryPayload());
    }

    assert.equal(url.pathname, "/ws/fundamentals-timeseries/v1/finance/timeseries/AAPL");
    assert.equal(url.searchParams.get("symbol"), "AAPL");
    const types = url.searchParams.get("type") ?? "";
    if (types.includes("trailingPeRatio")) {
      // A failed batch must not discard successful timeseries or quoteSummary data.
      return jsonResponse({}, 503);
    }
    return jsonResponse({
      timeseries: {
        error: null,
        result: [
          fundamentalResult("annualTotalRevenue", [
            { date: "2024-09-30", value: 1_000 },
            { date: "2025-09-30", value: 1_200 },
          ]),
          fundamentalResult("annualNetIncome", [
            { date: "2024-09-30", value: 200 },
            { date: "2025-09-30", value: 220 },
          ]),
          fundamentalResult("trailingTotalRevenue", [{ date: "2026-06-30", value: 1_200 }]),
          fundamentalResult("trailingGrossProfit", [{ date: "2026-06-30", value: 600 }]),
          fundamentalResult("trailingOperatingIncome", [{ date: "2026-06-30", value: 300 }]),
          fundamentalResult("trailingNetIncome", [{ date: "2026-06-30", value: 220 }]),
          fundamentalResult("trailingDilutedEPS", [{ date: "2026-06-30", value: 2.4 }]),
          fundamentalResult("trailingEBITDA", [{ date: "2026-06-30", value: 360 }]),
          fundamentalResult("trailingOperatingCashFlow", [{ date: "2026-06-30", value: 250 }]),
          fundamentalResult("trailingCapitalExpenditure", [{ date: "2026-06-30", value: -70 }]),
          fundamentalResult("annualCashCashEquivalentsAndShortTermInvestments", [{ date: "2025-09-30", value: 500 }]),
          fundamentalResult("annualTotalAssets", [{ date: "2025-09-30", value: 1_800 }]),
          fundamentalResult("annualTotalDebt", [{ date: "2025-09-30", value: 700 }]),
          fundamentalResult("annualStockholdersEquity", [{ date: "2025-09-30", value: 600 }]),
          fundamentalResult("annualCurrentLiabilities", [{ date: "2025-09-30", value: 400 }]),
        ],
      },
    });
  });
  assert.ok(yahooProviderRegistration.manifest.capabilities.includes("fundamentals.normalized"));
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.fundamentals);

  const snapshot = await adapter.fundamentals.getFundamentals(
    AAPL,
    { requestId: "fundamentals-test", asOf: "2026-08-08T00:00:00.000Z" },
  );
  assert.equal(snapshot?.revenue, 1_200);
  assert.equal(snapshot?.revenueGrowth, 0.2);
  assert.equal(snapshot?.netIncome, 220);
  assert.equal(snapshot?.grossProfit, 600);
  assert.equal(snapshot?.operatingIncome, 300);
  assert.equal(snapshot?.ebitda, 360);
  assert.equal(snapshot?.eps, 2.4);
  assert.equal(snapshot?.epsGrowth, 0.3);
  assert.equal(snapshot?.trailingPe, 25);
  assert.equal(snapshot?.forwardPe, 22);
  assert.equal(snapshot?.priceToBook, 5);
  assert.equal(snapshot?.priceToSales, 3);
  assert.equal(snapshot?.roe, 0.4);
  assert.equal(snapshot?.roa, 0.2);
  assert.equal(snapshot?.grossMargin, 0.5);
  assert.equal(snapshot?.operatingMargin, 0.25);
  assert.equal(snapshot?.ebitdaMargin, 0.3);
  assert.equal(snapshot?.netMargin, 220 / 1_200);
  assert.equal(snapshot?.freeCashFlowMargin, 0.15);
  assert.equal(snapshot?.dividendYield, 0.01);
  assert.equal(snapshot?.dividendPerShare, 1.2);
  assert.equal(snapshot?.payoutRatio, 0.25);
  assert.equal(snapshot?.operatingCashFlow, 250);
  assert.equal(snapshot?.capitalExpenditure, -70);
  assert.equal(snapshot?.freeCashFlow, 180);
  assert.equal(snapshot?.freeCashFlowYield, 0.09);
  assert.equal(snapshot?.currentRatio, 0.9);
  assert.equal(snapshot?.quickRatio, 0.75);
  assert.equal(snapshot?.cashRatio, 1.25);
  assert.equal(snapshot?.debtToEquity, 1.52);
  assert.equal(snapshot?.cashAndShortTermInvestments, 500);
  assert.equal(snapshot?.totalAssets, 1_800);
  assert.equal(snapshot?.totalDebt, 700);
  assert.equal(snapshot?.netDebt, 200);
  assert.equal(snapshot?.shareholdersEquity, 600);
  assert.equal(snapshot?.enterpriseValue, 2_100);
  assert.equal(snapshot?.enterpriseValueToRevenue, 1.75);
  assert.equal(snapshot?.enterpriseValueToEbitda, 7);
  assert.equal(snapshot?.pegRatio, 1.4);
  assert.equal(snapshot?.priceToFreeCashFlow, 2_000 / 180);
  assert.equal(snapshot?.earningsYield, 0.11);
  assert.equal(snapshot?.revenuePerShare, 12);
  assert.equal(snapshot?.bookValuePerShare, 4);
  assert.equal(snapshot?.operatingCashFlowPerShare, 2.5);
  assert.equal(snapshot?.freeCashFlowPerShare, 1.8);
  assert.equal(snapshot?.provenance.providerId, "yahoo");
  assert.equal(fetchMock.mock.callCount(), 6);
});

test("uses an anonymous quoteSummary session for company profile", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(url.searchParams.has("apikey"), false);
    assert.equal(url.searchParams.has("token"), false);
    if (url.hostname === "fc.yahoo.com") {
      return new Response("", {
        status: 404,
        headers: { "set-cookie": "A3=profile-cookie; Path=/" },
      });
    }
    if (url.pathname === "/v1/test/getcrumb") {
      assert.equal(headers.get("cookie"), "A3=profile-cookie");
      return new Response("profile-crumb");
    }
    assert.equal(url.pathname, "/v10/finance/quoteSummary/AAPL");
    assert.equal(url.searchParams.get("crumb"), "profile-crumb");
    assert.equal(headers.get("cookie"), "A3=profile-cookie");
    return jsonResponse(quoteSummaryPayload());
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.fundamentals);

  const profile = await adapter.fundamentals.getProfile(AAPL, { requestId: "profile-test" });

  assert.equal(profile?.description, "Apple designs and sells consumer technology products.");
  assert.equal(profile?.website, "https://www.apple.com/");
  assert.equal(profile?.sector, "Technology");
  assert.equal(profile?.industry, "Consumer Electronics");
  assert.equal(profile?.country, "United States");
  assert.equal(profile?.city, "Cupertino");
  assert.equal(
    profile?.logoUrl,
    "https://financialmodelingprep.com/image-stock/AAPL.png",
  );
  assert.equal(profile?.employees, 164_000);
  assert.equal(profile?.beta, 1.2);
  assert.equal(profile?.marketCap, 2_000);
  assert.equal(profile?.ipoDate, "1980-12-12");
  assert.equal(fetchMock.mock.callCount(), 3);
});

test("refreshes the anonymous cookie and crumb exactly once after quoteSummary 401", async (t) => {
  let credentialRound = 0;
  let summaryCalls = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.hostname === "fc.yahoo.com") {
      credentialRound += 1;
      return new Response("", {
        status: 404,
        headers: { "set-cookie": `A3=cookie-${credentialRound}; Path=/` },
      });
    }
    if (url.pathname === "/v1/test/getcrumb") {
      assert.equal(headers.get("cookie"), `A3=cookie-${credentialRound}`);
      return new Response(`crumb-${credentialRound}`);
    }
    summaryCalls += 1;
    assert.equal(url.searchParams.get("crumb"), `crumb-${summaryCalls}`);
    assert.equal(headers.get("cookie"), `A3=cookie-${summaryCalls}`);
    return summaryCalls === 1 ? jsonResponse({}, 401) : jsonResponse(quoteSummaryPayload());
  });
  const adapter = yahooProviderRegistration.create(ENABLED_ENV);
  assert.ok(adapter.fundamentals);

  const profile = await adapter.fundamentals.getProfile(AAPL, { requestId: "refresh-test" });
  assert.equal(profile?.sector, "Technology");
  assert.equal(credentialRound, 2);
  assert.equal(summaryCalls, 2);
  assert.equal(fetchMock.mock.callCount(), 6);
});

test("applies sanitized timeout errors to the anonymous profile handshake", async (t) => {
  t.mock.method(globalThis, "fetch", (_input: FetchInput, init?: FetchInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  const adapter = yahooProviderRegistration.create({
    ...ENABLED_ENV,
    UNICORN_YAHOO_TIMEOUT_MS: "10",
  });
  assert.ok(adapter.fundamentals);
  await assert.rejects(
    adapter.fundamentals.getProfile(AAPL, { requestId: "profile-timeout" }),
    (error: unknown) => error instanceof YahooProviderError
      && error.code === "request_timeout"
      && !error.message.includes("cookie"),
  );
});

test("falls back to the authenticated yfinance sidecar for profile and earnings", async (t) => {
  const sidecarToken = "sidecar-contract-secret";
  let nativeCredentialRequests = 0;
  const sidecarPaths: string[] = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.hostname === "fc.yahoo.com") {
      nativeCredentialRequests += 1;
      return new Response("", {
        status: 404,
        headers: { "set-cookie": `A3=rate-limited-${nativeCredentialRequests}; Path=/` },
      });
    }
    if (url.pathname === "/v1/test/getcrumb") {
      return new Response("Too Many Requests", { status: 429 });
    }
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(headers.get("authorization"), `Bearer ${sidecarToken}`);
    assert.equal(url.toString().includes(sidecarToken), false);
    assert.equal(url.searchParams.get("symbol"), "AAPL");
    sidecarPaths.push(url.pathname);
    if (url.pathname === "/v1/yahoo/profile") {
      assert.equal(url.searchParams.has("limit"), false);
      return jsonResponse({
        schemaVersion: "unicorn.yahoo-sidecar.v1",
        symbol: "AAPL",
        profile: {
          description: "Apple designs and sells consumer technology products.",
          website: "https://www.apple.com",
          sector: "Technology",
          industry: "Consumer Electronics",
          country: "United States",
          city: "Cupertino",
          employees: 150_000,
          beta: 1.12,
          marketCap: 4_500_000_000_000,
        },
        asOf: "2026-08-10T01:00:00Z",
        ingestedAt: "2026-08-10T01:00:01Z",
      });
    }
    assert.equal(url.pathname, "/v1/yahoo/earnings");
    assert.equal(url.searchParams.get("limit"), "24");
    return jsonResponse({
      schemaVersion: "unicorn.yahoo-sidecar.v1",
      symbol: "AAPL",
      earnings: [
        { reportDate: "2026-10-29", epsEstimate: 1.98, revenueEstimate: 113_256_580_210 },
        {
          reportDate: "2026-07-30",
          epsActual: 2.02,
          epsEstimate: 1.89,
          revenueActual: 109_417_000_000,
        },
      ],
      asOf: "2026-10-29",
      ingestedAt: "2026-08-10T01:00:02Z",
    });
  });
  const adapter = yahooProviderRegistration.create({
    ...ENABLED_ENV,
    UNICORN_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8765",
    UNICORN_TRADINGVIEW_SIDECAR_TOKEN: sidecarToken,
  });
  assert.ok(adapter.fundamentals);

  const profile = await adapter.fundamentals.getProfile(AAPL, { requestId: "sidecar-profile" });
  const earnings = await adapter.fundamentals.getEarnings(AAPL, { requestId: "sidecar-earnings" });

  assert.equal(profile?.description, "Apple designs and sells consumer technology products.");
  assert.equal(profile?.sector, "Technology");
  assert.equal(profile?.employees, 150_000);
  assert.equal(profile?.provenance.sourceId, "yahoo-yfinance-sidecar:AAPL:profile");
  assert.deepEqual(earnings.map((event) => ({
    reportDate: event.reportDate,
    epsActual: event.epsActual,
    epsEstimate: event.epsEstimate,
    revenueActual: event.revenueActual,
    revenueEstimate: event.revenueEstimate,
  })), [
    {
      reportDate: "2026-10-29",
      epsActual: undefined,
      epsEstimate: 1.98,
      revenueActual: undefined,
      revenueEstimate: 113_256_580_210,
    },
    {
      reportDate: "2026-07-30",
      epsActual: 2.02,
      epsEstimate: 1.89,
      revenueActual: 109_417_000_000,
      revenueEstimate: undefined,
    },
  ]);
  assert.deepEqual(sidecarPaths, ["/v1/yahoo/profile", "/v1/yahoo/earnings"]);
  assert.equal(nativeCredentialRequests, 2);
  assert.equal(fetchMock.mock.callCount(), 6);
});

test("rejects unexpected yfinance sidecar fields without exposing its token", async (t) => {
  const sidecarToken = "never-in-an-error";
  t.mock.method(globalThis, "fetch", async (input: FetchInput) => {
    const url = new URL(String(input));
    if (url.hostname === "fc.yahoo.com") {
      return new Response("", {
        status: 404,
        headers: { "set-cookie": "A3=anonymous; Path=/" },
      });
    }
    if (url.pathname === "/v1/test/getcrumb") {
      return new Response("Too Many Requests", { status: 429 });
    }
    return jsonResponse({
      schemaVersion: "unicorn.yahoo-sidecar.v1",
      symbol: "AAPL",
      profile: {
        description: "Apple profile",
        rawPayload: { token: sidecarToken },
      },
      asOf: "2026-08-10T01:00:00Z",
      ingestedAt: "2026-08-10T01:00:01Z",
    });
  });
  const adapter = yahooProviderRegistration.create({
    ...ENABLED_ENV,
    UNICORN_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8765",
    UNICORN_TRADINGVIEW_SIDECAR_TOKEN: sidecarToken,
  });

  await assert.rejects(
    adapter.fundamentals!.getProfile(AAPL, { requestId: "invalid-sidecar-profile" }),
    (error: unknown) => {
      assert.ok(error instanceof YahooProviderError);
      assert.equal(error.code, "invalid_response");
      assert.equal(error.message.includes(sidecarToken), false);
      return true;
    },
  );
});
