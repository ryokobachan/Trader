import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createChartExchangeOptionHistoryClient, parseChartExchangeOptionHistory } from "../api/options/chartexchange-history.server";
import { OptionPriceHistoryError } from "../api/options/price-history.server";

const NOW = "2026-09-05T10:00:00.000Z";
const REQUEST = { symbol: "NBIS", contractId: "NBIS260911C00230000" };
const URL = "https://chartexchange.com/symbol/opra-nbis20260911c230/historical/";
const FIXTURE = readFileSync(new globalThis.URL("./fixtures/chartexchange-nbis-option-history.html", import.meta.url), "utf8");
const HEADER = FIXTURE.match(/<tr>[\s\S]*?<\/tr>/)![0];
const hasCode = (code: string) => (error: unknown) => error instanceof OptionPriceHistoryError && error.code === code;
const row = (date: string, fields = ["2", "4", "1", "3", "0%", "10", "20", "0%"]) => `<tr>${[date, ...fields].map(value => `<td>${value}</td>`).join("")}</tr>`;
const page = (rows: string[]) => FIXTURE.replace(/<table>[\s\S]*?<\/table>/, `<table>${HEADER}${rows.join("")}</table>`);
const htmlResponse = (html = FIXTURE) => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });

test("the anonymous NBIS table retains contract OI dates and values without fabricating trade timestamps", () => {
  const result = parseChartExchangeOptionHistory(FIXTURE, REQUEST, NOW);
  assert.equal(result.source, "ChartExchange");
  assert.equal(result.sourceUrl, URL);
  assert.equal(result.contractId, REQUEST.contractId);
  assert.equal(result.sourceAsOf, null);
  assert.equal(result.fetchedAt, NOW);
  assert.equal(result.openInterestDateBasis, "source_session_date_unverified");
  assert.equal(result.requestedRange, "available");
  assert.equal(result.priceAdjustment, "source_ohlc");
  assert.equal(result.adjustedCloseUsed, false);
  assert.equal(result.timezone, "America/New_York");
  assert.deepEqual(result.underlying, { symbol: "NBIS" });
  assert.deepEqual(result.items, [
    { date: "2026-09-01", open: 2.19, high: 2.43, low: 1.7, close: 2.1, volume: 244, openInterest: 539 },
    { date: "2026-09-02", open: 1.65, high: 2.6, low: 1.65, close: 2.42, volume: 434, openInterest: 823 },
    { date: "2026-09-03", open: 1.75, high: 3.55, low: 1.45, close: 3.15, volume: 2022, openInterest: 2296 },
  ]);
  assert.deepEqual(result.coverage, { from: "2026-09-01", to: "2026-09-05", firstDate: "2026-09-01", lastDate: "2026-09-03", missingBars: 0, sourceRows: 3, returnedBars: 3, observedBars: 3 });
  assert.doesNotMatch(JSON.stringify(result), /"time":|latestOptionPrice|underlyingPrice/);
});

test("OCC identity is checked in the visible contract heading and the canonical URL", () => {
  for (const source of [
    FIXTURE.replace(`(${REQUEST.contractId})`, "(MU260911C00230000)"),
    FIXTURE.replace(`(${REQUEST.contractId})`, "(NBIS260911P00230000)"),
    FIXTURE.replace(`(${REQUEST.contractId})`, "(NBIS260918C00230000)"),
    FIXTURE.replace(`(${REQUEST.contractId})`, "(NBIS260911C00227500)"),
    FIXTURE.replace(URL, URL.replace("c230", "c235")),
    FIXTURE.replace("option</span>", "stock</span>"),
    FIXTURE.replace("OPRA</span>", "NASDAQ</span>"),
    FIXTURE.replace(/<h1>[\s\S]*?<\/h1>/, `<script><h1>(${REQUEST.contractId}) option OPRA</h1></script>`),
  ]) assert.throws(() => parseChartExchangeOptionHistory(source, REQUEST, NOW), hasCode("invalid_response"));
  assert.throws(() => parseChartExchangeOptionHistory(FIXTURE, { symbol: "MU", contractId: REQUEST.contractId }, NOW), hasCode("invalid_request"));
});

