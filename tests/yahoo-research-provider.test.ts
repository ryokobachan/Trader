import assert from "node:assert/strict";
import test from "node:test";
import { createYahooResearchClient, YahooResearchError } from "../api/yahoo/research.server";
import { yahooProviderRegistration } from "../api/yahoo/index.server";
import type { Instrument } from "../src/app/platform/provider-contracts";

const NOW = new Date("2026-09-05T03:00:00.000Z");
const CONTEXT = { requestId: "yahoo-research-test" };
const AAPL: Instrument = {
  instrumentId: "us:XNAS:AAPL", symbol: "AAPL", name: "Apple", assetType: "common_stock",
  active: true, listingCountry: "US", exchange: "NASDAQ", exchangeMic: "XNAS", currency: "USD",
  provenance: { providerId: "fixture", sourceId: "fixture:AAPL", asOf: NOW.toISOString(), ingestedAt: NOW.toISOString() },
};
const raw = (value: number | null) => ({ raw: value });
function summary(symbol = "AAPL") {
  return {
    payload: { quoteSummary: { error: null, result: [{
      price: { symbol, currency: "USD" },
      defaultKeyStatistics: {
        heldPercentInsiders: raw(0.02), heldPercentInstitutions: raw(0.61), sharesShort: raw(100),
        sharesShortPriorMonth: raw(110), shortPercentOfFloat: raw(0.03), sharesPercentSharesOut: raw(0.025),
        shortRatio: raw(2.5), dateShortInterest: raw(Date.parse("2026-08-14T00:00:00Z") / 1_000),
      },
    }] } },
    sourceUrl: "https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=price,defaultKeyStatistics",
    ingestedAt: NOW.toISOString(),
  };
}
function series(input: { symbol?: string; currency?: string; date?: string; periodType?: string; empty?: boolean } = {}) {
  return { timeseries: { error: null, result: input.empty ? [] : [
    ["quarterlyTotalRevenue", 100], ["quarterlyNetIncome", -20], ["quarterlyDilutedEPS", 0],
    ["quarterlyTotalAssets", 200], ["quarterlyTotalDebt", 50], ["quarterlyStockholdersEquity", 100],
    ["quarterlyOperatingCashFlow", 20], ["quarterlyCapitalExpenditure", -10], ["quarterlyFreeCashFlow", 10],
    ["quarterlyInvestingCashFlow", -15], ["quarterlyFinancingCashFlow", 30],
  ].map(([type, value]) => ({
    meta: { symbol: [input.symbol ?? "AAPL"], type: [type] },
    [type]: [{ asOfDate: input.date ?? "2026-06-27", periodType: input.periodType ?? "3M", currencyCode: input.currency ?? "USD", reportedValue: raw(value as number) }],
  })) } };
}
function chart(input: { symbol?: string; currency?: string; empty?: boolean } = {}) {
  return { chart: { error: null, result: [{
    meta: { symbol: input.symbol ?? "AAPL", currency: input.currency ?? "USD", instrumentType: "EQUITY", exchangeName: "NMS" },
    ...(input.empty ? {} : { events: {
      dividends: {
        recent: { date: Date.parse("2026-08-10T13:30:00Z") / 1_000, amount: 0.26 },
        zero: { date: Date.parse("2026-05-11T13:30:00Z") / 1_000, amount: 0 },
        old: { date: Date.parse("2020-08-10T13:30:00Z") / 1_000, amount: 0.20 },
      },
      splits: { recent: { date: Date.parse("2024-06-10T13:30:00Z") / 1_000, numerator: 4, denominator: 1 } },
    } }),
  }] } };
}
function client(options: Partial<Parameters<typeof createYahooResearchClient>[0]> = {}) {
  return createYahooResearchClient({
    now: () => NOW,
    fetchQuoteSummary: async () => summary(),
    fetchJson: async (url) => url.pathname.includes("timeseries") ? series() : chart(),
    ...options,
  });
}

