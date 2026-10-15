import assert from "node:assert/strict";
import test from "node:test";

import type { Instrument, ProviderRequestContext } from "../src/app/platform/provider-contracts";
import {
  createFmpProvider,
  FmpProviderError,
  fmpProviderRegistration,
  type FmpFetch,
} from "../api/fmp/index.server";

const SECRET = "fmp key?with&reserved=characters";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const CONTEXT = {
  requestId: "fmp-provider-test",
  asOf: NOW.toISOString(),
} as const satisfies ProviderRequestContext;

const INSTRUMENT = {
  instrumentId: "us:XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetType: "common_stock",
  active: true,
  listingCountry: "US",
  exchange: "NASDAQ Global Select",
  exchangeMic: "XNAS",
  currency: "USD",
  provenance: {
    providerId: "fmp",
    sourceId: "fixture:AAPL",
    asOf: NOW.toISOString(),
    ingestedAt: NOW.toISOString(),
  },
} as const satisfies Instrument;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function expectSafeProviderError(
  forbidden: readonly string[],
  expectedCode?: FmpProviderError["code"],
) {
  return (error: unknown) => {
    assert.ok(error instanceof FmpProviderError);
    if (expectedCode) assert.equal(error.code, expectedCode);
    for (const text of forbidden) {
      assert.equal(error.message.includes(text), false);
      assert.equal(String(error.stack).includes(text), false);
    }
    return true;
  };
}

test("publishes the complete FMP capability manifest without licensing flags as credentials", () => {
  assert.equal(fmpProviderRegistration.manifest.id, "fmp");
  assert.deepEqual(fmpProviderRegistration.manifest.requiredEnv, ["FMP_API_KEY"]);
  assert.deepEqual(fmpProviderRegistration.manifest.capabilities, [
    "instrument.search",
    "instrument.identity",
    "market.quote",
    "market.bars",
    "fundamentals.profile",
    "fundamentals.normalized",
    "fundamentals.earnings",
    "analyst.consensus",
    "news.company",
  ]);
});

test("requires an API key and an explicit restricted-data usage mode", () => {
  assert.throws(
    () => createFmpProvider({ TRADER_USAGE_MODE: "personal" }),
    expectSafeProviderError(["FMP_API_KEY"], "configuration"),
  );
  assert.throws(
    () => createFmpProvider({ FMP_API_KEY: SECRET }),
    expectSafeProviderError([SECRET, "FMP_API_KEY"], "configuration"),
  );

  assert.doesNotThrow(() => createFmpProvider({
    FMP_API_KEY: SECRET,
    TRADER_USAGE_MODE: "personal",
  }));
  assert.doesNotThrow(() => createFmpProvider({
    FMP_API_KEY: SECRET,
    TRADER_ALLOW_RESTRICTED_PUBLIC_DISPLAY: "true",
  }));
});

