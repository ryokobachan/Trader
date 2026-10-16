import assert from "node:assert/strict";
import test from "node:test";
import type { Instrument, ProviderRequestContext } from "../src/app/platform/provider-contracts";
import {
  createTradingViewProvider,
  tradingViewProviderRegistration,
  TRADINGVIEW_FUNDAMENTAL_COLUMNS,
  TradingViewFundamentalsError,
  type TradingViewFundamentalsFetch,
} from "../api/tradingview/index.server";

const NOW = new Date("2026-09-05T05:00:00.000Z");
const CONTEXT: ProviderRequestContext = { requestId: "tradingview-fundamentals-test" };
const INSTRUMENT: Instrument = {
  instrumentId: "us:XNAS:MU", symbol: "MU", name: "Micron", assetType: "common_stock",
  active: true, listingCountry: "US", exchange: "NASDAQ Global Select", exchangeMic: "XNAS", currency: "USD",
  provenance: { providerId: "test", sourceId: "test:MU", asOf: NOW.toISOString(), ingestedAt: NOW.toISOString() },
};

function payload(row: Record<string, unknown> = {}, symbol = "NASDAQ:MU") {
  const values = { currency: "USD", fundamental_currency_code: "USD", fiscal_period_fy: "2025", total_revenue_fy: 1_000, ...row };
  return { totalCount: 1, data: [{ s: symbol, d: TRADINGVIEW_FUNDAMENTAL_COLUMNS.map((column) => values[column as keyof typeof values] ?? null) }] };
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function provider(row: Record<string, unknown> = {}) {
  return createTradingViewProvider({}, { fetch: async () => response(payload(row)), now: () => NOW }).fundamentals!;
}

function code(expected: TradingViewFundamentalsError["code"]) {
  return (error: unknown) => error instanceof TradingViewFundamentalsError && error.code === expected;
}

test("missing PER and PEG are calculated from same-response TradingView inputs with explicit TTM/NTM definitions", async () => {
  const result = await provider({ close: 120, earnings_per_share_diluted_ttm: 4,
    eps_estimate_ntm: 6, earnings_per_share_diluted_yoy_growth_ttm: 25,
    earnings_per_share_diluted_fy: 99, earnings_per_share_diluted_yoy_growth_fy: 999,
  }).getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(result?.trailingPe, 30);
  assert.equal(result?.forwardPe, 20);
  assert.equal(result?.pegRatio, 1.2, "25% growth divides by 25, not 0.25");
  assert.equal(result?.valuationSources?.trailingPe?.status, "calculated");
  assert.equal(result?.valuationSources?.forwardPe?.calculation?.earningsPeriod, "NTM");
  assert.equal(result?.valuationSources?.pegRatio?.calculation?.growthBasis, "diluted-eps-ttm-yoy");
  assert.equal(result?.valuationSources?.pegRatio?.provenance.providerId, "tradingview");
  assert.equal(result?.eps, 99, "annual statement EPS remains annual, not overwritten by TTM EPS");
});

test("TradingView's published multiples win over reconstructed values and are not silently redefined", async () => {
  const result = await provider({ close: 120, earnings_per_share_diluted_ttm: 4, eps_estimate_ntm: 6,
    earnings_per_share_diluted_yoy_growth_ttm: 25, price_earnings_ttm: 31, price_earnings_fwd: 21,
    price_earnings_growth_ttm: 1.3,
  }).getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(result?.trailingPe, 31);
  assert.equal(result?.forwardPe, 21);
  assert.equal(result?.pegRatio, 1.3);
  assert.equal(result?.valuationSources?.pegRatio?.status, "reported");
  assert.equal(result?.valuationSources?.pegRatio?.calculation, undefined);
});

test("valuation derivations reject absent, nonpositive or nonfinite earnings/growth without falling back to annual values", async () => {
  for (const value of [null, 0, -2, "4", Number.POSITIVE_INFINITY]) {
    const result = await provider({ close: 120, earnings_per_share_diluted_ttm: value, eps_estimate_ntm: value,
      earnings_per_share_diluted_yoy_growth_ttm: 25, earnings_per_share_diluted_fy: 4,
      earnings_per_share_diluted_yoy_growth_fy: 25,
    }).getFundamentals(INSTRUMENT, CONTEXT);
    assert.equal(result?.trailingPe, undefined);
    assert.equal(result?.forwardPe, undefined);
    assert.equal(result?.pegRatio, undefined);
  }
  const result = await provider({ close: 120, earnings_per_share_diluted_ttm: 4,
    earnings_per_share_diluted_yoy_growth_ttm: -5 }).getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(result?.trailingPe, 30);
  assert.equal(result?.pegRatio, undefined);
});

test("TradingView advertises financial statements and dated earnings without upstream credentials", async () => {
  assert.equal(tradingViewProviderRegistration.manifest.id, "tradingview");
  assert.deepEqual(tradingViewProviderRegistration.manifest.requiredEnv, []);
  assert.deepEqual(tradingViewProviderRegistration.manifest.capabilities, ["fundamentals.profile", "fundamentals.normalized", "fundamentals.earnings", "fundamentals.research"]);
  assert.equal(new Set(TRADINGVIEW_FUNDAMENTAL_COLUMNS).size, TRADINGVIEW_FUNDAMENTAL_COLUMNS.length);
  assert.deepEqual(await provider().getEarnings(INSTRUMENT, CONTEXT), []);
});

test("partial WebSocket history cannot erase usable TradingView scanner annual statements", async () => {
  const adapter = createTradingViewProvider({ TRADER_TRADINGVIEW_SIDECAR_URL: "http://localhost:9876", TRADER_TRADINGVIEW_SIDECAR_TOKEN: "test-token" }, {
    now: () => NOW,
    fetch: async input => new URL(String(input)).pathname === "/v1/tradingview/financials" ? response({
      schemaVersion: "trader.tradingview-financials.v1", sourceSymbol: "NASDAQ:MU", observedAt: NOW.toISOString(),
      values: { currency_code: "USD", fundamental_currency_code: "USD", fiscal_period_fq_h: ["2025-Q3"], total_revenue_fq_h: [80] },
    }) : response(payload({ fiscal_period_fy_h: [2025, 2024], total_revenue_fy_h: [300, 200], earnings_per_share_diluted_fy_h: [3, 2] })),
  }).fundamentals!;
  const result = await adapter.getFundamentals(INSTRUMENT, CONTEXT);
  assert.deepEqual(result?.annualFinancials?.map(row => [row.period, row.revenue, row.eps]), [["2025", 300, 3], ["2024", 200, 2]]);
  assert.match(result?.annualFinancials?.[0].provenance.sourceId ?? "", /scanner/);
  assert.equal(result?.quarterlyFinancials?.[0].period, "2025-Q3");
  assert.match(result?.quarterlyFinancials?.[0].provenance.sourceId ?? "", /financial-websocket/);
});

test("WebSocket responses with no usable quarters do not claim quarterly research coverage", async () => {
  for (const quarterFields of [{}, { fiscal_period_fq_h: [], total_revenue_fq_h: [] }, { fiscal_period_fq_h: ["2025-Q3"], total_revenue_fq_h: [null] }]) {
    const adapter = createTradingViewProvider({ TRADER_TRADINGVIEW_SIDECAR_URL: "http://localhost:9876", TRADER_TRADINGVIEW_SIDECAR_TOKEN: "test-token" }, {
      now: () => NOW, fetch: async () => response({
        schemaVersion: "trader.tradingview-financials.v1", sourceSymbol: "NASDAQ:MU", observedAt: NOW.toISOString(),
        values: { currency_code: "USD", fundamental_currency_code: "USD", ...quarterFields },
      }),
    }).fundamentals!;
    const result = await adapter.getResearch!(INSTRUMENT, CONTEXT);
    assert.deepEqual(result?.quarterlyFinancials, []);
    assert.equal(result?.coverage.quarterlyFinancials, "unavailable");
  }
});

test("maps annual monetary totals and signed expenses without scaling; only percentage fields become fractions", async () => {
  const result = await provider({
    total_revenue_fy: 37_378_000_000, revenue_per_share_fy: 33.2248,
    capital_expenditures_fy: -15_857_000_000, research_and_dev_fy: -3_798_000_000,
    sell_gen_admin_exp_other_fy: -1_205_000_000, cash_f_investing_activities_fy: -14_087_000_000,
    cash_f_financing_activities_fy: -850_000_000, total_liabilities_fy: 28_633_000_000,
    total_revenue_yoy_growth_fy: 48.85, gross_margin_fy: 40.165, return_on_equity_fy: 17.2,
    current_ratio_fy: 2.518, debt_to_equity_fy: 0.2834, price_earnings_ttm: 23.01,
    price_free_cash_flow_ttm: 40, earnings_yield: 4.34, dividends_yield_fy: 0.377,
  }).getFundamentals(INSTRUMENT, CONTEXT);
  assert.ok(result);
  assert.equal(result.reportingBasis, "annual");
  assert.equal(result.period, "2025");
  assert.equal(result.revenue, 37_378_000_000);
  assert.equal(result.revenuePerShare, 33.2248);
  assert.equal(result.capitalExpenditure, -15_857_000_000);
  assert.equal(result.researchAndDevelopment, -3_798_000_000);
  assert.equal(result.sellingGeneralAndAdministrative, -1_205_000_000);
  assert.equal(result.investingCashFlow, -14_087_000_000);
  assert.equal(result.financingCashFlow, -850_000_000);
  assert.equal(result.totalLiabilities, 28_633_000_000);
  assert.equal(result.revenueGrowth, 0.4885);
  assert.equal(result.grossMargin, 0.40165);
  assert.equal(result.roe, 0.172);
  assert.equal(result.currentRatio, 2.518);
  assert.equal(result.debtToEquity, 0.2834);
  assert.equal(result.trailingPe, 23.01);
  assert.equal(result.freeCashFlowYield, 0.025);
  assert.equal(result.earningsYield, 0.0434);
  assert.equal(result.dividendYield, 0.00377);
  assert.equal(result.provenance.providerId, "tradingview");
  assert.equal(result.provenance.asOf, NOW.toISOString());
  assert.match(result.provenance.sourceId, /NASDAQ:MU/);
  assert.equal(result.valuationSources?.trailingPe?.basis, "ttm");
  assert.equal(result.valuationSources?.trailingPe?.status, "reported");
  assert.equal(result.valuationSources?.trailingPe?.provenance.providerId, "tradingview");
  assert.equal(result.valuationSources?.forwardPe?.basis, "forward");
  assert.equal(result.valuationSources?.forwardPe?.status, "not_reported");
});

test("keeps absent fields absent, preserves actual zero, and does not clamp negative valid metrics", async () => {
  const result = await provider({
    net_income_fy: -50, dividends_yield_fy: 0, price_earnings_ttm: null,
    altman_z_score_ttm: null, piotroski_f_score_fy: null, gross_margin_fy: "12.5",
  }).getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(result?.netIncome, -50);
  assert.equal(result?.dividendYield, 0);
  assert.equal(result?.trailingPe, undefined);
  assert.equal(result?.grossMargin, undefined);
  assert.equal(result?.financialHealth, undefined);
  assert.equal(result?.shareStructure, undefined);
  assert.equal(await provider({ total_revenue_fy: null }).getFundamentals(INSTRUMENT, CONTEXT), null);
});

test("guards financial reporting currency separately from the listing currency", async () => {
  for (const currency of ["EUR", "TWD", null, ""]) {
    const source = provider({ fundamental_currency_code: currency, sector: "Technology", market_cap_basic: 5_000 });
    assert.equal(await source.getFundamentals(INSTRUMENT, CONTEXT), null);
    assert.equal((await source.getProfile(INSTRUMENT, CONTEXT))?.marketCap, 5_000);
  }
  const foreignQuote = provider({ currency: "EUR" });
  assert.equal(await foreignQuote.getFundamentals(INSTRUMENT, CONTEXT), null);
  assert.equal(await foreignQuote.getProfile(INSTRUMENT, CONTEXT), null);
});

test("normalizes share structure and validates discrete health scores with explicit bases", async () => {
  const result = await provider({ float_shares_outstanding: 75.5, total_shares_outstanding_fundamental: 100,
    altman_z_score_ttm: -1.5, piotroski_f_score_fy: 0 }).getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(result?.shareStructure?.freeFloatRatio, 0.755);
  assert.equal(result?.financialHealth?.altmanZScore, -1.5);
  assert.equal(result?.financialHealth?.altmanZScorePeriod, "TTM");
  assert.equal(result?.financialHealth?.piotroskiScore, 0);
  assert.equal(result?.financialHealth?.piotroskiScorePeriod, "FY 2025");
  for (const invalid of [9.5, 10, -1, "7"]) {
    const bad = await provider({ piotroski_f_score_fy: invalid, float_shares_outstanding: 120,
      total_shares_outstanding_fundamental: 100 }).getFundamentals(INSTRUMENT, CONTEXT);
    assert.equal(bad?.financialHealth, undefined);
    assert.equal(bad?.shareStructure?.freeFloatRatio, undefined);
  }
});

test("aligns annual history with explicit fiscal years and drops misaligned series", async () => {
  const result = await provider({
    fiscal_period_fy_h: [2025, 2024, 2023], fiscal_period_end_fy: 1_756_598_400,
    total_revenue_fy_h: [300, 200, null], net_income_fy_h: [30, 20, 10],
    total_assets_fy_h: [500, 400],
  }).getFundamentals(INSTRUMENT, CONTEXT);
  assert.deepEqual(result?.annualFinancials?.map((period) => [period.period, period.revenue, period.netIncome]),
    [["2025", 300, 30], ["2024", 200, 20], ["2023", undefined, 10]]);
  assert.equal(result?.annualFinancials?.[0].fiscalDateEnding, "2025-08-31");
  assert.equal(result?.annualFinancials?.[1].fiscalDateEnding, undefined);
  assert.equal(result?.annualFinancials?.[0].totalAssets, undefined);
  assert.equal(result?.quarterlyFinancials, undefined);
});

test("filters future/invalid/duplicate annual periods without inventing labels", async () => {
  const result = await provider({ fiscal_period_fy_h: [2026, 2025, "2025", "garbage"], total_revenue_fy_h: [4, 3, 2, 1] })
    .getFundamentals(INSTRUMENT, CONTEXT);
  assert.deepEqual(result?.annualFinancials?.map((period) => period.period), ["2025"]);
  assert.equal(result?.annualFinancials?.[0].revenue, 3);
});

test("separates reported fiscal consensus from future forecasts without fictitious release dates", async () => {
  const source = provider({
    earnings_fq_h: [
      { FiscalPeriod: "2026-Q2", IsReported: true, Actual: -0.12, Estimate: -0.70 },
      { FiscalPeriod: "2026-Q3", IsReported: false, Actual: 999, Estimate: -0.4 },
      { FiscalPeriod: "2026-Q4", Actual: 5, Estimate: 6 },
    ],
    revenues_fq_h: [
      { FiscalPeriod: "2026-Q2", IsReported: true, Actual: 582_300_000, Estimate: 573_940_000 },
      { FiscalPeriod: "2026-Q3", IsReported: false, Actual: 999, Estimate: 700_000_000 },
    ],
  });
  const result = await source.getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(result?.fiscalForecasts?.length, 2);
  assert.equal(result?.fiscalForecasts?.[0].reported, false);
  assert.equal(result?.fiscalForecasts?.[0].epsActual, undefined);
  assert.equal(result?.fiscalForecasts?.[0].revenueActual, undefined);
  assert.equal(result?.fiscalForecasts?.[0].epsEstimate, -0.4);
  assert.equal(result?.fiscalForecasts?.[1].epsActual, -0.12);
  assert.equal(result?.fiscalForecasts?.[1].revenueActual, 582_300_000);
  assert.equal("reportDate" in result!.fiscalForecasts![1], false);
  assert.deepEqual(await source.getEarnings(INSTRUMENT, CONTEXT), []);
});

test("conflicting reported flags cannot turn a forecast into an actual", async () => {
  const result = await provider({
    earnings_fq_h: [{ FiscalPeriod: "2026-Q2", IsReported: true, Actual: 1 }],
    revenues_fq_h: [{ FiscalPeriod: "2026-Q2", IsReported: false, Estimate: 2 }, { FiscalPeriod: "2026-Q2", IsReported: true, Actual: 3 }],
  }).getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(result?.fiscalForecasts, undefined);
});

test("does not search or guess a ticker when identity/exchange is unsupported", async () => {
  let calls = 0;
  const source = createTradingViewProvider({}, { fetch: async () => { calls++; return response(payload()); } }).fundamentals!;
  for (const change of [{ symbol: "" }, { symbol: "NASDAQ:MU" }, { symbol: "mu" }, { symbol: "../MU" },
    { exchangeMic: "UNKNOWN" }, { active: false }]) {
    assert.equal(await source.getFundamentals({ ...INSTRUMENT, ...change }, CONTEXT), null);
  }
  assert.equal(calls, 0);
});

test("uses the identified exchange and converts class-share punctuation in a fixed anonymous POST", async () => {
  const source = createTradingViewProvider({}, { fetch: async (url, init) => {
    assert.equal(String(url), "https://scanner.tradingview.com/america/scan");
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.symbols.tickers, ["NYSE:BRK.B"]);
    assert.equal(body.ignore_unknown_fields, false);
    assert.deepEqual(body.columns, TRADINGVIEW_FUNDAMENTAL_COLUMNS);
    return response(payload({}, "NYSE:BRK.B"));
  } }).fundamentals!;
  assert.ok(await source.getFundamentals({ ...INSTRUMENT, symbol: "BRK-B", exchangeMic: "XNYS" }, CONTEXT));
});

