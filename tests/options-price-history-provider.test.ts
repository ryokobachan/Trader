import assert from "node:assert/strict";
import test from "node:test";
import { createOptionPriceHistoryClient, OptionPriceHistoryError, optionPriceHistoryIdentity, parseYahooOptionPriceHistory } from "../api/options/price-history.server";
import { GET } from "../src/app/api/v1/symbols/[symbol]/options/prices/route";
import { createOptionsPriceHistoryRoute } from "../api/options/price-history-route.server";
import type { OptionsPriceHistory } from "../api/options/price-history.server";

const NOW = "2026-09-05T10:00:00.000Z";
const REQUEST = { symbol: "NBIS", contractId: "NBIS260911C00230000" };
const stamp = (value: string) => Date.parse(value) / 1_000;
const times = [stamp("2026-09-03T04:00:00Z"), stamp("2026-09-04T04:00:00Z")];
function payload(timestamps = times) {
  return { chart: { error: null, result: [{
    meta: { symbol: REQUEST.contractId, instrumentType: "OPTION", currency: "USD", exchangeTimezoneName: "America/New_York", dataGranularity: "1d", regularMarketTime: stamp("2026-09-04T19:59:43Z"), regularMarketPrice: 8.4 },
    timestamp: timestamps,
    indicators: {
      quote: [{ open: timestamps.map(() => 2), high: timestamps.map(() => 4), low: timestamps.map(() => 1), close: timestamps.map(() => 3), volume: timestamps.map(() => 10) }],
      adjclose: [{ adjclose: timestamps.map(() => 99) }],
    },
  }] } };
}
const hasCode = (code: string) => (error: unknown) => error instanceof OptionPriceHistoryError && error.code === code;

test("option history validates the exact underlying, expiration and OCC strike suffix", () => {
  assert.deepEqual(optionPriceHistoryIdentity({ symbol: " nbis ", contractId: " nbis260911c00230000 " }), { ...REQUEST, expiration: "2026-09-11", side: "call", strike: 230 });
  assert.equal(optionPriceHistoryIdentity({ symbol: "MU", contractId: "MU260909P00915000" }).side, "put");
  for (const contractId of ["MU260911C00230000", "NBISX260911C00230000", "NBIS260231C00230000", "NBIS260911C00000000", "NBIS260911C0023000", "NBIS260911C002300000", "NBIS260911X00230000", "NBIS260911C00230000?x=1", "../NBIS260911C00230000"]) {
    assert.throws(() => optionPriceHistoryIdentity({ symbol: "NBIS", contractId }), hasCode("invalid_request"));
  }
});

test("Yahoo OHLC values remain source quotes with separate trade and retrieval times and no stock-price or OI fields", () => {
  const result = parseYahooOptionPriceHistory(payload(), REQUEST, NOW);
  assert.equal(result.source, "Yahoo Finance");
  assert.equal(result.fetchedAt, NOW);
  assert.equal(result.sourceAsOf, "2026-09-04T19:59:43.000Z");
  assert.equal(result.latestOptionPrice, 8.4);
  assert.deepEqual(result.underlying, { symbol: "NBIS" });
  assert.equal(result.items[0].close, 3);
  assert.equal(result.items[0].time, times[0]);
  assert.equal(result.items[0].date, "2026-09-03");
  assert.equal(result.priceAdjustment, "source_ohlc");
  assert.equal(result.adjustedCloseUsed, false);
  assert.equal(result.requestedRange, "1y");
  assert.equal(result.interval, "1d");
  assert.equal(result.sourceUrl, "https://finance.yahoo.com/quote/NBIS260911C00230000/history/");
  assert.doesNotMatch(JSON.stringify(result), /openInterest|underlyingPrice|"close":99/);
});