test("deduplicates search candidates and returns only supported active US listings", async () => {
  const requests: URL[] = [];
  const profiles: Record<string, unknown> = {
    AAPL: {
      symbol: "AAPL",
      companyName: "Apple Inc.",
      isActivelyTrading: true,
      country: "US",
      currency: "USD",
      exchangeShortName: "NASDAQ",
      sector: "Technology",
    },
    TSM: {
      symbol: "TSM",
      companyName: "Taiwan Semiconductor ADR",
      isActivelyTrading: true,
      isAdr: true,
      country: "US",
      currency: "USD",
      exchangeShortName: "NYSE",
    },
    SPY: {
      symbol: "SPY",
      companyName: "SPDR S&P 500 ETF Trust",
      isActivelyTrading: true,
      isEtf: true,
      country: "US",
      currency: "USD",
      exchangeShortName: "NYSE Arca",
    },
    SAP: {
      symbol: "SAP",
      companyName: "SAP SE",
      isActivelyTrading: true,
      country: "DE",
      currency: "USD",
      exchangeShortName: "NYSE",
    },
    DEAD: {
      symbol: "DEAD",
      companyName: "Inactive Corp.",
      isActivelyTrading: false,
      country: "US",
      currency: "USD",
      exchangeShortName: "NASDAQ",
    },
    FUND: {
      symbol: "FUND",
      companyName: "Example Mutual Fund",
      isActivelyTrading: true,
      type: "Mutual Fund",
      country: "US",
      currency: "USD",
      exchangeShortName: "NASDAQ",
    },
    OTCM: {
      symbol: "OTCM",
      companyName: "OTC Markets Group Inc.",
      isActivelyTrading: true,
      country: "US",
      currency: "USD",
      exchangeShortName: "OTC",
    },
  };
  const fetch: FmpFetch = async (input) => {
    const url = requestUrl(input);
    requests.push(url);
    assert.equal(url.searchParams.get("apikey"), SECRET);
    if (url.pathname === "/stable/search-symbol") {
      return json([
        { symbol: "AAPL" },
        { symbol: "SPY" },
        { symbol: "SAP" },
        { symbol: "DEAD" },
        { symbol: "TSM" },
        { symbol: "OTCM" },
        { symbol: "AAPL" },
      ]);
    }
    if (url.pathname === "/stable/search-name") {
      return json([{ symbol: "AAPL" }, { symbol: "FUND" }, { symbol: "TSM" }]);
    }
    if (url.pathname === "/stable/profile") {
      const symbol = url.searchParams.get("symbol") || "";
      return json(profiles[symbol] ? [profiles[symbol]] : []);
    }
    return json({ error: "unexpected route" }, 404);
  };
  const provider = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch, now: () => new Date(NOW) },
  );
  assert.ok(provider.instrument);

  const results = await provider.instrument.searchUSStocks({ query: "apple", limit: 10 }, CONTEXT);
  assert.deepEqual(results.map(({ symbol, assetType }) => [symbol, assetType]), [
    ["AAPL", "common_stock"],
    ["SAP", "common_stock"],
    ["TSM", "adr"],
  ]);
  assert.equal(new Set(requests
    .filter((url) => url.pathname === "/stable/profile")
    .map((url) => url.searchParams.get("symbol"))).size, 8);
  assert.ok(results.every((item) => item.active && item.listingCountry === "US"));
  assert.ok(results.every((item) => !item.provenance.sourceUrl?.includes("apikey")));
  assert.ok(results.every((item) => !item.provenance.sourceUrl?.includes(SECRET)));

  const callsBeforeInvalidIdentity = requests.length;
  assert.equal(await provider.instrument.getUSStockBySymbol("7203", CONTEXT), null);
  assert.equal(requests.length, callsBeforeInvalidIdentity);
});

