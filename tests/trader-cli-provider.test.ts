import assert from "node:assert/strict";
import test from "node:test";
import { DATA_CATALOG, DATA_CATALOG_VERSION } from "../src/tooling/data-catalog";
import { describeData } from "../api/data/discovery";
import { runTraderCli, type TraderCliDependencies } from "../src/tooling/scripts/trader-cli";

type CapturedRequest = { url: string; init?: RequestInit };
function harness(options: { payload?: unknown; response?: Response; fetch?: typeof fetch; env?: Record<string, string | undefined>; strategy?: TraderCliDependencies["strategy"] } = {}) {
  const requests: CapturedRequest[] = [];
  let stdout = "", stderr = "";
  const dependencies: TraderCliDependencies = {
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return options.fetch ? options.fetch(input, init) : options.response ?? Response.json(options.payload ?? { ok: true });
    },
    stdout: { write: value => { stdout += value; } },
    stderr: { write: value => { stderr += value; } },
    env: options.env ?? {},
    ...(options.strategy ? { strategy: options.strategy } : {}),
  };
  return { requests, dependencies, stdout: () => stdout, stderr: () => stderr };
}
const optionsHistory = ["data", "get", "options-history", "--symbol", "NBIS", "--contract", "NBIS270115C00200000"];
async function invalid(args: string[]) {
  const capture = harness();
  assert.equal(await runTraderCli(args, capture.dependencies), 2, args.join(" "));
  assert.equal(capture.requests.length, 0, "invalid arguments cannot make an HTTP request");
  assert.equal(capture.stdout(), "");
  const error = JSON.parse(capture.stderr());
  assert.equal(error.ok, false);
  assert.equal(error.code, "invalid_arguments");
  assert.equal(typeof error.message, "string");
}

test("data sources and describe are offline JSON capability catalogs with usable history semantics", async () => {
  const sources = harness();
  assert.equal(await runTraderCli(["data", "sources"], sources.dependencies), 0);
  assert.equal(sources.requests.length, 0);
  assert.equal(sources.stderr(), "");
  const catalog = JSON.parse(sources.stdout());
  assert.equal(catalog.schemaVersion, DATA_CATALOG_VERSION);
  assert.deepEqual(catalog.datasets, JSON.parse(JSON.stringify(DATA_CATALOG.map(item => describeData(item.id)))));
  assert.equal(new Set(catalog.datasets.map((item: { id: string }) => item.id)).size, catalog.datasets.length);
  const definition = catalog.datasets.find((item: { id: string }) => item.id === "options-history");
  assert.equal(definition.path, "/api/v1/symbols/:symbol/options/prices");
  assert.deepEqual(definition.parameters.source.values, ["chartexchange", "yahoo"]);
  assert.equal(definition.parameters.contract.query, "contractId");
  assert.match(definition.response, /filteredCoverage.*coverage still describes the unfiltered/);
  assert.match(definition.notes.join(" "), /publication timing is unverified/);
  for (const id of ["options-history", "source-status", "financials"]) {
    const description = harness();
    assert.equal(await runTraderCli(["data", "describe", id], description.dependencies), 0);
    assert.equal(description.requests.length, 0);
    const actual = JSON.parse(description.stdout());
    assert.deepEqual(actual, { schemaVersion: DATA_CATALOG_VERSION, ...catalog.datasets.find((item: { id: string }) => item.id === id) });
    assert.equal(description.stderr(), "");
  }
});