test("Market data provider financial composition can request ownership/actions without downloading Yahoo statements", async () => {
  const requested: string[] = [];
  const researchClient = client({ fetchJson: async url => { requested.push(url.pathname); return url.pathname.includes("timeseries") ? series() : chart(); } });
  const result = await researchClient.getResearch(AAPL, CONTEXT, { financialStatements: false });
  assert.equal(result.quarterlyFinancials, undefined);
  assert.equal(result.annualCashFlows, undefined);
  assert.equal(result.ownership?.institutionalOwnership, 0.61);
  assert.ok(result.corporateActions.length);
  assert.ok(requested.every(path => !path.includes("timeseries")));
  const full = await researchClient.getResearch(AAPL, CONTEXT);
  assert.ok(full.quarterlyFinancials?.length, "cache must distinguish the requested scope");
  assert.ok(requested.some(path => path.includes("timeseries")));
});

test("adds fractional ownership and short interest without claiming the ownership date is the short date", async () => {
  const research = await client().getResearch(AAPL, CONTEXT);
  assert.deepEqual(research.coverage, { ownership: "available", quarterlyFinancials: "available", corporateActions: "available" });
  assert.equal(research.ownership!.insiderOwnership, 0.02);
  assert.equal(research.ownership!.institutionalOwnership, 0.61);
  assert.equal(research.ownership!.shortFloatRatio, 0.03);
  assert.equal(research.ownership!.shortOutstandingRatio, 0.025);
  assert.equal(research.ownership!.shortRatio, 2.5);
  assert.equal(research.ownership!.sharesShort, 100);
  assert.equal(research.ownership!.shortInterestDate, "2026-08-14");
  assert.equal(research.ownership!.provenance.asOf, NOW.toISOString());
});

test("joins quarterly fields only by the source date, preserving true zero and all three cash flows", async () => {
  const research = await client().getResearch(AAPL, CONTEXT);
  const financial = research.quarterlyFinancials![0];
  assert.equal(financial.fiscalDateEnding, "2026-06-27");
  assert.equal(financial.period, "2026-06-27", "A calendar quarter must not be relabelled as Apple's fiscal quarter");
  assert.equal(financial.revenue, 100);
  assert.equal(financial.netIncome, -20);
  assert.equal(financial.eps, 0);
  assert.equal(financial.capitalExpenditure, -10);
  assert.equal(financial.freeCashFlow, 10);
  assert.equal(financial.operatingCashFlow, 20);
  assert.equal(financial.investingCashFlow, -15);
  assert.equal(financial.financingCashFlow, 30);
  assert.equal(financial.currency, "USD");
  assert.equal(financial.provenance.asOf, "2026-06-27");
});

test("annual cash flows retain their annual period and do not overwrite quarterly values on the same date", async () => {
  const payload = series({ date: "2025-12-31" });
  for (const [type, value] of [["annualOperatingCashFlow", 384800000], ["annualInvestingCashFlow", -4229300000], ["annualFinancingCashFlow", 5125500000], ["annualFreeCashFlow", -3681200000]] as const) {
    payload.timeseries.result.push({ meta: { symbol: ["AAPL"], type: [type] }, [type]: [{ asOfDate: "2025-12-31", periodType: "12M", currencyCode: "USD", reportedValue: raw(value) }] });
  }
  const research = await client({ fetchJson: async url => url.pathname.includes("timeseries") ? payload : chart() }).getResearch(AAPL, CONTEXT);
  assert.equal(research.quarterlyFinancials?.[0].operatingCashFlow, 20);
  assert.equal(research.annualCashFlows?.[0].operatingCashFlow, 384800000);
  assert.equal(research.annualCashFlows?.[0].investingCashFlow, -4229300000);
  assert.equal(research.annualCashFlows?.[0].financingCashFlow, 5125500000);
  assert.equal(research.annualCashFlows?.[0].provenance.sourceId, "yahoo-research:AAPL:annual:2025-12-31");
});

test("future reporting periods are never accepted as historical actuals", async () => {
  const payload = series({ date: "2027-12-31" });
  payload.timeseries.result.push({ meta: { symbol: ["AAPL"], type: ["annualOperatingCashFlow"] }, annualOperatingCashFlow: [{ asOfDate: "2027-12-31", periodType: "12M", currencyCode: "USD", reportedValue: raw(100) }] });
  const research = await client({ fetchJson: async url => url.pathname.includes("timeseries") ? payload : chart() }).getResearch(AAPL, CONTEXT);
  assert.deepEqual(research.quarterlyFinancials, []);
  assert.deepEqual(research.annualCashFlows, []);
});