test("prioritizes exact ticker aliases and accepts foreign issuers on US exchanges", async () => {
  const requestedProfiles: string[] = [];
  const profiles: Record<string, unknown> = {
    NVO: {
      symbol: "NVO",
      companyName: "Novo Nordisk A/S",
      isActivelyTrading: true,
      isAdr: true,
      country: "DK",
      currency: "USD",
      exchangeShortName: "NYSE",
    },
    ARM: {
      symbol: "ARM",
      companyName: "Arm Holdings plc",
      isActivelyTrading: true,
      securityType: "Depositary Receipt",
      country: "GB",
      currency: "USD",
      exchangeShortName: "NASDAQ",
    },
    TMC: {
      symbol: "TMC",
      companyName: "TMC the metals company Inc.",
      isActivelyTrading: true,
      country: "CA",
      currency: "USD",
      exchangeShortName: "NASDAQ",
    },
    BABA: {
      symbol: "BABA",
      companyName: "Alibaba Group Holding Limited",
      isActivelyTrading: true,
      isADR: true,
      country: "CN",
      currency: "USD",
      exchangeShortName: "NYSE",
    },
    SHOP: {
      symbol: "SHOP",
      companyName: "Shopify Inc.",
      isActivelyTrading: true,
      country: "CA",
      currency: "USD",
      exchangeShortName: "NASDAQ",
    },
    "BRK-B": {
      symbol: "BRK-B",
      companyName: "Berkshire Hathaway Inc.",
      isActivelyTrading: true,
      country: "US",
      currency: "USD",
      exchangeShortName: "NYSE",
    },
    "NOVO-B": {
      symbol: "NOVO-B",
      companyName: "Novo Nordisk A/S",
      isActivelyTrading: true,
      country: "DK",
      currency: "DKK",
      exchangeShortName: "CPH",
    },
  };
  const fetch: FmpFetch = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/stable/search-symbol") {
      const query = url.searchParams.get("query");
      if (query === "ARM") return json([{ symbol: "ARMV" }]);
      if (query === "TMC") return json([{ symbol: "TMCV" }]);
      return json([]);
    }
    if (url.pathname === "/stable/search-name") {
      return url.searchParams.get("query") === "Novo Nordisk"
        ? json([{ symbol: "NVO" }])
        : json([]);
    }
    if (url.pathname === "/stable/profile") {
      const symbol = url.searchParams.get("symbol") || "";
      requestedProfiles.push(symbol);
      return json(profiles[symbol] ? [profiles[symbol]] : []);
    }
    return json([], 404);
  };
  const provider = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch, now: () => new Date(NOW) },
  );

  const cases = [
    ["Novo Nordisk", "NVO"],
    ["ARM", "ARM"],
    ["TMC", "TMC"],
    ["BABA", "BABA"],
    ["SHOP", "SHOP"],
    ["BRK.B", "BRK-B"],
  ] as const;
  for (const [query, expectedSymbol] of cases) {
    const results = await provider.instrument?.searchUSStocks({ query, limit: 20 }, CONTEXT);
    assert.equal(results?.[0]?.symbol, expectedSymbol);
    assert.ok(results?.every((item) => (
      item.active
      && item.listingCountry === "US"
      && item.currency === "USD"
      && (item.assetType === "common_stock" || item.assetType === "adr")
    )));
  }

  const berkshire = await provider.instrument?.getUSStockBySymbol("BRK.B", CONTEXT);
  assert.equal(berkshire?.symbol, "BRK-B");
  assert.ok(requestedProfiles.includes("BRK-B"));
  assert.equal(await provider.instrument?.getUSStockBySymbol("NOVO-B", CONTEXT), null);
});

test("continues symbol search when one FMP search endpoint is unavailable", async () => {
  const fetch: FmpFetch = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/stable/search-symbol") return json([{ symbol: "AAPL" }]);
    if (url.pathname === "/stable/search-name") return json({ internal: SECRET }, 503);
    if (url.pathname === "/stable/profile") {
      return json([{
        symbol: "AAPL",
        companyName: "Apple Inc.",
        isActivelyTrading: true,
        country: "US",
        currency: "USD",
        exchangeShortName: "NASDAQ",
      }]);
    }
    return json([], 404);
  };
  const provider = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch, now: () => new Date(NOW) },
  );

  const results = await provider.instrument?.searchUSStocks({ query: "AAPL" }, CONTEXT);
  assert.deepEqual(results?.map((item) => item.symbol), ["AAPL"]);
});

