import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createNasdaqOptionsClient, OptionsDataError, parseNasdaqOptions } from "../api/options/nasdaq.server";
import { GET } from "../src/app/api/v1/symbols/[symbol]/options/route";
import { OptionsChainTable } from "../src/app/features/stock-detail/OptionsChainPanel";

const NOW = "2026-09-05T10:00:00.000Z";
const row = {
  expirygroup: "", expiryDate: "Sep 11", strike: "225.00", c_Last: "12.40", c_Bid: "12.20", c_Ask: "12.50", c_Change: "-0.25", c_Volume: "1,250", c_Openinterest: "3,900",
  p_Last: "0.00", p_Bid: "--", p_Ask: "1.10", p_Change: "--", p_Volume: "--", p_Openinterest: "0",
  drillDownURL: "/market-activity/stocks/nbis/option-chain/call-put-options/nbis--260911c00225000",
};
function prices(rows: unknown[] = [{ expirygroup: "September 11, 2026" }, row]) {
  return { data: { totalRecord: rows.length, lastTrade: "LAST TRADE: $226.39 (AS OF SEP 3, 2026)", table: { asOf: null, rows } }, status: { rCode: 200 } };
}
function greeks(rows: unknown[] = [{ cDelta: 0.6, cGamma: 0.01, cTheta: -0.04, cVega: 0.1, cRho: 0.04, cIV: 0, pDelta: -0.4, pGamma: 0.02, pTheta: -0.03, pVega: 0.08, pRho: -0.02, pIV: 0, strike: 225, url: row.drillDownURL }]) {
  return { data: { filters: [{ value: "2026-09-11" }, { value: "2026-10-16" }], table: { asOf: null, rows } }, status: { rCode: 200 } };
}

test("Nasdaq chain preserves quoted prices, zero counts and missing values with a separate retrieval time", () => {
  const result = parseNasdaqOptions(prices(), { symbol: "NBIS" }, NOW, greeks());
  assert.equal(result.source, "Nasdaq");
  assert.equal(result.underlyingPrice, 226.39);
  assert.equal(result.underlyingAsOf, "2026-09-03");
  assert.equal(result.fetchedAt, NOW);
  assert.equal(result.optionQuoteAsOf, undefined);
  assert.deepEqual(result.expirations, ["2026-09-11", "2026-10-16"]);
  assert.equal(result.contracts[0].contractId, "NBIS260911C00225000");
  assert.equal(result.contracts[0].last, 12.4);
  assert.equal(result.contracts[0].bid, 12.2);
  assert.equal(result.contracts[0].ask, 12.5);
  assert.equal(result.contracts[0].volume, 1250);
  assert.equal(result.contracts[0].openInterest, 3900);
  assert.equal(result.contracts[0].delta, 0.6);
  assert.equal(result.contracts[1].last, 0);
  assert.equal(result.contracts[1].bid, undefined);
  assert.equal(result.contracts[1].volume, undefined);
  assert.equal(result.contracts[1].openInterest, 0);
  assert.equal(result.contracts[1].delta, -0.4);
  assert.equal(result.impliedVolatilityAvailable, false);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.coverage, { strikeMin: 225, strikeMax: 225, strikeCount: 1, contractCount: 2, fetchedRows: 2, sourceTotalRows: 2, complete: true });
});

test("contract symbol, expiration and strike identity must match the source table", () => {
  for (const changed of [
    { ...row, strike: "230.00" },
    { ...row, drillDownURL: row.drillDownURL.replaceAll("nbis", "aapl") },
    { ...row, drillDownURL: row.drillDownURL.replace("260911", "260231") },
  ]) assert.throws(() => parseNasdaqOptions(prices([{ expirygroup: "September 11, 2026" }, changed]), { symbol: "NBIS" }, NOW), OptionsDataError);
  assert.throws(() => parseNasdaqOptions(prices(), { symbol: "NBIS", expiration: "2026-10-16" }, NOW), OptionsDataError);
  assert.throws(() => parseNasdaqOptions(prices([row, row]), { symbol: "NBIS" }, NOW), OptionsDataError);
});

