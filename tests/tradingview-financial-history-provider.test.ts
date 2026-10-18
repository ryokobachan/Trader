import assert from "node:assert/strict";
import test from "node:test";
import { createTradingViewFinancialHistoryClient, parseTradingViewFinancialHistory } from "../api/tradingview/financial-history.server";
import type { Instrument } from "../src/app/platform/provider-contracts";

const NOW = new Date("2026-09-06T06:00:00Z");
const AAPL: Instrument = { instrumentId: "us:XNAS:AAPL", symbol: "AAPL", name: "Apple", listingCountry: "US", currency: "USD", active: true,
  assetType: "common_stock", exchange: "NASDAQ", exchangeMic: "XNAS", provenance: { providerId: "test", sourceId: "test", asOf: NOW.toISOString(), ingestedAt: NOW.toISOString() } };
const CONTEXT = { requestId: "financial-history-test" };
const ENV = { TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:9876", TRADER_TRADINGVIEW_SIDECAR_TOKEN: "local-test-token" };
const epoch = (date: string) => Date.parse(date) / 1000;
function payload(extra: Record<string, unknown> = {}) {
  return { schemaVersion: "trader.tradingview-financials.v1", sourceSymbol: "NASDAQ:AAPL", observedAt: NOW.toISOString(), values: {
    currency_code: "USD", fundamental_currency_code: "USD", fiscal_period_fy_h: ["2025", "2024"],
    total_revenue_fy_h: [1000, 900], cash_f_operating_activities_fy_h: [100, 90],
    cash_f_investing_activities_fy_h: [-50, -40], cash_f_financing_activities_fy_h: [-20, 0],
    fiscal_period_fq_h: ["2026-Q3", "2026-Q2", "2026-Q1"], fiscal_period_end_fq_h: [epoch("2026-06-30"), epoch("2026-03-31"), epoch("2025-12-31")],
    total_revenue_fq_h: [300, 200, 100], net_income_fq_h: [30, -20, null],
    earnings_per_share_diluted_fq_h: [1.5, -1, 0], cash_f_operating_activities_fq_h: [30, 20, 10],
    cash_f_investing_activities_fq_h: [-20, null, 0], cash_f_financing_activities_fq_h: [-10, 0, 10],
    earnings_fiscal_period_fq_h: ["2026-Q3", "2026-Q2"], earnings_release_date_fq_h: [epoch("2026-07-30"), epoch("2026-04-30")],
    earnings_per_share_fq_h: [2, -0.5], earnings_per_share_forecast_fq_h: [1.8, 0],
    revenue_fq_h: [300, 200], revenue_forecast_fq_h: [290, 195], ...extra,
  } };
}

test("Market data provider history keeps complete statement categories with source quarter labels, dates, signs and null gaps", () => {
  const result = parseTradingViewFinancialHistory(payload(), "NASDAQ:AAPL", NOW);
  assert.equal(result.annual.length, 2);
  assert.equal(result.quarterly.length, 3);
  assert.equal(result.annual[0].operatingCashFlow, 100);
  assert.equal(result.annual[0].investingCashFlow, -50);
  assert.equal(result.annual[1].financingCashFlow, 0);
  assert.equal(result.quarterly[0].fiscalDateEnding, "2026-06-30");
  assert.equal(result.quarterly[0].period, "2026-Q3");
  assert.equal(result.quarterly[1].netIncome, -20);
  assert.equal(result.quarterly[1].investingCashFlow, undefined);
  assert.equal(result.quarterly[2].investingCashFlow, 0);
  assert.equal(result.quarterly[0].provenance.providerId, "tradingview");
});

test("dated earnings align on their own equal-length fiscal axis and join statement EPS by fiscal label", () => {
  const result = parseTradingViewFinancialHistory(payload(), "NASDAQ:AAPL", NOW);
  assert.equal(result.earnings.length, 2, "earnings axis need not be as long as the statement axis");
  assert.equal(result.earnings[0].reportDate, "2026-07-30");
  assert.equal(result.earnings[0].fiscalPeriod, "2026-Q3");
  assert.equal(result.earnings[0].epsActual, 2);
  assert.equal(result.earnings[0].statementEPS, 1.5, "adjusted display EPS must not replace diluted statement EPS");
  assert.equal(result.earnings[1].epsEstimate, 0);
});

test("mismatched and absent histories never shift, impute or synthesize dates", () => {
  const result = parseTradingViewFinancialHistory(payload({
    total_assets_fq_h: [1000, 900], earnings_per_share_forecast_fq_h: [1.8], earnings_release_date_fq_h: [epoch("2026-07-30")],
    fiscal_period_end_fq_h: [epoch("2026-06-30")],
  }), "NASDAQ:AAPL", NOW);
  assert.ok(result.quarterly.every(item => item.totalAssets === undefined && item.fiscalDateEnding === undefined));
  assert.deepEqual(result.earnings, []);
  const undated = parseTradingViewFinancialHistory(payload({ earnings_release_date_fq_h: [null, epoch("2026-04-30")] }), "NASDAQ:AAPL", NOW);
  assert.equal(undated.earnings[0].fiscalPeriod, "2026-Q2");
});

test("foreign currencies, wrong listings, stale response timestamps and future reports are rejected", () => {
  assert.throws(() => parseTradingViewFinancialHistory(payload(), "NYSE:AAPL", NOW));
  assert.throws(() => parseTradingViewFinancialHistory(payload({ fundamental_currency_code: "EUR" }), "NASDAQ:AAPL", NOW));
  assert.throws(() => parseTradingViewFinancialHistory({ ...payload(), observedAt: "2025-01-01" }, "NASDAQ:AAPL", NOW));
  assert.equal(parseTradingViewFinancialHistory(payload({ earnings_release_date_fq_h: [epoch("2027-07-30"), epoch("2026-03-01")] }), "NASDAQ:AAPL", NOW).earnings.length, 0);
});

test("authenticated one-shot client caches and coalesces requests, refreshes explicitly, and never requests an unrelated source", async () => {
  let calls = 0;
  const client = createTradingViewFinancialHistoryClient(ENV, { now: () => NOW, fetch: async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1:9876");
    assert.equal(url.pathname, "/v1/tradingview/financials");
    assert.equal(url.searchParams.get("symbol"), "AAPL");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer local-test-token");
    assert.equal(init?.redirect, "manual");
    return new Response(JSON.stringify(payload()));
  } });
  await Promise.all([client.get(AAPL, CONTEXT), client.get(AAPL, CONTEXT)]);
  await client.get(AAPL, CONTEXT);
  assert.equal(calls, 1);
  await client.get(AAPL, { ...CONTEXT, fresh: true });
  assert.equal(calls, 2);
  assert.equal(await client.get({ ...AAPL, currency: "EUR" } as unknown as Instrument, CONTEXT), undefined);
  const unconfigured = createTradingViewFinancialHistoryClient({}, { fetch: async () => { throw new Error("must not fetch"); } });
  assert.equal(await unconfigured.get(AAPL, CONTEXT), undefined);
});

test("history failures and pre-cancelled requests remain explicit without alternative providers", async () => {
  const client = createTradingViewFinancialHistoryClient(ENV, { fetch: async () => new Response("failure", { status: 503 }) });
  await assert.rejects(client.get(AAPL, CONTEXT));
  await assert.rejects(client.get(AAPL, { ...CONTEXT, signal: AbortSignal.abort() }));
});

test("financial client deadline covers both ignored fetch cancellation and a stalled response body", async () => {
  for (const fetcher of [async () => new Promise<Response>(() => undefined), async () => new Response(new ReadableStream({ start() {} }))]) {
    const client = createTradingViewFinancialHistoryClient(ENV, { fetch: fetcher, timeoutMs: 5 });
    await assert.rejects(client.get(AAPL, CONTEXT), /timed out/);
  }
});