test("normalizes quote, bars, profile, fundamentals, earnings, analyst, and news payloads", async () => {
  const requests: URL[] = [];
  const fetch: FmpFetch = async (input) => {
    const url = requestUrl(input);
    requests.push(url);
    switch (url.pathname) {
      case "/stable/quote":
        return json([{
          symbol: "AAPL",
          price: 225,
          change: 5,
          changesPercentage: 2.2727,
          previousClose: 220,
          open: 221,
          dayHigh: 226,
          dayLow: 219,
          volume: 42_000_000,
          marketCap: 3_400_000_000_000,
          timestamp: 1_786_279_200,
          marketState: "REGULAR",
        }]);
      case "/stable/historical-price-eod/full":
        return json({ historical: [
          { date: "2026-08-08", open: 220, high: 226, low: 219, close: 225, adjClose: 224.9, volume: 42 },
          { date: "2026-08-07", open: 218, high: 222, low: 217, close: 220, adjClose: 219.9, volume: 41 },
        ] });
      case "/stable/profile":
        return json([{
          symbol: "AAPL",
          companyName: "Apple Inc.",
          description: "Consumer technology company",
          website: "https://www.apple.com",
          sector: "Technology",
          industry: "Consumer Electronics",
          country: "US",
          city: "Cupertino",
          fullTimeEmployees: "164000",
          image: "https://images.example.test/aapl.png",
          beta: 1.21,
          mktCap: 3_400_000_000_000,
          ipoDate: "1980-12-12",
        }]);
      case "/stable/key-metrics-ttm":
        return json([{
          enterpriseValueTTM: 3_500,
          evToSalesTTM: 8.3,
          evToEBITDATTM: 24,
          returnOnInvestedCapitalTTM: 0.42,
          earningsYieldTTM: 0.031,
          peRatioTTM: 32,
          pbRatioTTM: 45,
          priceToSalesRatioTTM: 8,
          returnOnEquityTTM: 1.5,
          returnOnAssetsTTM: 0.3,
          dividendYieldTTM: 0.004,
          freeCashFlowTTM: 110_000_000_000,
          freeCashFlowYieldTTM: 0.032,
          debtToEquityTTM: 1.8,
          currentRatioTTM: 0.9,
        }]);
      case "/stable/ratios-ttm":
        return json([{
          grossProfitMarginTTM: 0.46,
          operatingProfitMarginTTM: 0.31,
          ebitdaMarginTTM: 0.34,
          netProfitMarginTTM: 0.25,
          assetTurnoverTTM: 1.2,
          interestCoverageRatioTTM: 12,
          priceToEarningsGrowthRatioTTM: 1.4,
          priceToFreeCashFlowRatioTTM: 28,
          quickRatioTTM: 0.8,
          cashRatioTTM: 0.3,
          dividendPayoutRatioTTM: 0.16,
          dividendPerShareTTM: 1.05,
          revenuePerShareTTM: 28,
          bookValuePerShareTTM: 7,
          operatingCashFlowPerShareTTM: 8,
          freeCashFlowPerShareTTM: 7.2,
        }]);
      case "/stable/income-statement":
        return json([
          {
            calendarYear: "2025",
            date: "2025-09-27",
            revenue: 420,
            grossProfit: 193,
            operatingIncome: 130,
            ebitda: 143,
            netIncome: 105,
            epsDiluted: 7,
            grossProfitRatio: 0.46,
          },
          { calendarYear: "2024", revenue: 400, netIncome: 100, epsDiluted: 6.5, grossProfitRatio: 0.45 },
        ]);
      case "/stable/balance-sheet-statement":
        return json([{
          date: "2025-09-27",
          cashAndShortTermInvestments: 55,
          totalAssets: 360,
          totalDebt: 112,
          netDebt: 57,
          totalStockholdersEquity: 74,
        }]);
      case "/stable/cash-flow-statement":
        return json([{
          date: "2025-09-27",
          operatingCashFlow: 120,
          capitalExpenditure: -12,
          freeCashFlow: 108,
        }]);
      case "/stable/shares-float":
        return json([{
          symbol: "AAPL",
          date: "2026-08-09 20:12:15",
          freeFloat: 99.87879921341867,
          floatShares: 14_669_554_809,
          outstandingShares: 14_687_356_000,
          source: "https://www.sec.gov/",
        }]);
      case "/stable/financial-scores":
        return json([{
          symbol: "AAPL",
          reportedCurrency: "USD",
          altmanZScore: 12.61237092657927,
          piotroskiScore: 9,
          workingCapital: 492_000_000,
        }]);
      case "/stable/earnings":
        return json([
          { date: "2026-07-30", epsActual: 1.6, epsEstimated: 1.5, revenueActual: 100, revenueEstimated: 98 },
          { date: "2026-04-30", epsActual: 1.5, epsEstimated: 1.4 },
        ]);
      case "/stable/price-target-consensus":
        return json([{ targetLow: 190, targetHigh: 300, targetConsensus: 250, targetMedian: 248 }]);
      case "/stable/grades-consensus":
        return json([{ strongBuy: 12, buy: 18, hold: 7, sell: 1, strongSell: 0 }]);
      case "/stable/analyst-estimates":
        return json([{ date: "2027-09-30", estimatedEpsAvg: 8.2, estimatedRevenueAvg: 450, numberAnalystsEstimatedEps: 36 }]);
      case "/stable/news/stock":
        return json([{
          id: "apple-update",
          title: "Apple announces a product update",
          text: "A concise summary.",
          url: "https://news.example.test/apple-update",
          site: "Example News",
          publishedDate: "2026-08-09 10:30:00",
          image: "https://news.example.test/image.png",
        }, {
          id: "apple-update",
          title: "Duplicate by id",
          url: "https://news.example.test/other-path",
          site: "Example News",
          publishedDate: "2026-08-09 10:31:00",
        }, {
          id: "different-id",
          title: "Duplicate by URL",
          url: "https://news.example.test/apple-update",
          site: "Example News",
          publishedDate: "2026-08-09 10:32:00",
        }]);
      default:
        return json([], 404);
    }
  };
  const provider = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch, now: () => new Date(NOW) },
  );
  assert.ok(provider.market?.getBars);
  assert.ok(provider.fundamentals);
  assert.ok(provider.analyst);
  assert.ok(provider.news);

  const quote = await provider.market.getQuote(INSTRUMENT, CONTEXT);
  const bars = await provider.market.getBars(INSTRUMENT, { range: "1y", interval: "1d" }, CONTEXT);
  const profile = await provider.fundamentals.getProfile(INSTRUMENT, CONTEXT);
  const fundamentals = await provider.fundamentals.getFundamentals(INSTRUMENT, CONTEXT);
  const earnings = await provider.fundamentals.getEarnings(INSTRUMENT, CONTEXT);
  const analyst = await provider.analyst.getConsensus(INSTRUMENT, CONTEXT);
  const news = await provider.news.getCompanyNews(INSTRUMENT, CONTEXT);

  assert.equal(quote?.price, 225);
  assert.equal(quote?.marketState, "regular");
  assert.equal(quote?.currency, "USD");
  assert.deepEqual(bars?.items.map((bar) => [bar.time.slice(0, 10), bar.close]), [
    ["2026-08-07", 220],
    ["2026-08-08", 225],
  ]);
  assert.equal(profile?.employees, 164_000);
  assert.equal(profile?.logoUrl, "https://financialmodelingprep.com/image-stock/AAPL.png");
  assert.equal(fundamentals?.period, "2025");
  assert.equal(fundamentals?.revenueGrowth, 0.05);
  assert.equal(fundamentals?.trailingPe, 32);
  assert.equal(fundamentals?.grossMargin, 0.46);
  assert.equal(fundamentals?.grossProfit, 193);
  assert.equal(fundamentals?.operatingIncome, 130);
  assert.equal(fundamentals?.ebitda, 143);
  assert.equal(fundamentals?.enterpriseValue, 3_500);
  assert.equal(fundamentals?.enterpriseValueToRevenue, 8.3);
  assert.equal(fundamentals?.enterpriseValueToEbitda, 24);
  assert.equal(fundamentals?.pegRatio, 1.4);
  assert.equal(fundamentals?.priceToFreeCashFlow, 28);
  assert.equal(fundamentals?.earningsYield, 0.031);
  assert.equal(fundamentals?.roic, 0.42);
  assert.equal(fundamentals?.ebitdaMargin, 0.34);
  assert.equal(fundamentals?.freeCashFlowMargin, 108 / 420);
  assert.equal(fundamentals?.assetTurnover, 1.2);
  assert.equal(fundamentals?.interestCoverage, 12);
  assert.equal(fundamentals?.cashAndShortTermInvestments, 55);
  assert.equal(fundamentals?.totalAssets, 360);
  assert.equal(fundamentals?.totalDebt, 112);
  assert.equal(fundamentals?.netDebt, 57);
  assert.equal(fundamentals?.shareholdersEquity, 74);
  assert.equal(fundamentals?.operatingCashFlow, 120);
  assert.equal(fundamentals?.capitalExpenditure, -12);
  assert.equal(fundamentals?.freeCashFlow, 108);
  assert.equal(fundamentals?.quickRatio, 0.8);
  assert.equal(fundamentals?.cashRatio, 0.3);
  assert.equal(fundamentals?.dividendPerShare, 1.05);
  assert.equal(fundamentals?.payoutRatio, 0.16);
  assert.equal(fundamentals?.revenuePerShare, 28);
  assert.equal(fundamentals?.bookValuePerShare, 7);
  assert.equal(fundamentals?.operatingCashFlowPerShare, 8);
  assert.equal(fundamentals?.freeCashFlowPerShare, 7.2);
  assert.ok(Math.abs((fundamentals?.shareStructure?.freeFloatRatio ?? 0) - 0.9987879921341868) < 1e-12);
  assert.equal(fundamentals?.shareStructure?.floatShares, 14_669_554_809);
  assert.equal(fundamentals?.shareStructure?.outstandingShares, 14_687_356_000);
  assert.equal(fundamentals?.shareStructure?.provenance.sourceId, "fmp:shares-float:AAPL");
  assert.equal(fundamentals?.shareStructure?.provenance.asOf, "2026-08-09T20:12:15.000Z");
  assert.equal(fundamentals?.financialHealth?.altmanZScore, 12.61237092657927);
  assert.equal(fundamentals?.financialHealth?.piotroskiScore, 9);
  assert.equal(fundamentals?.financialHealth?.provenance.sourceId, "fmp:financial-scores:AAPL");
  assert.equal(earnings[0]?.reportDate, "2026-07-30");
  assert.equal(analyst?.targetConsensus, 250);
  assert.equal(analyst?.analystCount, 36);
  assert.equal(analyst?.forwardEps, 8.2);
  assert.equal(news.length, 1, "duplicate provider ids or URLs must not create extra stories");
  assert.equal(news[0]?.publisher, "Example News");
  assert.equal(news[0]?.publishedAt, "2026-08-09T10:30:00.000Z");

  const outputs = [quote, bars, profile, fundamentals, ...earnings, analyst, ...news]
    .filter((value) => value !== null);
  for (const output of outputs) {
    const serialized = JSON.stringify(output);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes("apikey"), false);
  }
  assert.ok(requests.every((url) => url.searchParams.get("apikey") === SECRET));
  assert.ok(requests.some((url) => url.pathname === "/stable/historical-price-eod/full"));
});