test("Nasdaq six-character option roots preserve MU prices, open interest and matched Greeks", () => {
  // Representative rows from Nasdaq's MU chain and Greeks responses on 2026-09-05.
  const muRow = {
    expirygroup: "", expiryDate: "Sep 9", strike: "915.00",
    c_Last: "95.00", c_Bid: "97.70", c_Ask: "107.65", c_Change: "45.00", c_Volume: "19", c_Openinterest: "86",
    p_Last: "1.00", p_Bid: "0.95", p_Ask: "1.05", p_Change: "-6.05", p_Volume: "1613", p_Openinterest: "202",
    drillDownURL: "/market-activity/stocks/mu/option-chain/call-put-options/mu----260909c00915000",
  };
  const muGreeks = greeks([{
    strike: 915, url: muRow.drillDownURL,
    cDelta: 0.97234, cGamma: 0.00112, cTheta: -0.4519, cVega: 0.07564, cRho: 0.12126,
    pDelta: -0.03911, pGamma: 0.00136, pTheta: -0.52205, pVega: 0.10064, pRho: -0.00558,
  }]);
  const result = parseNasdaqOptions(prices([{ expirygroup: "September 9, 2026" }, muRow]), { symbol: "MU" }, NOW, muGreeks);
  assert.equal(result.expiration, "2026-09-09");
  assert.equal(result.contracts.length, 2);
  const [call, put] = result.contracts;
  assert.equal(call.contractId, "MU260909C00915000");
  assert.equal(call.last, 95); assert.equal(call.bid, 97.7); assert.equal(call.ask, 107.65);
  assert.equal(call.volume, 19); assert.equal(call.openInterest, 86); assert.equal(call.delta, 0.97234);
  assert.equal(put.contractId, "MU260909P00915000");
  assert.equal(put.last, 1); assert.equal(put.bid, 0.95); assert.equal(put.ask, 1.05);
  assert.equal(put.volume, 1613); assert.equal(put.openInterest, 202); assert.equal(put.delta, -0.03911);
});

test("option root padding is exact for different ticker lengths and never admits another symbol", () => {
  for (const symbol of ["F", "MU", "AMD", "NBIS", "GOOGL"]) {
    const root = symbol.toLowerCase().padEnd(6, "-");
    const path = `/market-activity/stocks/${symbol.toLowerCase()}/option-chain/call-put-options/`;
    const source = prices([{ ...row, drillDownURL: `${path}${root}260911c00225000` }]);
    const result = parseNasdaqOptions(source, { symbol }, NOW);
    assert.equal(result.contracts[0].contractId, `${symbol}260911C00225000`);
    for (const incorrectRoot of [root + "-", root.slice(0, -1), "aapl--"]) {
      assert.throws(() => parseNasdaqOptions(prices([{ ...row, drillDownURL: `${path}${incorrectRoot}260911c00225000` }]), { symbol }, NOW), OptionsDataError);
    }
    assert.throws(() => parseNasdaqOptions(prices([{ ...row, drillDownURL: `/market-activity/stocks/aapl/option-chain/call-put-options/${root}260911c00225000` }]), { symbol }, NOW), OptionsDataError);
  }
});

test("put-only Greek rows and another expiration never populate call sensitivities", () => {
  const result = parseNasdaqOptions(prices(), { symbol: "NBIS" }, NOW, greeks([
    { cDelta: -0.9, cGamma: 1, strike: 225, url: row.drillDownURL.replace("c00225000", "p00225000") },
    { cDelta: 0.99, strike: 225, url: row.drillDownURL.replace("260911", "261016") },
  ]));
  assert.equal(result.contracts[0].delta, undefined);
  assert.equal(result.contracts[1].delta, undefined);
  assert.equal(result.greeksAvailable, false);
  const zero = parseNasdaqOptions(prices(), { symbol: "NBIS" }, NOW, greeks([{ cDelta: 0, cGamma: 0, cTheta: 0, cVega: 0, cRho: 0, strike: 225, url: row.drillDownURL }]));
  assert.equal(zero.contracts[0].delta, undefined);
});

test("price data remains available after Greek-source failure and never invents liquidity", () => {
  const result = parseNasdaqOptions(prices([{ ...row, c_Last: "NaN", c_Volume: "-1", c_Openinterest: "1.5", c_Bid: "Infinity" }]), { symbol: "NBIS" }, NOW, { data: null });
  assert.equal(result.contracts[0].last, undefined);
  assert.equal(result.contracts[0].volume, undefined);
  assert.equal(result.contracts[0].openInterest, undefined);
  assert.equal(result.contracts[0].bid, undefined);
  assert.equal(result.contracts[0].ask, 12.5);
  assert.equal(result.greeksAvailable, false);
});

test("bounded response states distinguish an empty chain from truncation", () => {
  const empty = parseNasdaqOptions(prices([]), { symbol: "NBIS" }, NOW);
  assert.equal(empty.expiration, null);
  assert.deepEqual(empty.contracts, []);
  const source = prices();
  source.data.totalRecord = 999;
  assert.equal(parseNasdaqOptions(source, { symbol: "NBIS" }, NOW).truncated, true);
});

