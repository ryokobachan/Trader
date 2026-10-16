import assert from "node:assert/strict";
import test from "node:test";

import {
  createGoogleFinanceEarningsProvider,
  extractGoogleFinanceEarnings,
  GoogleFinanceEarningsError,
  googleFinanceEarningsProviderRegistration,
} from "../api/google-finance-earnings/index.server";
import type { Instrument } from "../src/app/platform/provider-contracts";

const NOW = new Date("2026-09-05T03:00:00.000Z");
const CONTEXT = { requestId: "google-earnings-test" };
const INSTRUMENT: Instrument = {
  instrumentId: "us:XNAS:NBIS", symbol: "NBIS", name: "Nebius Group",
  assetType: "common_stock", active: true, listingCountry: "US",
  exchange: "NASDAQ Global Select Market", exchangeMic: "XNAS", currency: "USD",
  provenance: { providerId: "fixture", sourceId: "fixture:NBIS", asOf: NOW.toISOString(), ingestedAt: NOW.toISOString() },
};

// Shape and distinct EPS bases observed from NBIS's public earnings RPC.
function row(overrides: { symbol?: string; exchange?: string; timestamp?: number | null; values?: Record<number, unknown>; quarter?: number } = {}) {
  const values: unknown[] = [
    582_300_000, null, -0.68, null, null, null, null, null,
    573_937_510, -0.1184, -0.698, 0.01457, 0.83037, 1, null, null, "USD", [2026, 6, 30],
  ];
  for (const [index, value] of Object.entries(overrides.values ?? {})) values[Number(index)] = value;
  return ["/g/example", [overrides.symbol ?? "NBIS", overrides.exchange ?? "NASDAQ"], "Nebius Group",
    2026, overrides.quarter ?? 2, null, null, null, null, values, 2,
    overrides.timestamp === null ? null : [overrides.timestamp ?? 1_786_536_000], 1];
}

function rpc(rows: readonly unknown[] = [row()], rpcId = "wKsYyb") {
  const packet = JSON.stringify([["wrb.fr", rpcId, JSON.stringify([[rows]]), null, null]]);
  return `)]}'\n\n${new TextEncoder().encode(packet).byteLength}\n${packet}\n`;
}

function response(body = rpc(), status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof GoogleFinanceEarningsError && error.code === code;
}

test("uses actual announcement timestamps, source fiscal periods and separate EPS bases", () => {
  const result = extractGoogleFinanceEarnings(rpc(), INSTRUMENT, NOW.toISOString());
  assert.equal(result.length, 1);
  assert.equal(result[0].reportDate, "2026-08-12");
  assert.equal(result[0].fiscalDateEnding, "2026-06-30");
  assert.equal(result[0].fiscalPeriod, "2026-Q2");
  assert.equal(result[0].epsActual, -0.1184);
  assert.equal(result[0].statementEPS, -0.68);
  assert.equal(result[0].epsBasis, "earnings_display");
  assert.equal(result[0].epsEstimate, -0.698);
  assert.equal(result[0].revenueActual, 582_300_000);
  assert.equal(result[0].revenueEstimate, 573_937_510);
  assert.equal(result[0].provenance.asOf, "2026-08-12T12:00:00.000Z");
  assert.equal(result[0].provenance.providerId, "google-finance-earnings");
  assert.match(result[0].provenance.sourceUrl!, /quote\/NBIS:NASDAQ/);
});

test("does not convert missing values to zero or substitute statement EPS for consensus EPS", () => {
  const result = extractGoogleFinanceEarnings(rpc([
    row({ values: { 0: null, 8: null, 9: null, 10: 0 } }),
  ]), INSTRUMENT, NOW.toISOString());
  assert.equal(result[0].epsActual, undefined);
  assert.equal(result[0].epsEstimate, 0);
  assert.equal(result[0].statementEPS, -0.68);
  assert.equal(result[0].revenueActual, undefined);
  assert.equal(result[0].revenueEstimate, undefined);
});

test("omits rows without report timestamps and non-USD monetary data", () => {
  const result = extractGoogleFinanceEarnings(rpc([
    row({ timestamp: null }), row({ values: { 16: "EUR" } }),
  ]), INSTRUMENT, NOW.toISOString());
  assert.deepEqual(result, []);
});

test("uses the US announcement calendar date and de-duplicates/sorts report records", () => {
  const latest = row({ timestamp: Date.parse("2026-08-13T01:00:00Z") / 1_000 });
  const old = row({ quarter: 1, timestamp: Date.parse("2026-05-13T12:00:00Z") / 1_000 });
  const result = extractGoogleFinanceEarnings(rpc([old, latest, latest]), INSTRUMENT, NOW.toISOString());
  assert.equal(result.length, 2);
  assert.equal(result[0].reportDate, "2026-08-12");
  assert.equal(result[1].reportDate, "2026-05-13");
});

test("fails closed for schema drift, wrong listing, invalid dates and executable text", () => {
  for (const body of [
    rpc([row({ symbol: "MU" })]), rpc([row({ exchange: "NYSE" })]),
    rpc([row({ values: { 0: "582300000" } })]), rpc([row({ values: { 17: [2026, 2, 31] } })]),
    rpc([], "unrelated-rpc"), rpc([["changed schema"]]),
    `)]}'\n[["wrb.fr","wKsYyb","(()=>{throw new Error('must not run')})()"]]`,
    "<html>consent required</html>",
  ]) assert.throws(() => extractGoogleFinanceEarnings(body, INSTRUMENT, NOW.toISOString()), errorCode("invalid_response"));
  assert.deepEqual(extractGoogleFinanceEarnings(rpc([]), INSTRUMENT, NOW.toISOString()), []);
});