test("does not fabricate missing quote fields or OHLCV volume", async () => {
  const completeQuote: Record<string, unknown> = {
    symbol: "AAPL",
    price: 225,
    previousClose: 220,
    open: 221,
    dayHigh: 226,
    dayLow: 219,
    volume: 42_000_000,
    timestamp: 1_786_279_200,
    marketState: "REGULAR",
  };
  let quotePayload: Record<string, unknown> = completeQuote;
  const fetch: FmpFetch = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/stable/quote") return json([quotePayload]);
    if (url.pathname === "/stable/historical-price-eod/full") {
      return json({ historical: [
        { date: "2026-08-07", open: 218, high: 222, low: 217, close: 220 },
        { date: "2026-08-08", open: 220, high: 226, low: 219, close: 225, volume: 42 },
        { date: "2026-08-09", open: 225, high: 227, low: 224, close: 226, volume: 0 },
        { date: "2026-08-10", open: 0, high: 227, low: 224, close: 226, volume: 42 },
        { date: "2026-08-11", open: 225, high: 224, low: 223, close: 226, volume: 42 },
        { date: "2026-08-12", open: 225, high: 227, low: 226, close: 224, volume: 42 },
        { date: "2026-08-13", open: 225, high: 227, low: 224, close: 226, volume: -1 },
      ] });
    }
    return json([]);
  };
  const provider = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch, now: () => new Date(NOW) },
  );

  for (const missingField of ["previousClose", "open", "dayHigh", "dayLow", "volume", "timestamp"]) {
    quotePayload = { ...completeQuote };
    delete quotePayload[missingField];
    assert.equal(
      await provider.market?.getQuote(INSTRUMENT, CONTEXT),
      null,
      missingField,
    );
  }

  quotePayload = { ...completeQuote };
  const derivedQuote = await provider.market?.getQuote(INSTRUMENT, CONTEXT);
  assert.equal(derivedQuote?.change, 5, "change may be derived from two real prices");
  assert.ok(Math.abs((derivedQuote?.changePercent ?? 0) - (5 / 220) * 100) < 1e-10);

  const bars = await provider.market?.getBars?.(
    INSTRUMENT,
    { range: "1mo", interval: "1d" },
    CONTEXT,
  );
  assert.deepEqual(bars?.items.map((bar) => [bar.time, bar.volume]), [
    ["2026-08-08T00:00:00.000Z", 42],
    ["2026-08-09T00:00:00.000Z", 0],
  ]);
});