test("empty source dates and partial bars are retained as gaps and quoted volume zero is preserved", () => {
  const source = payload([stamp("2026-09-01T04:00:00Z"), stamp("2026-09-02T04:00:00Z"), ...times]);
  const quote = source.chart.result[0].indicators.quote[0] as Record<string, Array<number | null>>;
  for (const values of Object.values(quote)) values[1] = null;
  quote.volume[0] = 0;
  quote.high[2] = null;
  quote.open[2] = null;
  const result = parseYahooOptionPriceHistory(source, REQUEST, NOW);
  assert.equal(result.items.length, 4);
  assert.equal(result.items[0].volume, 0);
  assert.deepEqual(result.items[1], { date: "2026-09-02", time: stamp("2026-09-02T04:00:00Z") });
  assert.equal(result.items[2].open, undefined);
  assert.equal(result.items[2].close, 3);
  assert.equal(result.coverage.missingBars, 1);
  assert.equal(result.coverage.observedBars, 3);
  assert.equal(result.coverage.returnedBars, 4);
  assert.equal(result.coverage.firstDate, "2026-09-01");
  assert.equal(result.coverage.lastDate, "2026-09-04");
});

test("session dates follow the supplied IANA exchange timezone, including DST and UTC date boundaries", () => {
  const acrossUtcDay = parseYahooOptionPriceHistory(payload([stamp("2026-09-04T01:00:00Z"), stamp("2026-09-04T20:00:00Z")]), REQUEST, NOW);
  assert.deepEqual(acrossUtcDay.items.map(item => item.date), ["2026-09-03", "2026-09-04"]);
  const daylight = parseYahooOptionPriceHistory(payload([stamp("2026-03-06T05:00:00Z"), stamp("2026-03-09T04:00:00Z")]), REQUEST, NOW);
  assert.deepEqual(daylight.items.map(item => item.date), ["2026-03-06", "2026-03-09"]);
});

test("one-year coverage is enforced and missing source timestamps are never inferred", () => {
  const source = payload([stamp("2025-09-04T04:00:00Z"), stamp("2025-09-05T04:00:00Z"), ...times]);
  const result = parseYahooOptionPriceHistory(source, REQUEST, NOW);
  assert.equal(result.items.length, 3);
  assert.equal(result.coverage.from, "2025-09-05");
  assert.equal(result.coverage.to, "2026-09-05");
  assert.equal(result.coverage.firstDate, "2025-09-05");
  const noQuoteTime = payload();
  delete (noQuoteTime.chart.result[0].meta as Partial<typeof noQuoteTime.chart.result[0]["meta"]>).regularMarketTime;
  assert.equal(parseYahooOptionPriceHistory(noQuoteTime, REQUEST, NOW).sourceAsOf, null);
  assert.throws(() => parseYahooOptionPriceHistory(payload(Array.from({ length: 401 }, (_, i) => times[0] - (400 - i) * 86_400)), REQUEST, NOW), hasCode("invalid_response"));
  const empty = parseYahooOptionPriceHistory(payload([]), REQUEST, NOW);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.coverage.firstDate, null);
});

test("wrong instruments, inconsistent arrays, unsorted or repeated sessions and invalid OHLCV are rejected", () => {
  for (const update of [
    { symbol: "AAPL260911C00230000" }, { instrumentType: "EQUITY" }, { currency: "EUR" }, { dataGranularity: "1h" }, { exchangeTimezoneName: "Mars/Olympus" },
  ]) {
    const source = payload(); Object.assign(source.chart.result[0].meta, update);
    assert.throws(() => parseYahooOptionPriceHistory(source, REQUEST, NOW), hasCode("invalid_response"));
  }
  for (const timestamps of [[times[1], times[0]], [times[0], times[0]], [times[0], times[0] + 60], [times[0], stamp("2027-01-01T05:00:00Z")]]) {
    assert.throws(() => parseYahooOptionPriceHistory(payload(timestamps), REQUEST, NOW), hasCode("invalid_response"));
  }
  for (const [field, value] of [["open", -1], ["close", Infinity], ["low", NaN], ["high", 0.5], ["volume", 1.2], ["volume", -1]] as const) {
    const source = payload(); source.chart.result[0].indicators.quote[0][field][0] = value;
    assert.throws(() => parseYahooOptionPriceHistory(source, REQUEST, NOW), hasCode("invalid_response"));
  }
  const shortArray = payload(); shortArray.chart.result[0].indicators.quote[0].volume.pop();
  assert.throws(() => parseYahooOptionPriceHistory(shortArray, REQUEST, NOW), hasCode("invalid_response"));
  assert.throws(() => parseYahooOptionPriceHistory(payload([stamp("2026-09-12T04:00:00Z")]), REQUEST, "2026-09-15T10:00:00Z"), hasCode("invalid_response"));
});