test("extracts five years of dividend and split source dates and excludes older events", async () => {
  const research = await client().getResearch(AAPL, CONTEXT);
  assert.equal(research.corporateActions.length, 3);
  assert.deepEqual(research.corporateActions.map(({ type, date }) => ({ type, date })), [
    { type: "dividend", date: "2026-08-10" }, { type: "dividend", date: "2026-05-11" }, { type: "split", date: "2024-06-10" },
  ]);
  assert.equal(research.corporateActions[0].amount, 0.26);
  assert.equal(research.corporateActions[1].amount, 0);
  assert.equal(research.corporateActions[2].numerator, 4);
  assert.equal(research.corporateActions[2].denominator, 1);
});

test("keeps valid empty datasets distinct from upstream errors", async () => {
  const empty = await client({ fetchJson: async (url) => url.pathname.includes("timeseries") ? series({ empty: true }) : chart({ empty: true }) }).getResearch(AAPL, CONTEXT);
  assert.deepEqual(empty.quarterlyFinancials, []);
  assert.deepEqual(empty.corporateActions, []);
  assert.equal(empty.coverage.quarterlyFinancials, "available");
  assert.equal(empty.coverage.corporateActions, "available");
  const partial = await client({ fetchQuoteSummary: async () => { throw new Error("outage"); }, fetchJson: async (url) => {
    if (url.pathname.includes("timeseries")) return series();
    throw new Error("outage");
  } }).getResearch(AAPL, CONTEXT);
  assert.equal(partial.coverage.ownership, "unavailable");
  assert.equal(partial.ownership, undefined);
  assert.equal(partial.coverage.corporateActions, "unavailable");
  assert.equal(partial.coverage.quarterlyFinancials, "available");
});

test("uses separately labelled public-site ownership only when Yahoo fails or has no measurements", async () => {
  let fallbacks = 0;
  const fallback = async () => {
    fallbacks += 1;
    return { insiderOwnership: 0.15, provenance: { providerId: "stockanalysis", sourceId: "stockanalysis:AAPL:ownership", sourceUrl: "https://stockanalysis.com/stocks/aapl/statistics/", asOf: NOW.toISOString(), ingestedAt: NOW.toISOString() } };
  };
  const complete = await client({ fetchOwnershipFallback: fallback }).getResearch(AAPL, CONTEXT);
  assert.equal(complete.ownership!.provenance.providerId, "yahoo");
  assert.equal(fallbacks, 0);
  const failed = await client({ fetchQuoteSummary: async () => { throw new Error("429"); }, fetchOwnershipFallback: fallback }).getResearch(AAPL, CONTEXT);
  assert.equal(failed.coverage.ownership, "available");
  assert.equal(failed.ownership!.provenance.providerId, "stockanalysis");
  assert.equal(fallbacks, 1);
  const noValues = summary();
  noValues.payload.quoteSummary.result[0].defaultKeyStatistics = {} as typeof noValues.payload.quoteSummary.result[0]["defaultKeyStatistics"];
  const empty = await client({ fetchQuoteSummary: async () => noValues, fetchOwnershipFallback: fallback }).getResearch(AAPL, CONTEXT);
  assert.equal(empty.ownership!.insiderOwnership, 0.15);
  assert.equal(fallbacks, 2);
});

test("rejects wrong-symbol source data and excludes non-USD or non-quarterly statements", async () => {
  const wrong = await client({ fetchQuoteSummary: async () => summary("MU"), fetchJson: async (url) => url.pathname.includes("timeseries") ? series({ symbol: "MU" }) : chart({ symbol: "MU" }) }).getResearch(AAPL, CONTEXT);
  assert.deepEqual(wrong.coverage, { ownership: "unavailable", quarterlyFinancials: "unavailable", corporateActions: "unavailable" });
  for (const input of [{ currency: "EUR" }, { periodType: "12M" }, { date: "2026-02-31" }]) {
    const filtered = await client({ fetchJson: async (url) => url.pathname.includes("timeseries") ? series(input) : chart() }).getResearch(AAPL, CONTEXT);
    assert.deepEqual(filtered.quarterlyFinancials, []);
  }
});