test("all-zero analyst payloads remain unavailable instead of neutral", async () => {
  const fetch: FmpFetch = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/stable/price-target-consensus") {
      return json([{ targetLow: 0, targetHigh: 0, targetConsensus: 0, targetMedian: 0, analystCount: 0 }]);
    }
    if (url.pathname === "/stable/grades-consensus") {
      return json([{ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }]);
    }
    if (url.pathname === "/stable/analyst-estimates") return json([]);
    return json([]);
  };
  const provider = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch, now: () => new Date(NOW) },
  );
  assert.equal(await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT), null);
});

test("returns a partial fundamental snapshot when optional upstream datasets are missing", async () => {
  const fetch: FmpFetch = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/stable/income-statement") {
      return json([{ calendarYear: "2025", revenue: 420, netIncome: 105, epsDiluted: 7 }]);
    }
    return json({ detail: `restricted ${SECRET}` }, 403);
  };
  const provider = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch, now: () => new Date(NOW) },
  );

  const result = await provider.fundamentals?.getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(result?.revenue, 420);
  assert.equal(result?.netIncome, 105);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("strictly rejects malformed supplemental fundamentals without fabricating zero values", async () => {
  const fetch: FmpFetch = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/stable/shares-float") {
      return json([
        { symbol: "MSFT", freeFloat: 80, floatShares: 80, outstandingShares: 100 },
        { symbol: "AAPL", freeFloat: "99.1", floatShares: -1, outstandingShares: 12.5 },
      ]);
    }
    if (url.pathname === "/stable/financial-scores") {
      return json([{ symbol: "AAPL", altmanZScore: "4.2", piotroskiScore: 9.5 }]);
    }
    return json({ error: "not entitled" }, 403);
  };
  const provider = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch, now: () => new Date(NOW) },
  );

  const result = await provider.fundamentals?.getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(result, null);
});