test("history requests deduplicate and cache for five minutes with a bounded query2 fallback", async () => {
  const urls: string[] = [];
  let at = Date.parse(NOW);
  const client = createOptionPriceHistoryClient({ now: () => new Date(at), fetch: async input => {
    urls.push(String(input));
    return String(input).includes("query1") ? new Response("upstream unavailable", { status: 503 }) : Response.json(payload());
  } });
  const [a, b] = await Promise.all([client.getHistory(REQUEST), client.getHistory(REQUEST)]);
  assert.equal(a, b); assert.equal(await client.getHistory(REQUEST), a);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /query1.*range=1y&interval=1d&includePrePost=false/);
  assert.match(urls[1], /query2/);
  at += 300_001;
  await client.getHistory(REQUEST);
  assert.equal(urls.length, 4);
});

test("rate limits, access restrictions, invalid data and missing contracts never trigger alternate-host retries", async () => {
  for (const status of [401, 403, 404, 429]) {
    let requests = 0;
    const client = createOptionPriceHistoryClient({ now: () => new Date(NOW), fetch: async () => { requests++; return new Response("unavailable", { status }); } });
    await assert.rejects(client.getHistory(REQUEST), hasCode(status === 404 ? "not_found" : "unavailable"));
    await assert.rejects(client.getHistory(REQUEST), OptionPriceHistoryError);
    assert.equal(requests, 1);
  }
  let requests = 0;
  const wrong = payload(); wrong.chart.result[0].meta.symbol = "MU260909C00915000";
  const client = createOptionPriceHistoryClient({ fetch: async () => { requests++; return Response.json(wrong); } });
  await assert.rejects(client.getHistory(REQUEST), hasCode("invalid_response"));
  assert.equal(requests, 1);
  assert.throws(() => parseYahooOptionPriceHistory({ chart: { result: null, error: { code: "Not Found" } } }, REQUEST, NOW), hasCode("not_found"));
});

test("the shared ten-second deadline and two-megabyte response bounds apply across fallback requests", async () => {
  const signals: AbortSignal[] = [];
  const client = createOptionPriceHistoryClient({ timeoutMs: 5, fetch: async (input, init) => {
    signals.push(init!.signal!);
    if (String(input).includes("query1")) return new Response("unavailable", { status: 503 });
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  } });
  await assert.rejects(client.getHistory(REQUEST), hasCode("timeout"));
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  for (const response of [new Response("{}", { headers: { "content-length": "2000001" } }), new Response(new Uint8Array(2_000_001))]) {
    const bounded = createOptionPriceHistoryClient({ fetch: async () => response });
    await assert.rejects(bounded.getHistory(REQUEST), hasCode("invalid_response"));
  }
});

test("only eight distinct contract requests can be in flight", async () => {
  const releases: Array<() => void> = [];
  const client = createOptionPriceHistoryClient({ now: () => new Date(NOW), fetch: async input => new Promise(resolve => {
    const contractId = new URL(String(input)).pathname.split("/").at(-1)!;
    releases.push(() => { const source = payload(); source.chart.result[0].meta.symbol = contractId; resolve(Response.json(source)); });
  }) });
  const pending = Array.from({ length: 8 }, (_, index) => client.getHistory({ symbol: "NBIS", contractId: `NBIS260911C00${230 + index}000` }));
  await assert.rejects(client.getHistory({ symbol: "NBIS", contractId: "NBIS260911C00250000" }), hasCode("capacity"));
  assert.equal(releases.length, 8);
  releases.forEach(release => release());
  assert.equal((await Promise.all(pending)).length, 8);
});