test("data get performs exactly one GET and emits native JSON including provenance, omissions, zero and partial status", async () => {
  const payload = {
    symbol: "NBIS", contractId: "NBIS270115C00200000", source: "ChartExchange", sourceUrl: "https://chartexchange.com/symbol/opra-nbis20270115c200/historical/",
    fetchedAt: "2026-09-06T04:00:00Z", sourceAsOf: null, openInterestDateBasis: "source_session_date_unverified",
    items: [{ date: "2026-08-03", openInterest: 0 }, { date: "2026-08-04" }], status: "partial",
    coverage: { firstDate: "2025-10-13", returnedBars: 225 }, filteredCoverage: { returnedBars: 2, observedBars: 1, missingBars: 1 },
    warnings: ["source dates are unverified"], extraProviderField: { untouched: true },
  };
  const capture = harness({ payload });
  assert.equal(await runTraderCli([...optionsHistory, "--source", "chartexchange", "--from", "2026-08-01", "--to", "2026-08-31"], capture.dependencies), 0);
  assert.equal(capture.requests.length, 1);
  const request = capture.requests[0];
  const url = new URL(request.url);
  assert.equal(url.origin, "http://localhost:3001");
  assert.equal(url.pathname, "/api/v1/data/options-history");
  assert.deepEqual(Object.fromEntries(url.searchParams), { symbol: "NBIS", contract: "NBIS270115C00200000", source: "chartexchange", from: "2026-08-01", to: "2026-08-31" });
  assert.equal(request.init?.method, "GET");
  assert.equal(request.init?.body, undefined);
  assert.equal(request.init?.cache, "no-store");
  assert.equal(new Headers(request.init?.headers).get("accept"), "application/json");
  assert.deepEqual(JSON.parse(capture.stdout()), payload);
  assert.equal(capture.stderr(), "");
});

test("explicit Yahoo and one-sided windows are passed through without substituting a source or inferring date bounds", async () => {
  for (const dates of [["--from", "2020-01-01"], ["--to", "2026-08-31"], ["--from", "2026-08-31", "--to", "2026-08-31"]]) {
    const payload = { source: "Yahoo Finance", items: [], sourceAsOf: null, coverage: { returnedBars: 0 }, warnings: ["No observations returned"] };
    const capture = harness({ payload });
    assert.equal(await runTraderCli([...optionsHistory, "--source=yahoo", ...dates], capture.dependencies), 0);
    assert.equal(capture.requests.length, 1);
    const query = new URL(capture.requests[0].url).searchParams;
    assert.equal(query.get("source"), "yahoo");
    assert.equal(query.get("from"), dates.includes("--from") ? dates[dates.indexOf("--from") + 1] : null);
    assert.equal(query.get("to"), dates.includes("--to") ? dates[dates.indexOf("--to") + 1] : null);
    assert.deepEqual(JSON.parse(capture.stdout()), payload);
    assert.equal(capture.stderr(), "");
  }
});

test("expired option tuples and decimal strikes generate exact OCC contract IDs without a current-chain lookup", async () => {
  for (const [symbol, expiration, side, strike, expected] of [
    [" nbis ", "2025-04-17", "put", "89", "NBIS250417P00089000"],
    ["NBIS", "2026-09-11", "call", "227.5", "NBIS260911C00227500"],
    ["NBIS", "2026-09-11", "put", "0.001", "NBIS260911P00000001"],
    ["MU", "2026-09-09", "call", "915.125", "MU260909C00915125"],
  ]) {
    const capture = harness();
    assert.equal(await runTraderCli(["data", "get", "options-history", "--symbol", symbol, "--expiration", expiration, "--side", side, "--strike", strike], capture.dependencies), 0);
    assert.equal(capture.requests.length, 1);
    const url = new URL(capture.requests[0].url);
    assert.equal(url.searchParams.get("contract"), expected);
    assert.equal(url.pathname, "/api/v1/data/options-history");
    assert.equal(url.searchParams.get("symbol"), symbol.trim().toUpperCase());
    assert.deepEqual([...url.searchParams.keys()], ["symbol", "contract"]);
  }
});

test("invalid datasets, unknown or duplicate flags and excess arguments fail before HTTP", async () => {
  for (const args of [
    ["data", "get", "unknown"], ["data", "sources", "extra"], ["data", "sources", "--base-url", "http://localhost:3001"],
    ["data", "describe", "options-history", "--symbol", "NBIS"], ["data", "get", "quote"],
    [...optionsHistory, "--unknown", "x"], [...optionsHistory, "--source", "yahoo", "--source", "yahoo"],
    [...optionsHistory, "--symbol", "MU"], [...optionsHistory, "--from"], [...optionsHistory, "extra"],
    [...optionsHistory, "--constructor", "x"], [...optionsHistory, "--toString", "x"], [...optionsHistory, "--__proto__", "x"],
  ]) await invalid(args);
});