test("sanitizes upstream, response, network, and timeout failures", async () => {
  const upstreamFetch: FmpFetch = async () => new Response(
    `credential=${SECRET}; url=https://financialmodelingprep.com/stable/quote`,
    { status: 403 },
  );
  const upstream = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch: upstreamFetch, now: () => new Date(NOW) },
  );
  assert.ok(upstream.market);
  await assert.rejects(
    upstream.market.getQuote(INSTRUMENT, CONTEXT),
    expectSafeProviderError([SECRET, "financialmodelingprep.com", "credential="], "upstream"),
  );

  const invalidJson = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch: async () => new Response(`not-json ${SECRET}`), now: () => new Date(NOW) },
  );
  assert.ok(invalidJson.market);
  await assert.rejects(
    invalidJson.market.getQuote(INSTRUMENT, CONTEXT),
    expectSafeProviderError([SECRET, "not-json"], "invalid_response"),
  );

  const network = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch: async () => { throw new Error(`network leaked ${SECRET}`); }, now: () => new Date(NOW) },
  );
  assert.ok(network.market);
  await assert.rejects(
    network.market.getQuote(INSTRUMENT, CONTEXT),
    expectSafeProviderError([SECRET, "network leaked"], "network"),
  );

  const timeoutFetch: FmpFetch = () => new Promise(() => {
    // An injected client may ignore AbortSignal; the adapter still owns the deadline.
  });
  const timeout = createFmpProvider(
    { FMP_API_KEY: SECRET, TRADER_USAGE_MODE: "personal" },
    { fetch: timeoutFetch, now: () => new Date(NOW), timeoutMs: 2 },
  );
  assert.ok(timeout.market);
  await assert.rejects(
    timeout.market.getQuote(INSTRUMENT, CONTEXT),
    expectSafeProviderError([SECRET, "abort"], "timeout"),
  );
});