test("header-only no-data tables differ from HTML changes, duplicate tables, and missing columns", () => {
  assert.throws(() => parseChartExchangeOptionHistory(page([]), REQUEST, NOW), hasCode("not_found"));
  for (const source of [
    FIXTURE.replace("Open<br>Interest", "Implied Volatility"),
    FIXTURE.replace("(EDT)", "(UTC)"),
    FIXTURE.replace("<td>2,296</td>", ""),
    FIXTURE.replace("</table>", "<tr><td>2026-08-31</td></table>"),
    FIXTURE.replace("<td>2,296</td>", "<td>2,296"),
    FIXTURE.replace("<td>2,296</td>", '<td colspan="2">2,296</td>'),
    FIXTURE.replace(/<table>[\s\S]*?<\/table>/, ""),
    FIXTURE + `<table>${HEADER}${row("2026-09-02")}</table>`,
    "<html><h1>Please sign in</h1></html>",
  ]) assert.throws(() => parseChartExchangeOptionHistory(source, REQUEST, NOW), hasCode("invalid_response"));
});

test("source zeros, empty dates, OI-only observations and partial prices remain distinct", () => {
  const result = parseChartExchangeOptionHistory(page([
    row("2026-09-03", ["0", "0", "0", "0", "0%", "0", "0", "0%"]),
    row("2026-09-02", ["—", "&nbsp;", "-", "N/A", "-", "–", "", "-"]),
    row("2026-09-01", ["", "", "", "", "", "", "123", ""]),
    row("2026-08-31", ["", "3.5000", "1.25", "2.75", "0%", "0", "&mdash;", "0%"]),
  ]), REQUEST, NOW);
  assert.deepEqual(result.items[0], { date: "2026-08-31", high: 3.5, low: 1.25, close: 2.75, volume: 0 });
  assert.deepEqual(result.items[1], { date: "2026-09-01", openInterest: 123 });
  assert.deepEqual(result.items[2], { date: "2026-09-02" });
  assert.deepEqual(result.items[3], { date: "2026-09-03", open: 0, high: 0, low: 0, close: 0, volume: 0, openInterest: 0 });
  assert.equal(result.coverage.missingBars, 1);
  assert.equal(result.coverage.observedBars, 3);
});

test("all available years are retained and coverage uses New York today without changing source dates", () => {
  const source = page([row("2026-09-04"), row("2025-01-02"), row("2024-10-30")]);
  const result = parseChartExchangeOptionHistory(source, REQUEST, "2026-09-05T01:00:00Z");
  assert.deepEqual(result.items.map(item => item.date), ["2024-10-30", "2025-01-02", "2026-09-04"]);
  assert.equal(result.coverage.from, "2024-10-30");
  assert.equal(result.coverage.to, "2026-09-04");
  const winter = parseChartExchangeOptionHistory(page([row("2025-12-31")]).replace("(EDT)", "(EST)"), REQUEST, "2026-01-01T01:00:00Z");
  assert.equal(winter.coverage.to, "2025-12-31");
});

test("duplicate, ascending, future, expired, and impossible source dates fail closed", () => {
  for (const dates of [["2026-09-03", "2026-09-03"], ["2026-09-01", "2026-09-03"], ["2026-09-06"], ["2026-02-30"]]) {
    assert.throws(() => parseChartExchangeOptionHistory(page(dates.map(date => row(date))), REQUEST, NOW), hasCode("invalid_response"));
  }
  assert.throws(() => parseChartExchangeOptionHistory(page([row("2026-09-12")]), REQUEST, "2026-10-01T10:00:00Z"), hasCode("invalid_response"));
  assert.throws(() => parseChartExchangeOptionHistory(FIXTURE, REQUEST, "invalid"), hasCode("invalid_request"));
});

test("malformed or negative numbers, fractional counts, unsafe integers and inconsistent OHLC are rejected", () => {
  for (const [index, value] of [[0, "-1"], [0, "NaN"], [0, "Infinity"], [0, "1e5"], [5, "1,23"], [5, "1.2"], [6, "-1"], [6, "9007199254740992"], [1, "0.5"], [2, "3.5"], [3, "5"], [0, "9".repeat(400)]] as const) {
    const fields = ["2", "4", "1", "3", "0%", "10", "20", "0%"];
    fields[index] = value;
    assert.throws(() => parseChartExchangeOptionHistory(page([row("2026-09-03", fields)]), REQUEST, NOW), hasCode("invalid_response"));
  }
  const nested = parseChartExchangeOptionHistory(page([row("2026-09-03", ["2", "4", "1", "3", "0%", "1<span>,</span>234", "&#48;", "0%"])]), REQUEST, NOW);
  assert.equal(nested.items[0].volume, 1234);
  assert.equal(nested.items[0].openInterest, 0);
});

