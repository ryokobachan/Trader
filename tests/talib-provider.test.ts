import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedJson, createTalibClient, TalibError, validateTalibCalculation, validateTalibCatalog } from "../api/indicators/talib.server";

const env = { TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8765", TRADER_TRADINGVIEW_SIDECAR_TOKEN: "test-only-token" };
const definition = { id: "RSI", name: "Relative Strength Index", group: "Momentum Indicators", parameters: { timeperiod: 14 }, inputs: { price: "close" }, lookback: 14 };
const base = { schemaVersion: "trader.talib.v1", engine: "TA-Lib", version: "0.6.8" };
const bars = [{ time: "2026-09-01", open: 10, high: 12, low: 9, close: 11, volume: 100 }];
const response = { ...base, times: [bars[0].time], barCount: 1, results: [{ ...definition, series: [{ name: "real", values: [null] }] }] };
const payload = { bars, indicators: [{ id: "RSI", parameters: { timeperiod: 14 } }] };

test("TA-Lib calculation keeps warm-up nulls, input labels and credential boundary", async () => {
  const client = createTalibClient(env, async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:8765/v1/indicators/calculate");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-only-token");
    assert.equal(init?.redirect, "manual");
    assert.deepEqual(JSON.parse(String(init?.body)), payload);
    return Response.json(response);
  });
  assert.deepEqual(await client.calculate(payload), response);
});

test("TA-Lib configuration refuses missing tokens, credentials in URLs and plaintext remote helpers", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({}); };
  for (const settings of [{}, { ...env, TRADER_TRADINGVIEW_SIDECAR_TOKEN: "" }, { ...env, TRADER_TRADINGVIEW_SIDECAR_URL: "http://remote.test" },
    { ...env, TRADER_TRADINGVIEW_SIDECAR_URL: "https://user:password@example.test" }]) {
    await assert.rejects(createTalibClient(settings, fetcher).catalog(), (error: unknown) => error instanceof TalibError && error.code === "configuration_required");
  }
  assert.equal(calls, 0);
});

test("TA-Lib rejects misaligned, non-finite and wrong-source helper results", async () => {
  for (const value of [ { ...response, barCount: 2 }, { ...response, engine: "mock" },
    { ...response, results: [{ ...definition, series: [{ name: "real", values: [Number.NaN] }] }] },
    { ...response, results: [{ ...definition, series: [{ name: "real", values: [] }] }] }]) {
    assert.throws(() => validateTalibCalculation(value), TalibError);
  }
  for (const value of [{ ...response, times: ["2026-09-02"] }, { ...response, results: [{ ...response.results[0], id: "CCI" }] },
    { ...response, results: [{ ...response.results[0], parameters: { timeperiod: 21 } }] }]) {
    await assert.rejects(createTalibClient(env, async () => Response.json(value)).calculate(payload), TalibError);
  }
});

test("TA-Lib catalog carries native parameter/input/output definitions", () => {
  const value = { ...base, indicators: [{ ...definition, outputs: ["real"] }], limits: { maxBars: 10000, maxIndicators: 8, maxPeriod: 10000 } };
  assert.deepEqual(validateTalibCatalog(value), value);
  assert.throws(() => validateTalibCatalog({ ...value, indicators: [] }), TalibError);
});

test("TA-Lib helper errors remain sanitized and capacity differs from invalid parameters", async () => {
  for (const [status, code] of [[302, "unavailable"], [400, "invalid_request"], [429, "capacity"], [500, "unavailable"]] as const) {
    await assert.rejects(createTalibClient(env, async () => new Response("private upstream message", { status })).calculate(payload),
      (error: unknown) => error instanceof TalibError && error.code === code && !error.message.includes("private"));
  }
});

test("TA-Lib bounded JSON rejects declared and streamed oversized bodies", async () => {
  await assert.rejects(boundedJson(new Response("{}", { headers: { "Content-Length": "1000" } }), 10), TalibError);
  await assert.rejects(boundedJson(new Response("12345678901"), 10), TalibError);
  await assert.rejects(boundedJson(new Response("NaN"), 10), TalibError);
  assert.deepEqual(await boundedJson(new Response("{\"ok\":1}"), 20), { ok: 1 });
});