test("history routes reject missing, repeated, mismatched and unsupported parameters before contacting any provider", async () => {
  for (const query of ["", "?contractId=MU260909C00915000", `?contractId=${REQUEST.contractId}&contractId=${REQUEST.contractId}`, `?contractId=${REQUEST.contractId}&range=5y`, `?contractId=${REQUEST.contractId}&source=unknown`, `?contractId=${REQUEST.contractId}&source=`, `?contractId=${REQUEST.contractId}&source=yahoo&source=chartexchange`]) {
    const response = await GET(new Request(`http://localhost/api/options/prices${query}`), { params: Promise.resolve({ symbol: "NBIS" }) });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_request");
  }
});

test("the HTTP default selects ChartExchange and preserves date-only OI provenance; Yahoo remains an explicit alternative", async () => {
  const calls: string[] = [];
  const yahoo = parseYahooOptionPriceHistory(payload(), REQUEST, NOW);
  const chartExchange = { ...yahoo, source: "ChartExchange" as const, sourceUrl: "https://chartexchange.com/symbol/opra-nbis20260911c230/historical/",
    sourceAsOf: null, requestedRange: "available" as const, openInterestDateBasis: "source_session_date_unverified" as const,
    items: [{ date: "2026-09-03", close: 3.15, volume: 2022, openInterest: 2296 }],
  };
  const get = createOptionsPriceHistoryRoute({
    chartexchange: { getHistory: async request => { assert.equal(request.contractId, REQUEST.contractId); calls.push("chartexchange"); return chartExchange; } },
    yahoo: { getHistory: async () => { calls.push("yahoo"); return yahoo; } },
  });
  const context = { params: Promise.resolve({ symbol: "NBIS" }) };
  const first = await get(new Request(`http://localhost/api/options/prices?contractId=${REQUEST.contractId}`), context);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  const value = await first.json() as OptionsPriceHistory;
  assert.equal(value.source, "ChartExchange");
  assert.equal(value.items[0].openInterest, 2296);
  assert.equal(value.items[0].time, undefined);
  assert.equal(value.sourceAsOf, null);
  assert.equal(value.openInterestDateBasis, "source_session_date_unverified");
  const alternative = await get(new Request(`http://localhost/api/options/prices?contractId=${REQUEST.contractId}&source=yahoo`), context);
  assert.deepEqual(await alternative.json(), yahoo);
  assert.deepEqual(calls, ["chartexchange", "yahoo"]);
});

test("a failing selected history source never substitutes another feed or exposes upstream messages", async () => {
  for (const failure of [new OptionPriceHistoryError("not_found"), new Error("upstream body with private credentials")]) {
    let yahooCalls = 0;
    const get = createOptionsPriceHistoryRoute({
      chartexchange: { getHistory: async () => { throw failure; } },
      yahoo: { getHistory: async () => { yahooCalls++; return parseYahooOptionPriceHistory(payload(), REQUEST, NOW); } },
    });
    const response = await get(new Request(`http://localhost/api/options/prices?contractId=${REQUEST.contractId}`), { params: Promise.resolve({ symbol: "NBIS" }) });
    assert.equal(response.status, failure instanceof OptionPriceHistoryError ? 404 : 502);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.doesNotMatch(await response.text(), /credentials|upstream body/);
    assert.equal(yahooCalls, 0);
  }
});

function chartExchangeRouteFixture(): OptionsPriceHistory {
  return {
    ...parseYahooOptionPriceHistory(payload(), REQUEST, NOW), source: "ChartExchange",
    sourceUrl: "https://chartexchange.com/symbol/opra-nbis20260911c230/historical/",
    sourceAsOf: null, requestedRange: "available", openInterestDateBasis: "source_session_date_unverified",
    items: [
      { date: "2026-09-01", close: 2, volume: 10, openInterest: 900 },
      { date: "2026-09-02" },
      { date: "2026-09-03", openInterest: 0 },
      { date: "2026-09-04", close: 3.15, volume: 2022, openInterest: 2296 },
    ],
    coverage: { from: "2026-09-01", to: "2026-09-05", firstDate: "2026-09-01", lastDate: "2026-09-04", missingBars: 1, sourceRows: 4, returnedBars: 4, observedBars: 3 },
  };
}