test("missing symbol is null; unexpected rows, truncation and invalid JSON fail closed", async () => {
  const empty = createTradingViewProvider({}, { fetch: async () => response({ totalCount: 0, data: [] }) }).fundamentals!;
  assert.equal(await empty.getFundamentals(INSTRUMENT, CONTEXT), null);
  for (const data of [payload({}, "NASDAQ:WRONG"), { totalCount: 1, data: [{ s: "NASDAQ:MU", d: [1] }] },
    { ...payload(), totalCount: 2 }, { error: "schema changed" }]) {
    const source = createTradingViewProvider({}, { fetch: async () => response(data) }).fundamentals!;
    await assert.rejects(source.getFundamentals(INSTRUMENT, CONTEXT), code("invalid_response"));
  }
  const invalid = createTradingViewProvider({}, { fetch: async () => new Response("<html>blocked</html>") }).fundamentals!;
  await assert.rejects(invalid.getFundamentals(INSTRUMENT, CONTEXT), code("invalid_response"));
});

test("network and HTTP errors remain safe and are not cached", async () => {
  let calls = 0;
  const source = createTradingViewProvider({}, { fetch: async () => {
    if (++calls === 1) throw new Error("sensitive upstream URL query");
    if (calls === 2) return response({ error: "not exposed" }, 403);
    return response(payload());
  } }).fundamentals!;
  await assert.rejects(source.getFundamentals(INSTRUMENT, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof TradingViewFundamentalsError);
    assert.equal(error.code, "network");
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
  await assert.rejects(source.getFundamentals(INSTRUMENT, CONTEXT), code("upstream"));
  assert.ok(await source.getFundamentals(INSTRUMENT, CONTEXT));
  assert.equal(calls, 3);
});

test("deadline covers response headers and stalled bodies and aborts the underlying request", async () => {
  let signal: AbortSignal | null | undefined;
  const hanging: TradingViewFundamentalsFetch = async (_url, init) => { signal = init?.signal; return new Promise(() => undefined); };
  const source = createTradingViewProvider({}, { fetch: hanging, timeoutMs: 5 }).fundamentals!;
  await assert.rejects(source.getFundamentals(INSTRUMENT, CONTEXT), code("timeout"));
  assert.equal(signal?.aborted, true);
  const stalledBody = createTradingViewProvider({}, {
    fetch: async () => new Response(new ReadableStream<Uint8Array>()), timeoutMs: 5,
  }).fundamentals!;
  await assert.rejects(stalledBody.getFundamentals(INSTRUMENT, CONTEXT), code("timeout"));
});

test("oversized responses fail before parsing", async () => {
  const source = createTradingViewProvider({}, { fetch: async () => new Response(" ".repeat(2_000_001)) }).fundamentals!;
  await assert.rejects(source.getFundamentals(INSTRUMENT, CONTEXT), code("invalid_response"));
});

test("deduplicates profile/fundamentals, expires cached data, and honors explicit refresh", async () => {
  let timestamp = NOW.getTime();
  let calls = 0;
  const source = createTradingViewProvider({}, { fetch: async () => { calls++; return response(payload()); },
    now: () => new Date(timestamp), cacheTtlMs: 100 }).fundamentals!;
  await Promise.all([source.getProfile(INSTRUMENT, CONTEXT), source.getFundamentals(INSTRUMENT, CONTEXT)]);
  assert.equal(calls, 1);
  timestamp += 99;
  await source.getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(calls, 1);
  timestamp += 1;
  await source.getFundamentals(INSTRUMENT, CONTEXT);
  assert.equal(calls, 2);
  await source.getFundamentals(INSTRUMENT, { ...CONTEXT, fresh: true });
  assert.equal(calls, 3);
});

test("fresh generation bypasses an older request and its result wins cache publication", async () => {
  const resolvers: ((value: Response) => void)[] = [];
  const source = createTradingViewProvider({}, { fetch: async () => new Promise((resolve) => resolvers.push(resolve)) }).fundamentals!;
  const old = source.getFundamentals(INSTRUMENT, CONTEXT);
  const fresh = source.getFundamentals(INSTRUMENT, { ...CONTEXT, fresh: true });
  assert.equal(resolvers.length, 2);
  resolvers[1](response(payload({ total_revenue_fy: 200 })));
  assert.equal((await fresh)?.revenue, 200);
  resolvers[0](response(payload({ total_revenue_fy: 100 })));
  assert.equal((await old)?.revenue, 100);
  assert.equal((await source.getFundamentals(INSTRUMENT, CONTEXT))?.revenue, 200);
});

test("one caller's abort does not cancel a shared scanner request", async () => {
  let complete: ((value: Response) => void) | undefined;
  let upstreamSignal: AbortSignal | null | undefined;
  const source = createTradingViewProvider({}, { fetch: async (_url, init) => {
    upstreamSignal = init?.signal;
    return new Promise((resolve) => { complete = resolve; });
  } }).fundamentals!;
  const controller = new AbortController();
  const cancelled = source.getFundamentals(INSTRUMENT, { ...CONTEXT, signal: controller.signal });
  const waiting = source.getProfile(INSTRUMENT, CONTEXT);
  controller.abort();
  await assert.rejects(cancelled, code("aborted"));
  assert.equal(upstreamSignal?.aborted, false);
  complete!(response(payload()));
  assert.ok(await waiting);
});

test("production registration adapters share bounded cache across requests", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(payload({}, "NASDAQ:TVCACHE")); });
  const instrument = { ...INSTRUMENT, symbol: "TVCACHE" };
  const first = tradingViewProviderRegistration.create({}).fundamentals!;
  const second = tradingViewProviderRegistration.create({}).fundamentals!;
  await first.getFundamentals(instrument, CONTEXT);
  await second.getProfile(instrument, CONTEXT);
  assert.equal(calls, 1);
});