test("deduplicates, preserves production cache across clients, and honors fresh/expiry", async () => {
  const cacheScope = {};
  let calls = 0;
  let time = NOW.getTime();
  const options = { cacheScope, now: () => new Date(time), cacheTtlMs: 100, fetchQuoteSummary: async () => { calls += 1; return summary(); } };
  const first = client(options);
  await Promise.all([first.getResearch(AAPL, CONTEXT), first.getResearch(AAPL, CONTEXT)]);
  assert.equal(calls, 1);
  await client(options).getResearch(AAPL, CONTEXT);
  assert.equal(calls, 1);
  await client(options).getResearch(AAPL, { ...CONTEXT, fresh: true });
  assert.equal(calls, 2);
  time += 101;
  await first.getResearch(AAPL, CONTEXT);
  assert.equal(calls, 3);
});

test("times out individual sources, still returns the others, and supports independent caller cancellation", async () => {
  const partial = await client({ timeoutMs: 5, fetchQuoteSummary: () => new Promise(() => undefined) }).getResearch(AAPL, CONTEXT);
  assert.equal(partial.coverage.ownership, "unavailable");
  assert.equal(partial.coverage.quarterlyFinancials, "available");
  let resolveSummary!: (value: ReturnType<typeof summary>) => void;
  const shared = client({ fetchQuoteSummary: () => new Promise((resolve) => { resolveSummary = resolve; }) });
  const controller = new AbortController();
  const abandoned = shared.getResearch(AAPL, { ...CONTEXT, signal: controller.signal });
  const remaining = shared.getResearch(AAPL, CONTEXT);
  controller.abort();
  await assert.rejects(abandoned, (error: unknown) => error instanceof YahooResearchError && error.code === "aborted");
  resolveSummary(summary());
  assert.equal((await remaining).coverage.ownership, "available");
});

test("limits requests to expected quarterly, annual cash-flow and five-year events endpoints", async () => {
  const urls: URL[] = [];
  await client({ fetchJson: async (url) => {
    urls.push(url);
    return url.pathname.includes("timeseries") ? series() : chart();
  } }).getResearch(AAPL, CONTEXT);
  assert.equal(urls.length, 2);
  const timeseries = urls.find((url) => url.pathname.includes("timeseries"))!;
  assert.equal(timeseries.origin, "https://query2.finance.yahoo.com");
  assert.equal(timeseries.searchParams.get("type")!.split(",").length, 16);
  assert.equal(timeseries.searchParams.get("symbol"), "AAPL");
  const events = urls.find((url) => url.pathname.includes("chart"))!;
  assert.equal(events.origin, "https://query1.finance.yahoo.com");
  assert.equal(events.searchParams.get("range"), "5y");
  assert.equal(events.searchParams.get("events"), "div,splits");
});

test("Yahoo profile and research reuse one anonymous quote-summary request", async () => {
  const original = globalThis.fetch;
  let summaryCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "fc.yahoo.com") return new Response("", { headers: { "set-cookie": "A3=guest; Path=/; Secure; HttpOnly" } });
    if (url.pathname.includes("getcrumb")) return new Response("public-guest-crumb");
    if (url.pathname.includes("quoteSummary")) { summaryCalls += 1; return Response.json(summary().payload); }
    return Response.json(url.pathname.includes("timeseries") ? series() : chart());
  };
  try {
    const provider = yahooProviderRegistration.create({ TRADER_USAGE_MODE: "personal", TRADER_ENABLE_YAHOO_COMPAT: "true" });
    assert.ok(provider.manifest.capabilities.includes("fundamentals.research"));
    const [, research] = await Promise.all([
      provider.fundamentals!.getProfile(AAPL, CONTEXT),
      provider.fundamentals!.getResearch!(AAPL, CONTEXT),
    ]);
    assert.equal(summaryCalls, 1);
    assert.equal(research!.coverage.ownership, "available");
    assert.doesNotMatch(JSON.stringify(research), /public-guest-crumb|A3=guest/);
  } finally { globalThis.fetch = original; }
});