test("requests only the fixed public RPC without cookies, API keys or redirects", async () => {
  const provider = createGoogleFinanceEarningsProvider({}, {
    now: () => NOW,
    fetch: async (input, init) => {
      assert.equal(String(input), "https://www.google.com/finance/beta/_/FinHubUi/data/batchexecute?rpcids=wKsYyb&hl=en");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("authorization"), null);
      const packet = JSON.parse(new URLSearchParams(String(init?.body)).get("f.req")!);
      assert.deepEqual(packet, [[["wKsYyb", '[[null,["NBIS","NASDAQ"]]]', null, "generic"]]]);
      return response();
    },
  });
  assert.deepEqual(provider.manifest.capabilities, ["fundamentals.earnings"]);
  assert.deepEqual(googleFinanceEarningsProviderRegistration.manifest.requiredEnv, []);
  assert.equal((await provider.fundamentals!.getEarnings(INSTRUMENT, CONTEXT)).length, 1);
});

test("accepts class-share notation but rejects unsupported exchanges and malformed symbols before network", async () => {
  let calls = 0;
  const provider = createGoogleFinanceEarningsProvider({}, { fetch: async (_input, init) => {
    calls += 1;
    assert.match(String(init?.body), /BRK/);
    return response(rpc([row({ symbol: "BRK.B", exchange: "NYSE" })]));
  } });
  await provider.fundamentals!.getEarnings({ ...INSTRUMENT, symbol: "BRK-B", exchangeMic: "XNYS" }, CONTEXT);
  for (const instrument of [
    { ...INSTRUMENT, symbol: "NBIS?rpcids=other" },
    { ...INSTRUMENT, exchangeMic: "XLON" },
    { ...INSTRUMENT, currency: "EUR" } as unknown as Instrument,
  ]) await assert.rejects(provider.fundamentals!.getEarnings(instrument, CONTEXT), errorCode("invalid_request"));
  assert.equal(calls, 1);
});

test("deduplicates in-flight calls, caches results and supports expiry and explicit fresh refresh", async () => {
  let calls = 0;
  let current = NOW.getTime();
  const provider = createGoogleFinanceEarningsProvider({}, {
    now: () => new Date(current), cacheTtlMs: 100,
    fetch: async () => { calls += 1; return response(); },
  });
  const get = (fresh = false) => provider.fundamentals!.getEarnings(INSTRUMENT, { ...CONTEXT, fresh });
  await Promise.all([get(), get(), get()]);
  assert.equal(calls, 1);
  await get();
  assert.equal(calls, 1);
  await get(true);
  assert.equal(calls, 2);
  current += 101;
  await get();
  assert.equal(calls, 3);
});

test("one caller abort does not cancel a shared request or another caller", async () => {
  let resolveResponse!: (value: Response) => void;
  const provider = createGoogleFinanceEarningsProvider({}, { fetch: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  const controller = new AbortController();
  const first = provider.fundamentals!.getEarnings(INSTRUMENT, { ...CONTEXT, signal: controller.signal });
  const second = provider.fundamentals!.getEarnings(INSTRUMENT, CONTEXT);
  controller.abort();
  await assert.rejects(first, errorCode("aborted"));
  resolveResponse(response());
  assert.equal((await second).length, 1);
});

test("bounds request and body wait duration, with safe upstream errors and failed-request retry", async () => {
  const stalled = createGoogleFinanceEarningsProvider({}, { timeoutMs: 5, fetch: () => new Promise(() => undefined) });
  await assert.rejects(stalled.fundamentals!.getEarnings(INSTRUMENT, CONTEXT), errorCode("timeout"));
  const stalledBody = createGoogleFinanceEarningsProvider({}, { timeoutMs: 5, fetch: async () => new Response(new ReadableStream()) });
  await assert.rejects(stalledBody.fundamentals!.getEarnings(INSTRUMENT, CONTEXT), errorCode("timeout"));
  let calls = 0;
  const failed = createGoogleFinanceEarningsProvider({}, { fetch: async () => {
    calls += 1;
    return calls === 1 ? response("secret upstream body", 403) : response();
  } });
  await assert.rejects(failed.fundamentals!.getEarnings(INSTRUMENT, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof GoogleFinanceEarningsError);
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal((await failed.fundamentals!.getEarnings(INSTRUMENT, CONTEXT)).length, 1);
});

test("rejects oversized bodies and oversized result sets", async () => {
  const provider = createGoogleFinanceEarningsProvider({}, { maxResponseBytes: 1_000, fetch: async () => response(" ".repeat(1_001)) });
  await assert.rejects(provider.fundamentals!.getEarnings(INSTRUMENT, CONTEXT), errorCode("invalid_response"));
  assert.throws(() => extractGoogleFinanceEarnings(rpc(Array.from({ length: 101 }, () => row())), INSTRUMENT, NOW.toISOString()), errorCode("invalid_response"));
});

test("rejects redirects without following them using the Workers-compatible redirect mode", async () => {
  let calls = 0;
  const provider = createGoogleFinanceEarningsProvider({}, {
    fetch: async (_input, init) => {
      calls += 1;
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://example.com/unexpected-target" } });
    },
  });
  await assert.rejects(provider.fundamentals!.getEarnings(INSTRUMENT, CONTEXT), (error: unknown) => {
    assert.ok(error instanceof GoogleFinanceEarningsError);
    assert.equal(error.code, "upstream");
    assert.equal(error.status, 302);
    assert.doesNotMatch(error.message, /unexpected-target/);
    return true;
  });
  assert.equal(calls, 1);
});
