import assert from "node:assert/strict";
import test from "node:test";
import { getMacroDataset, parseFearGreedDataset, parseFredDataset } from "../api/direct-sources/macro.server";
import { cachedSource, DirectSourceError, fetchSourceJson, fetchSourceText } from "../api/direct-sources/client.server";
import { directSourceResponse } from "../api/direct-sources/route.server";
import { readFileSync } from "node:fs";

const fetchedAt = "2026-09-06T00:00:00Z";
const metadata = { seriess: [{ id: "DGS10", units: "Percent", frequency: "Daily" }] };
const observation = { date: "2026-09-03", value: "4.77", realtime_start: "2026-09-04", realtime_end: "2026-09-04" };
const fred = { count: 120, observations: [observation] };

test("FRED preserves raw percent units, missing observations, and bounded history", () => {
  const data = parseFredDataset({ ...fred, observations: [observation, { ...observation, date: "2026-09-02", value: "." }] }, metadata, "DGS10", fetchedAt);
  assert.equal(data.rows[0].value, 4.77);
  assert.equal(data.rows[0].unit, "Percent");
  assert.equal(data.rows[1].value, null);
  assert.equal(data.coverage.status, "partial");
  assert.equal(data.fetchedAt, fetchedAt);
});

test("FRED rejects wrong series metadata, duplicate dates, invalid numbers and revision windows", () => {
  assert.throws(() => parseFredDataset(fred, { seriess: [{ id: "WRONG" }] }, "DGS10", fetchedAt), DirectSourceError);
  for (const value of ["NaN", " ", "Infinity", "4.7oops"]) assert.throws(() => parseFredDataset({ ...fred, observations: [{ ...observation, value }] }, metadata, "DGS10", fetchedAt));
  assert.throws(() => parseFredDataset({ ...fred, observations: [observation, observation] }, metadata, "DGS10", fetchedAt));
  assert.throws(() => parseFredDataset({ ...fred, observations: [{ ...observation, date: "2019-01-01" }] }, metadata, "DGS10", fetchedAt, "2020-01-01"));
  assert.throws(() => parseFredDataset({ ...fred, observations: [{ ...observation, date: "2026-02-30" }] }, metadata, "DGS10", fetchedAt));
});

test("FRED applies vintage to metadata and values and keeps credentials out of normalized data", async () => {
  const urls: URL[] = [];
  const data = await getMacroDataset("fred", { series: "DGS10", date: "2026-09-04" }, {
    environment: { FRED_API_KEY: "private-test-key" }, now: () => new Date(fetchedAt),
    fetch: (async input => {
      const url = new URL(String(input)); urls.push(url);
      return Response.json(url.pathname.endsWith("/observations") ? fred : metadata);
    }) as typeof fetch,
  });
  assert.equal(urls.length, 2);
  for (const url of urls) { assert.equal(url.searchParams.get("realtime_start"), "2026-09-04"); assert.equal(url.searchParams.get("realtime_end"), "2026-09-04"); }
  assert.equal(urls[1].searchParams.get("limit"), "100");
  assert.equal(JSON.stringify(data).includes("private-test-key"), false);
});