test("cache evicts older entries after the fixed symbol limit", async () => {
  let calls = 0;
  const source = createTradingViewProvider({}, { fetch: async (_url, init) => {
    calls++;
    const symbol = JSON.parse(String(init?.body)).symbols.tickers[0];
    return response(payload({}, symbol));
  } }).fundamentals!;
  for (let index = 0; index <= 200; index++) {
    await source.getFundamentals({ ...INSTRUMENT, symbol: `TEST${index}` }, CONTEXT);
  }
  assert.equal(calls, 201);
  await source.getFundamentals({ ...INSTRUMENT, symbol: "TEST200" }, CONTEXT);
  assert.equal(calls, 201);
  await source.getFundamentals({ ...INSTRUMENT, symbol: "TEST0" }, CONTEXT);
  assert.equal(calls, 202);
});

test("in-flight requests have a fixed capacity and recover after completion", async () => {
  const resolvers: (() => void)[] = [];
  const source = createTradingViewProvider({}, { fetch: async (_url, init) => {
    const symbol = JSON.parse(String(init?.body)).symbols.tickers[0];
    return new Promise((resolve) => resolvers.push(() => resolve(response(payload({}, symbol)))));
  } }).fundamentals!;
  const pending = Array.from({ length: 32 }, (_, index) => source.getFundamentals({ ...INSTRUMENT, symbol: `TEST${index}` }, CONTEXT));
  await assert.rejects(source.getFundamentals({ ...INSTRUMENT, symbol: "OVERFLOW" }, CONTEXT), code("capacity"));
  resolvers.forEach((resolve) => resolve());
  await Promise.all(pending);
  const next = source.getFundamentals({ ...INSTRUMENT, symbol: "RECOVERED" }, CONTEXT);
  resolvers.at(-1)!();
  assert.ok(await next);
});