test("options cache deduplicates concurrent requests and binds explicit expiration to both sources", async () => {
  const urls: string[] = [];
  const client = createNasdaqOptionsClient({ now: () => new Date(NOW), fetch: async input => {
    const url = String(input); urls.push(url);
    return Response.json(url.includes("/greeks") ? greeks() : prices());
  } });
  const request = { symbol: "nbis", expiration: "2026-09-11", range: "all" as const };
  const [a, b] = await Promise.all([client.getOptions(request), client.getOptions(request)]);
  const c = await client.getOptions(request);
  assert.equal(a, b); assert.equal(a, c); assert.equal(urls.length, 2);
  const chainUrl = urls.find(url => !url.includes("/greeks"))!;
  assert.match(chainUrl, /limit=500/);
  assert.match(chainUrl, /money=all/);
  assert.match(chainUrl, /fromdate=2026-09-11&todate=2026-09-11/);
  assert.match(urls.find(url => url.includes("/greeks"))!, /date=2026-09-11/);
});

test("the default expiration is discovered before fetching only its full strike range", async () => {
  const urls: URL[] = [];
  const client = createNasdaqOptionsClient({ now: () => new Date(NOW), fetch: async input => {
    const url = new URL(String(input)); urls.push(url);
    if (url.pathname.endsWith("/greeks")) return Response.json(greeks());
    const payload = prices();
    if (!url.searchParams.has("fromdate")) payload.data.totalRecord = 1072;
    return Response.json(payload);
  } });
  const result = await client.getOptions({ symbol: "NBIS" });
  assert.equal(urls.length, 3);
  assert.equal(urls[0].searchParams.get("limit"), "2");
  assert.equal(urls[0].searchParams.get("money"), "all");
  for (const url of urls.slice(1)) assert.equal(url.searchParams.get(url.pathname.endsWith("/greeks") ? "date" : "fromdate"), "2026-09-11");
  assert.equal(result.expiration, "2026-09-11");
  assert.equal(result.truncated, false);
  assert.equal(result.coverage?.sourceTotalRows, 2);
  assert.deepEqual(result.expirations, ["2026-09-11", "2026-10-16"]);
});

test("unretrieved later expirations do not make a closed first expiration incomplete", () => {
  const payload = prices([{ expirygroup: "September 11, 2026" }, row, { expirygroup: "October 16, 2026" }]);
  payload.data.totalRecord = 2000;
  const result = parseNasdaqOptions(payload, { symbol: "NBIS" }, NOW);
  assert.equal(result.truncated, false);
  assert.equal(result.coverage?.fetchedRows, 2);
  assert.equal(result.coverage?.sourceTotalRows, 2);
});

function longChain(strikeCount: number) {
  return prices([{ expirygroup: "September 11, 2026" }, ...Array.from({ length: strikeCount }, (_, index) => {
    const strike = index + 1;
    return { ...row, strike: String(strike), drillDownURL: row.drillDownURL.replace("00225000", String(strike * 1000).padStart(8, "0")) };
  })]);
}

test("selected-expiration pagination preserves every strike and reports source-count coverage", async () => {
  const payload = longChain(1200);
  const offsets: number[] = [];
  const client = createNasdaqOptionsClient({ now: () => new Date(NOW), fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/greeks")) return Response.json(greeks([]));
    assert.equal(url.searchParams.get("fromdate"), "2026-09-11");
    assert.equal(url.searchParams.get("todate"), "2026-09-11");
    const offset = Number(url.searchParams.get("offset") ?? 0); offsets.push(offset);
    return Response.json({ ...payload, data: { ...payload.data, table: { ...payload.data.table, rows: payload.data.table.rows.slice(offset, offset + 500) } } });
  } });
  const result = await client.getOptions({ symbol: "NBIS", expiration: "2026-09-11", range: "all" });
  assert.deepEqual(offsets, [0, 500, 1000]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.coverage, { strikeMin: 1, strikeMax: 1200, strikeCount: 1200, contractCount: 2400, fetchedRows: 1201, sourceTotalRows: 1201, complete: true });
  assert.equal(result.contracts.at(-1)?.contractId, "NBIS260911P01200000");
});

test("pagination is capped at four pages and never labels a partial range complete", async () => {
  const payload = longChain(2500);
  let pages = 0;
  const client = createNasdaqOptionsClient({ fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/greeks")) return Response.json(greeks([]));
    pages++;
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return Response.json({ ...payload, data: { ...payload.data, table: { ...payload.data.table, rows: payload.data.table.rows.slice(offset, offset + 500) } } });
  } });
  const result = await client.getOptions({ symbol: "NBIS", expiration: "2026-09-11", range: "all" });
  assert.equal(pages, 4);
  assert.equal(result.truncated, true);
  assert.equal(result.coverage?.complete, false);
  assert.equal(result.coverage?.fetchedRows, 2000);
  assert.equal(result.coverage?.sourceTotalRows, 2501);
  assert.equal(result.coverage?.strikeMax, 1999);
});