test("FRED missing credentials and invalid series fail before fetching", async () => {
  let calls = 0;
  const options = { environment: {}, fetch: (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch };
  await assert.rejects(getMacroDataset("fred", {}, options), { code: "configuration_required" });
  await assert.rejects(getMacroDataset("fred", { series: "https://untrusted" }, options), { code: "invalid_request" });
  assert.equal(calls, 0);
});

test("CNN retains source time, enforces 0–100, and does not invent dates or missing scores", () => {
  const payload = { fear_and_greed: { score: 53.4, rating: "neutral", timestamp: "2026-09-04T20:00:00+00:00", previous_close: 0 } };
  const data = parseFearGreedDataset(payload, fetchedAt);
  assert.equal(data.rows[0].score, 53.4);
  assert.equal(data.rows[0].previousClose, 0);
  assert.equal(data.rows[0].week, null);
  assert.equal(data.rows[0].sourceTime, "2026-09-04T20:00:00.000Z");
  for (const score of [-1, 101, "", null]) assert.throws(() => parseFearGreedDataset({ fear_and_greed: { ...payload.fear_and_greed, score } }, fetchedAt));
  assert.throws(() => parseFearGreedDataset({ fear_and_greed: { ...payload.fear_and_greed, timestamp: "2026-09-04" } }, fetchedAt));
});

test("Transport bounds response streams and redacts upstream errors", async () => {
  await assert.rejects(fetchSourceText("https://source.example/data", { maxBytes: 4, fetch: (async () => new Response("too long")) as typeof fetch }), { code: "invalid_response" });
  await assert.rejects(fetchSourceJson("https://source.example/data", { fetch: (async () => new Response("not JSON")) as typeof fetch }), { code: "invalid_response" });
  await assert.rejects(fetchSourceText("https://source.example/?api_key=secret", { fetch: (async () => { throw new Error("secret raw body"); }) as typeof fetch }), error => error instanceof DirectSourceError && !error.message.includes("secret"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchSourceText("https://source.example", { signal: controller.signal }), { code: "unavailable" });
});

test("Transport deadline covers stalled bodies and fetch implementations that ignore abort", async () => {
  await assert.rejects(fetchSourceText("https://source.example", { timeoutMs: 5, fetch: (async () => new Promise<Response>(() => {})) as typeof fetch }), { code: "timeout" });
  await assert.rejects(fetchSourceText("https://source.example", { timeoutMs: 5, fetch: (async () => new Response(new ReadableStream())) as typeof fetch }), { code: "timeout" });
});

test("Cache deduplicates concurrent reads and retries failed loads", async () => {
  let calls = 0;
  const load = async () => { calls++; return { rows: [1] }; };
  const [one, two] = await Promise.all([cachedSource("test:one", 1000, load), cachedSource("test:one", 1000, load)]);
  assert.deepEqual(one, two); assert.equal(calls, 1);
  await assert.rejects(cachedSource("test:failure", 1000, async () => { throw new Error("fail"); }));
  assert.equal(await cachedSource("test:failure", 1000, async () => "retry"), "retry");
});

test("Cancelling one source request does not fail another caller for the same dataset", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = cachedSource("test:cancel", 1000, async () => {
    first.abort();
    throw new DirectSourceError("unavailable");
  }, first.signal);
  const surviving = cachedSource("test:cancel", 1000, async () => "second result", second.signal);
  await assert.rejects(cancelled, { code: "unavailable" });
  assert.equal(await surviving, "second result");
});

test("Research route rejects unregistered sources, duplicate and unknown parameters before loading", async () => {
  let calls = 0;
  const options = { load: async () => { calls++; return parseFredDataset(fred, metadata, "DGS10", fetchedAt); } };
  for (const [id, suffix, status] of [["unknown", "", 404], ["finra-short-volume", "?symbol=AAPL", 400], ["sec-filings", "?symbol=AAPL&symbol=MSFT", 400], ["fred", "?url=https://untrusted", 400], ["fred", "?date=2026-02-30", 400], ["usaspending", "?symbol=LMT", 400]] as const) {
    const response = await directSourceResponse(new Request(`http://localhost/api${suffix}`), id, options);
    assert.equal(response.status, status);
  }
  assert.equal(calls, 0);
});

test("Research route sanitizes even adapter errors with sensitive custom messages", async () => {
  const response = await directSourceResponse(new Request("http://localhost/api?series=DGS10"), "fred", { load: async () => { throw new DirectSourceError("unavailable", "private-key raw upstream response"); } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.text()).includes("private-key"), false);
});

test("Build configuration confines local credential bindings to the development server", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /vars: command === "serve" \? providerBindings\(mode\) : \{\}/);
});