test("ordinary page requests deduplicate, cache, and preserve exact decimal/root URL punctuation", async () => {
  let at = Date.parse(NOW);
  const urls: string[] = [];
  const client = createChartExchangeOptionHistoryClient({ now: () => new Date(at), fetch: async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.headers && new Headers(init.headers).get("Accept"), "text/html");
    assert.equal(init?.headers && new Headers(init.headers).has("Cookie"), false);
    return htmlResponse();
  } });
  const [a, b] = await Promise.all([client.getHistory(REQUEST), client.getHistory(REQUEST)]);
  assert.equal(a, b);
  assert.equal(await client.getHistory(REQUEST), a);
  assert.deepEqual(urls, [URL]);
  at += 300_001;
  await client.getHistory(REQUEST);
  assert.equal(urls.length, 2);
  for (const [symbol, contractId, slug] of [
    ["NBIS", "NBIS260911C00227500", "nbis20260911c227.5"],
    ["A.B", "A.B260911P00000125", "a.b20260911p0.125"],
    ["A-B", "A-B260911C00230000", "a-b20260911c230"],
  ]) {
    const urlCheck = createChartExchangeOptionHistoryClient({ fetch: async input => { assert.equal(String(input), `https://chartexchange.com/symbol/opra-${slug}/historical/`); return new Response("", { status: 404 }); } });
    await assert.rejects(urlCheck.getHistory({ symbol, contractId }), hasCode("not_found"));
  }
});

test("HTTP errors never cause retries or host changes and negative caching expires", async () => {
  for (const status of [301, 302, 307, 308, 401, 403, 404, 429, 500]) {
    let count = 0;
    let at = Date.parse(NOW);
    const client = createChartExchangeOptionHistoryClient({ now: () => new Date(at), fetch: async () => { count++; return new Response("unavailable", { status }); } });
    await assert.rejects(client.getHistory(REQUEST), hasCode(status === 404 ? "not_found" : "unavailable"));
    await assert.rejects(client.getHistory(REQUEST), OptionPriceHistoryError);
    assert.equal(count, 1);
    at += 30_001;
    await assert.rejects(client.getHistory(REQUEST), OptionPriceHistoryError);
    assert.equal(count, 2);
  }
});

test("responses are limited by headers, streamed bytes, HTML type and strict UTF-8", async () => {
  const responses = [
    new Response("", { headers: { "content-length": "2000001", "content-type": "text/html" } }),
    htmlResponse("x".repeat(2_000_001)),
    new Response(FIXTURE, { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "text/html" } }),
  ];
  for (const response of responses) {
    const client = createChartExchangeOptionHistoryClient({ fetch: async () => response });
    await assert.rejects(client.getHistory(REQUEST), hasCode("invalid_response"));
  }
  assert.throws(() => parseChartExchangeOptionHistory(FIXTURE + "あ".repeat(700_000), REQUEST, NOW), hasCode("invalid_response"));
});

test("the deadline bounds both an unresponsive fetch and a stalled response body", async () => {
  let signal: AbortSignal | undefined;
  const waiting = createChartExchangeOptionHistoryClient({ timeoutMs: 5, fetch: async (_input, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); } });
  await assert.rejects(waiting.getHistory(REQUEST), hasCode("timeout"));
  assert.equal(signal?.aborted, true);
  let bodyCancelled = false;
  const body = createChartExchangeOptionHistoryClient({ timeoutMs: 5, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("<html>")); }, cancel() { bodyCancelled = true; } }), { headers: { "content-type": "text/html" } }) });
  await assert.rejects(body.getHistory(REQUEST), hasCode("timeout"));
  assert.equal(bodyCancelled, true);
});

test("distinct in-flight requests are bounded at eight while duplicates share existing work", async () => {
  const releases: Array<() => void> = [];
  const client = createChartExchangeOptionHistoryClient({ fetch: async () => new Promise(resolve => { releases.push(() => resolve(new Response("", { status: 404 }))); }) });
  const requests = Array.from({ length: 8 }, (_, index) => ({ symbol: "NBIS", contractId: `NBIS260911C00${230 + index}000` }));
  const pending = requests.map(request => client.getHistory(request));
  const duplicate = client.getHistory(requests[0]);
  await assert.rejects(client.getHistory({ symbol: "NBIS", contractId: "NBIS260911C00250000" }), hasCode("capacity"));
  assert.equal(releases.length, 8);
  releases.forEach(release => release());
  const results = await Promise.allSettled([...pending, duplicate]);
  assert.ok(results.every(result => result.status === "rejected" && hasCode("not_found")(result.reason)));
});