test("repeated or mismatched pagination rows are rejected instead of filling another strike or expiration", async () => {
  const payload = longChain(501);
  for (const badRow of [payload.data.table.rows[1], { ...row, drillDownURL: row.drillDownURL.replace("260911", "261016") }]) {
    const client = createNasdaqOptionsClient({ fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/greeks")) return Response.json(greeks([]));
      const rows = url.searchParams.has("offset") ? [badRow] : payload.data.table.rows.slice(0, 500);
      return Response.json({ ...payload, data: { ...payload.data, table: { ...payload.data.table, rows } } });
    } });
    await assert.rejects(client.getOptions({ symbol: "NBIS", expiration: "2026-09-11" }), (error: unknown) => error instanceof OptionsDataError && error.code === "invalid_response");
  }
});

test("a timed-out later page retains verified earlier rows as incomplete within one deadline", async () => {
  const payload = longChain(501);
  let aborted = 0;
  const client = createNasdaqOptionsClient({ timeoutMs: 20, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/greeks")) return Response.json(greeks([]));
    if (url.searchParams.has("offset")) return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); });
    });
    return Response.json({ ...payload, data: { ...payload.data, table: { ...payload.data.table, rows: payload.data.table.rows.slice(0, 500) } } });
  } });
  const result = await client.getOptions({ symbol: "NBIS", expiration: "2026-09-11", range: "all" });
  assert.equal(aborted, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.coverage?.fetchedRows, 500);
  assert.equal(result.coverage?.sourceTotalRows, 502);
});

test("failed refresh returns explicitly stale data and retries remain bounded", async () => {
  let at = Date.parse(NOW); let fail = false; let requests = 0;
  const client = createNasdaqOptionsClient({ now: () => new Date(at), cacheTtlMs: 100, fetch: async input => {
    requests++; if (fail) return new Response("Unavailable", { status: 503 });
    return Response.json(String(input).includes("/greeks") ? greeks() : prices());
  } });
  await client.getOptions({ symbol: "NBIS" });
  at += 200; fail = true;
  const stale = await client.getOptions({ symbol: "NBIS" });
  assert.equal(stale.isStale, true); assert.equal(stale.fetchedAt, NOW);
  await client.getOptions({ symbol: "NBIS" });
  assert.equal(requests, 4);
});

test("a timed-out source is aborted and oversized payloads are rejected", async () => {
  let aborts = 0;
  const client = createNasdaqOptionsClient({ timeoutMs: 5, fetch: async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborts++; reject(new Error("aborted")); });
  }) });
  await assert.rejects(client.getOptions({ symbol: "NBIS", expiration: "2026-09-11" }), (error: unknown) => error instanceof OptionsDataError && error.code === "timeout");
  assert.equal(aborts, 2);
  const oversized = createNasdaqOptionsClient({ fetch: async () => new Response("{}", { headers: { "content-length": "2000001" } }) });
  await assert.rejects(oversized.getOptions({ symbol: "NBIS" }), OptionsDataError);
});

test("invalid options route inputs are rejected before contacting a source", async () => {
  for (const [symbol, query] of [["../bad", ""], ["NBIS", "?expiration=2026-02-31"], ["NBIS", "?range=anything"]]) {
    const response = await GET(new Request(`http://localhost/api/options${query}`), { params: Promise.resolve({ symbol }) });
    assert.equal(response.status, 400);
  }
});

test("options price and Greek tables keep missing observations distinct from quoted zero", () => {
  const result = parseNasdaqOptions(prices(), { symbol: "NBIS" }, NOW, greeks());
  const calls = renderToStaticMarkup(createElement(OptionsChainTable, { contracts: [result.contracts[0]], ja: true }));
  assert.match(calls, /買気配/); assert.match(calls, /売気配/); assert.match(calls, /12\.40/); assert.match(calls, /1,250/); assert.match(calls, /-0\.25/);
  const puts = renderToStaticMarkup(createElement(OptionsChainTable, { contracts: [result.contracts[1]] }));
  assert.match(puts, /options-last-price">0\.00<\/td><td>—<\/td>/);
  const sensitivities = renderToStaticMarkup(createElement(OptionsChainTable, { contracts: [result.contracts[1]], greeks: true }));
  assert.match(sensitivities, /-0\.4000/);
  assert.match(sensitivities, /No verified source IV">—/);
  assert.doesNotMatch(sensitivities, /NaN|Infinity/);
});