test("invalid option identity, incomplete or conflicting tuple, source and date windows fail before HTTP", async () => {
  for (const suffix of [
    ["--contract", "MU270115C00200000"], ["--contract", "NBIS270231C00200000"],
    ["--expiration", "2025-04-17", "--side", "put"], ["--expiration", "2025-04-17", "--side", "put", "--strike", "0"],
    ["--expiration", "2025-04-17", "--side", "call", "--strike", "100000"],
    ["--expiration", "2025-04-17", "--side", "put", "--strike", "1.0001"],
    ["--expiration", "2025-04-17", "--side", "put", "--strike", "1e2"],
    ["--expiration", "2025-02-29", "--side", "put", "--strike", "89"],
    ["--expiration", "1999-04-17", "--side", "put", "--strike", "89"],
    ["--contract", "NBIS270115C00200000", "--strike", "200"],
  ]) await invalid(["data", "get", "options-history", "--symbol", "NBIS", ...suffix]);
  for (const suffix of [
    ["--source", "unknown"], ["--from", "2026-02-31"], ["--to", "2026-13-01"],
    ["--from", "2026-09-04", "--to", "2026-09-03"], ["--to", "2026-9-03"],
    ["--from=2026-09-01", "--from=2026-09-01"], ["--to="],
  ]) await invalid([...optionsHistory, ...suffix]);
});

test("origin precedence is explicit flag over environment over localhost, and unsafe origins are refused", async () => {
  const payload = { sources: [{ id: "fred", configured: false, credential: "FRED_API_KEY" }] };
  for (const [args, env, origin] of [
    [[], {}, "http://localhost:3001"],
    [[], { TRADER_BASE_URL: "http://127.0.0.1:3999" }, "http://127.0.0.1:3999"],
    [["--base-url", "https://trader.example"], { TRADER_BASE_URL: "http://127.0.0.1:3999" }, "https://trader.example"],
  ] as const) {
    const capture = harness({ payload, env });
    assert.equal(await runTraderCli(["data", "get", "source-status", ...args], capture.dependencies), 0);
    assert.equal(capture.requests.length, 1);
    assert.equal(capture.requests[0].url, `${origin}/api/v1/data/source-status`);
    assert.deepEqual(JSON.parse(capture.stdout()), payload);
  }
  for (const origin of ["file:///etc/passwd", "http://user:secret@localhost:3001", "http://localhost:3001/api", "http://localhost:3001?token=x", "http://localhost:3001/#fragment"]) {
    await invalid(["data", "get", "source-status", "--base-url", origin]);
  }
});

test("financial section and bars requests use documented API parameters and preserve source configuration/provenance", async () => {
  const payload = { status: "partial", dataMode: "fixture", selectedProviders: { research: "yahoo" }, research: null, warnings: ["research unavailable"] };
  const financials = harness({ payload });
  assert.equal(await runTraderCli(["data", "get", "financials", "--symbol", "nbis", "--fresh"], financials.dependencies), 0);
  assert.equal(financials.requests[0].url, "http://localhost:3001/api/v1/data/financials?symbol=NBIS&fresh=1");
  assert.deepEqual(JSON.parse(financials.stdout()), payload);
  const bars = harness({ payload: { bars: { items: [], provenance: { providerId: "tradingview" } }, returnedCount: 0 } });
  assert.equal(await runTraderCli(["data", "get", "bars", "--symbol", "NBIS", "--range", "5y", "--interval", "1d", "--count", "10000"], bars.dependencies), 0);
  assert.equal(new URL(bars.requests[0].url).search, "?symbol=NBIS&range=5y&interval=1d&count=10000");
  assert.deepEqual(JSON.parse(bars.stdout()).bars.items, []);
  for (const suffix of [["--count", "10001"], ["--interval", "2h"], ["--fresh=0"]]) await invalid(["data", "get", "bars", "--symbol", "NBIS", ...suffix]);
});

test("HTTP and API errors use JSON stderr with a nonzero exit and no success output or retry", async () => {
  for (const [status, payload, expectedCode] of [
    [503, { error: { code: "unavailable", message: "Source unavailable" } }, "unavailable"],
    [200, { error: { code: "invalid_request", message: "Bad request" } }, "invalid_request"],
    [404, { message: "Missing route" }, "api_error"],
  ] as const) {
    const capture = harness({ response: Response.json(payload, { status }) });
    assert.equal(await runTraderCli(optionsHistory, capture.dependencies), 1);
    assert.equal(capture.requests.length, 1);
    assert.equal(capture.stdout(), "");
    const error = JSON.parse(capture.stderr());
    assert.equal(error.ok, false);
    assert.equal(error.status, status);
    assert.equal(error.code, expectedCode);
  }
});