test("inclusive date filters preserve original coverage and count OI-only zero observations without filling gaps", async () => {
  const original = chartExchangeRouteFixture();
  const before = JSON.stringify(original);
  let calls = 0;
  const get = createOptionsPriceHistoryRoute({
    chartexchange: { getHistory: async request => { calls++; assert.deepEqual(request, optionPriceHistoryIdentity(REQUEST)); return original; } },
    yahoo: { getHistory: async () => { throw new Error("must not use another source"); } },
  });
  const response = await get(new Request(`http://localhost/api/options/prices?contractId=${REQUEST.contractId}&from=2026-09-02&to=2026-09-03`), { params: Promise.resolve({ symbol: "NBIS" }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const result = await response.json() as OptionsPriceHistory;
  assert.deepEqual(result.items, [{ date: "2026-09-02" }, { date: "2026-09-03", openInterest: 0 }]);
  assert.deepEqual(result.requestWindow, { from: "2026-09-02", to: "2026-09-03" });
  assert.deepEqual(result.filteredCoverage, { firstDate: "2026-09-02", lastDate: "2026-09-03", returnedBars: 2, observedBars: 1, missingBars: 1 });
  assert.deepEqual(result.coverage, original.coverage);
  assert.equal(result.sourceUrl, original.sourceUrl);
  assert.equal(result.sourceAsOf, null);
  assert.equal(result.fetchedAt, NOW);
  assert.equal(result.openInterestDateBasis, "source_session_date_unverified");
  assert.ok(result.items.every(item => !Object.hasOwn(item, "time")));
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(original), before, "filtering cannot mutate a cached full response");
});

test("one-sided and equal-date windows are inclusive; an empty selection is a successful empty history", async () => {
  const original = chartExchangeRouteFixture();
  const client = { getHistory: async () => original };
  const get = createOptionsPriceHistoryRoute({ chartexchange: client, yahoo: { getHistory: async () => { throw new Error("unexpected source"); } } });
  for (const [query, dates, observed, missing] of [
    ["from=2026-09-03", ["2026-09-03", "2026-09-04"], 2, 0],
    ["to=2026-09-02", ["2026-09-01", "2026-09-02"], 1, 1],
    ["from=2026-09-03&to=2026-09-03", ["2026-09-03"], 1, 0],
    ["from=2026-09-05&to=2026-09-10", [], 0, 0],
  ] as const) {
    const response = await get(new Request(`http://localhost/api/options/prices?contractId=${REQUEST.contractId}&${query}`), { params: Promise.resolve({ symbol: "NBIS" }) });
    assert.equal(response.status, 200, query);
    const result = await response.json() as OptionsPriceHistory;
    assert.deepEqual(result.items.map(item => item.date), dates, query);
    assert.deepEqual(result.filteredCoverage, { firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null, returnedBars: dates.length, observedBars: observed, missingBars: missing }, query);
    assert.deepEqual(result.coverage, original.coverage);
    assert.deepEqual(result.requestWindow, Object.fromEntries(new URLSearchParams(query)));
  }
  const unfiltered = await get(new Request(`http://localhost/api/options/prices?contractId=${REQUEST.contractId}`), { params: Promise.resolve({ symbol: "NBIS" }) });
  assert.deepEqual(await unfiltered.json(), original, "no date bounds must keep the original response without filter metadata");
});

test("invalid, duplicate and reversed date windows fail before a source request", async () => {
  let calls = 0;
  const client = { getHistory: async () => { calls++; return chartExchangeRouteFixture(); } };
  const get = createOptionsPriceHistoryRoute({ chartexchange: client, yahoo: client });
  for (const query of [
    "from=", "to=", "from=2026-2-01", "to=2026-02-29", "from=2026-02-31", "to=2026-13-01", "from=2026-09-01T00:00:00Z",
    "from=2026-09-04&to=2026-09-03", "from=2026-09-01&from=2026-09-01", "to=2026-09-04&to=2026-09-04",
    "from=2026-09-01&source=yahoo&source=yahoo", "from=2026-09-01&timezone=UTC",
  ]) {
    const response = await get(new Request(`http://localhost/api/options/prices?contractId=${REQUEST.contractId}&${query}`), { params: Promise.resolve({ symbol: "NBIS" }) });
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_request");
  }
  assert.equal(calls, 0);
});

test("Yahoo filtering follows original exchange-local dates, preserves timestamps and never extends available coverage", async () => {
  const yahoo = parseYahooOptionPriceHistory(payload([stamp("2026-09-04T01:00:00Z"), stamp("2026-09-04T20:00:00Z")]), REQUEST, NOW);
  const get = createOptionsPriceHistoryRoute({
    chartexchange: { getHistory: async () => { throw new Error("must not use ChartExchange"); } },
    yahoo: { getHistory: async () => yahoo },
  });
  const response = await get(new Request(`http://localhost/api/options/prices?contractId=${REQUEST.contractId}&source=yahoo&from=2020-01-01&to=2026-09-03`), { params: Promise.resolve({ symbol: "NBIS" }) });
  assert.equal(response.status, 200);
  const result = await response.json() as OptionsPriceHistory;
  assert.deepEqual(result.items, [yahoo.items[0]]);
  assert.equal(result.items[0].date, "2026-09-03");
  assert.equal(result.items[0].time, stamp("2026-09-04T01:00:00Z"));
  assert.equal(result.source, "Yahoo Finance");
  assert.equal(result.sourceAsOf, yahoo.sourceAsOf);
  assert.deepEqual(result.coverage, yahoo.coverage);
  assert.equal(result.requestedRange, "1y");
  assert.equal(result.openInterestDateBasis, undefined);
});

test("expired contracts remain valid lookup identities for date-filtered history", async () => {
  const expired: OptionsPriceHistory = {
    ...chartExchangeRouteFixture(), contractId: "NBIS250905P00230000", expiration: "2025-09-05", side: "put",
    sourceUrl: "https://chartexchange.com/symbol/opra-nbis20250905p230/historical/",
    items: [{ date: "2025-09-04", close: 1, openInterest: 100 }],
    coverage: { from: "2025-09-04", to: "2026-09-05", firstDate: "2025-09-04", lastDate: "2025-09-04", sourceRows: 1, returnedBars: 1, observedBars: 1, missingBars: 0 },
  };
  const get = createOptionsPriceHistoryRoute({
    chartexchange: { getHistory: async request => { assert.equal(request.contractId, expired.contractId); return expired; } },
    yahoo: { getHistory: async () => { throw new Error("unexpected source"); } },
  });
  const response = await get(new Request(`http://localhost/api/options/prices?contractId=${expired.contractId}&from=2025-09-01&to=2025-09-05`), { params: Promise.resolve({ symbol: "NBIS" }) });
  assert.equal(response.status, 200);
  const result = await response.json() as OptionsPriceHistory;
  assert.deepEqual(result.items, expired.items);
  assert.equal(result.expiration, "2025-09-05");
  assert.equal(result.side, "put");
});

test("date-filtered routes refuse a mismatched returned source or contract identity", async () => {
  for (const patch of [
    { source: "Yahoo Finance" as const }, { symbol: "MU" }, { underlying: { symbol: "MU" } },
    { contractId: "NBIS260911P00230000" }, { side: "put" as const }, { expiration: "2026-09-18" }, { strike: 231 },
  ]) {
    let yahooCalls = 0;
    const get = createOptionsPriceHistoryRoute({
      chartexchange: { getHistory: async () => ({ ...chartExchangeRouteFixture(), ...patch }) },
      yahoo: { getHistory: async () => { yahooCalls++; return parseYahooOptionPriceHistory(payload(), REQUEST, NOW); } },
    });
    const response = await get(new Request(`http://localhost/api/options/prices?contractId=${REQUEST.contractId}&from=2026-09-01`), { params: Promise.resolve({ symbol: "NBIS" }) });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_response");
    assert.equal(yahooCalls, 0);
  }
});