test("non-JSON and malformed JSON responses never leak body text to stdout or stderr", async () => {
  for (const response of [new Response("<html>private fixture body</html>"), new Response('{"broken":'), Response.json(null), Response.json([1, 2]), new Response(null, { status: 204 })]) {
    const capture = harness({ response });
    assert.equal(await runTraderCli(optionsHistory, capture.dependencies), 1);
    assert.equal(capture.stdout(), "");
    assert.equal(JSON.parse(capture.stderr()).code, "invalid_response");
    assert.doesNotMatch(capture.stderr(), /private fixture body|broken/);
    assert.equal(capture.requests.length, 1);
  }
});

test("network failures are sanitized and timeouts abort the request without outputting a partial success", async () => {
  const network = harness({ fetch: async () => { throw new Error("private URL or token"); } });
  assert.equal(await runTraderCli(optionsHistory, network.dependencies), 1);
  assert.equal(network.stdout(), "");
  assert.equal(JSON.parse(network.stderr()).code, "network_error");
  assert.doesNotMatch(network.stderr(), /private URL|token/);
  assert.equal(network.requests.length, 1);
  const timeout = harness({ fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    // The referenced guard prevents an unref'd AbortSignal timer from ending the test process early.
    const guard = setTimeout(() => reject(new Error("test guard")), 500);
    const abort = () => { clearTimeout(guard); reject(new Error("aborted")); };
    if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
  }) });
  assert.equal(await runTraderCli([...optionsHistory, "--timeout-ms", "5"], timeout.dependencies), 1);
  assert.equal(timeout.requests.length, 1);
  assert.equal(timeout.requests[0].init?.signal?.aborted, true);
  assert.equal(timeout.stdout(), "");
  assert.equal(JSON.parse(timeout.stderr()).code, "timeout");
  for (const value of ["0", "-1", "120001", "1.5"]) await invalid([...optionsHistory, "--timeout-ms", value]);
});

test("oversized responses are rejected before success output", async () => {
  const capture = harness({ response: new Response("{}", { headers: { "content-length": String(20 * 1024 * 1024 + 1) } }) });
  assert.equal(await runTraderCli(optionsHistory, capture.dependencies), 1);
  assert.equal(capture.stdout(), "");
  assert.equal(JSON.parse(capture.stderr()).code, "invalid_response");
  assert.equal(capture.requests.length, 1);
});

test("strategy commands are delegated without data parsing or changed exit codes", async () => {
  const calls: string[][] = [];
  const capture = harness({ strategy: async args => { calls.push([...args]); return 7; } });
  const args = ["compare", "custom.alpha", "--sort", "sharpe", "--limit", "2"];
  assert.equal(await runTraderCli(["strategy", ...args], capture.dependencies), 7);
  assert.deepEqual(calls, [args]);
  assert.equal(capture.requests.length, 0);
  assert.equal(capture.stdout(), "");
  assert.equal(capture.stderr(), "");
});

test("the default strategy bridge retains the existing read-only list route and validation", async () => {
  const capture = harness({ payload: { schemaVersion: "trader.strategies.v1", ownerId: "test-owner", strategies: [] } });
  assert.equal(await runTraderCli(["strategy", "list", "--locale", "ja"], capture.dependencies), 0);
  assert.equal(capture.requests.length, 1);
  assert.equal(capture.requests[0].url, "http://localhost:3001/api/v1/strategies?locale=ja");
  assert.equal(capture.requests[0].init?.method, "GET");
  assert.equal(capture.stderr(), "");
  assert.deepEqual(JSON.parse(capture.stdout()).strategies, []);
  const bad = harness();
  assert.equal(await runTraderCli(["strategy", "list", "--order", "desc"], bad.dependencies), 2);
  assert.equal(bad.requests.length, 0);
  assert.match(bad.stderr(), /--order requires --sort/);
});
