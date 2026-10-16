import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, dump, JSON_SCHEMA } from "js-yaml";
import { test, type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DATA_CATALOG } from "../src/tooling/data-catalog";
import { MCP_SERVERS, type McpServerId } from "../src/tooling/mcp/servers";
import { createTraderMcpServer, localBaseUrl } from "../src/tooling/mcp/server";

import { readToolDefinitions } from "../src/tooling/mcp/definitions";
import { TraderDataClient } from "../clients/javascript/trader-data.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = (id: McpServerId) => path.join(root, "mcp", MCP_SERVERS[id].folder, "server.mjs");
const ids = Object.keys(MCP_SERVERS) as McpServerId[];
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function mockApi(t: TestContext, handler: Handler) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function connect(t: TestContext, id: McpServerId, baseUrl: string, timeoutMs = 2000, modern = false, editYaml?: (text: string) => string) {
  if (id === "market") {
    // Protocol/validation tests inject a fixture reader. Production Market cannot use --base-url.
    const server = createTraderMcpServer("market", { reader: new TraderDataClient({ baseUrl, timeoutMs }), definitions: readToolDefinitions("market", path.join(path.dirname(executable("market")), "tools.yaml")) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-contract-test", version: "1.0.0" }, modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(b);
    await client.connect(a);
    return client;
  }
  // The distributed folder must work outside the repository, without node_modules.
  const isolated = await mkdtemp(path.join(tmpdir(), "trader-mcp-"));
  t.after(() => rm(isolated, { recursive: true, force: true }));
  await cp(path.dirname(executable(id)), path.join(isolated, "mcp"), { recursive: true });
  if (editYaml) {
    const file = path.join(isolated, "mcp", "tools.yaml");
    await writeFile(file, editYaml(await readFile(file, "utf8")));
  }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(isolated, "mcp", "server.mjs"), "--base-url", baseUrl, "--timeout-ms", String(timeoutMs)], cwd: isolated, stderr: "pipe", env: { NODE_PATH: "", NODE_OPTIONS: "" } });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "trader-mcp-test", version: "1.0.0" }, modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
  t.after(async () => { await client.close(); assert.equal(stderr, "", "normal MCP traffic must not produce diagnostics"); });
  await client.connect(transport);
  return client;
}

function page(dataset: string) {
  return { schemaVersion: "trader.shared-data.v1", dataset, status: "ok",
    rows: [], columns: [], dataMode: "fixture", source: { id: "fixture" },
    provenance: { revision: "revision-1", publishedAt: "2026-09-01T00:00:00Z", validation: "test-marker" },
    coverage: { status: "partial", returned: 0 }, pagination: { limit: 1, nextCursor: "next_page" },
    warnings: ["Fixture; empty page still has a cursor."], missingValue: null };
}

// Native response fixtures, deliberately independent of the YAML schemas.
function nativeData(dataset: string): Record<string, unknown> {
  const asOf = "2026-09-01T00:00:00Z";
  const provenance = { providerId: "fixture", sourceId: "fixture", asOf, ingestedAt: asOf };
  const instrument = { instrumentId: "AAPL", symbol: "AAPL", name: "Apple", assetType: "common_stock", active: true,
    listingCountry: "US", exchange: "NASDAQ", exchangeMic: "XNAS", currency: "USD", provenance };
  const quote = { instrumentId: "AAPL", price: 100, change: 0, changePercent: 0, previousClose: 100,
    open: 100, high: 101, low: 99, volume: 10, currency: "USD", marketState: "closed", delaySeconds: 0, provenance };
  const selectedProviders = { instrument: "fixture", market: "fixture", analyst: "fixture" };
  const base = { instrument, selectedProviders, dataMode: "fixture", asOf };
  if (dataset === "quote") return { ...base, schemaVersion: "trader.symbol-summary.v1", quote };
  if (dataset === "bars") return { ...base, schemaVersion: "trader.market-bars.v1", requestedCount: null, returnedCount: 1,
    bars: { instrumentId: "AAPL", interval: "1d", range: "1y", adjustment: "raw", provenance,
      items: [{ time: "2026-09-01", open: 100, high: 101, low: 99, close: 100, volume: 10 }] } };
  if (["workspace", "profile", "fundamentals", "financials", "earnings", "analyst", "news", "research", "corporate-actions"].includes(dataset)) {
    return { ...base, schemaVersion: "trader.symbol-workspace.v1", quote, profile: null, fundamentals: null, earnings: [], analyst: null, news: [], research: null, status: "partial", warnings: ["fixture"] };
  }
  if (dataset === "analyst-ratings") return { ...base, schemaVersion: "trader.analyst-rating-history.v1",
    history: { instrumentId: "AAPL", symbol: "AAPL", dateFrom: "2026-01-01", dateTo: "2026-09-01", pageSize: 100, items: [], provenance } };
  if (dataset === "options-chain") return { symbol: "AAPL", currency: "USD", expiration: null, expirations: [], range: "all", contracts: [],
    source: "Nasdaq", sourceUrl: "https://example.com", greeksSourceUrl: "https://example.com", fetchedAt: asOf, truncated: false, greeksAvailable: false, impliedVolatilityAvailable: false };
  if (dataset === "options-history") return { symbol: "NBIS", contractId: "NBIS250417P00089000", expiration: "2025-04-17", side: "put", strike: 89,
    underlying: { symbol: "NBIS" }, source: "Yahoo Finance", sourceUrl: "https://example.com", fetchedAt: asOf, sourceAsOf: null, currency: "USD", timezone: "America/New_York",
    interval: "1d", requestedRange: "1y", priceAdjustment: "source_ohlc", adjustedCloseUsed: false, items: [{ date: "2025-04-17" }],
    coverage: { from: "2025-04-17", to: "2025-04-17", firstDate: "2025-04-17", lastDate: "2025-04-17", missingBars: 1, sourceRows: 1, returnedBars: 1, observedBars: 0 } };
  if (dataset === "technical-indicators") return { schemaVersion: "trader.talib.v1", engine: "TA-Lib", version: "0.6.8", indicators: [], limits: { maxBars: 10000, maxIndicators: 8 } };
  if (dataset === "technicals") return { ...base, schemaVersion: "trader.talib.v1", engine: "TA-Lib", version: "0.6.8", times: [asOf], barCount: 1,
    results: [{ id: "RSI", name: "Relative Strength Index", group: "Momentum Indicators", parameters: { timeperiod: 14 }, inputs: { price: "close" }, lookback: 14, series: [{ name: "real", values: [null] }] }],
    provenance, inputBars: {}, requestedCount: null, returnedCount: 1, range: "1y", interval: "1d" };
  if (["sec-filings", "sec-facts", "sec-insiders", "finra-short-volume", "usaspending", "fred", "cnn-fear-greed"].includes(dataset)) return {
    sourceId: dataset, sourceName: dataset, sourceUrl: "https://example.com", fetchedAt: asOf, columns: [], rows: [{ value: null }], coverage: { status: "partial", note: "fixture" }, notes: ["fixture"] };
  const performance = { provenance: "unavailable", netReturn: null, maxDrawdown: null, recoveryFactor: null, sharpe: null, forwardReturn: null, winRate: null, trades: null, symbols: null, cash: null };
  const strategy = { id: "saved", origin: "custom", version: 1, family: "research", status: "research", candidateAt: "2026-09-01", name: "保存済み戦略", category: "fixture", sourceLabels: [], headline: "fixture",
    audit: { overfit: null, leakage: null, verdict: "unavailable" }, performance, createdAt: null, updatedAt: null };
  if (dataset === "strategy-list") return { schemaVersion: "trader.strategies.v1", ownerId: "local", strategies: [strategy], warnings: ["fixture"] };
  if (dataset === "strategy" || dataset === "strategy-performance") return { schemaVersion: "trader.strategies.v1", ownerId: "local", strategy, ...(dataset === "strategy-performance" ? { performance } : {}) };
  if (dataset === "strategy-transactions") return { schemaVersion: "trader.strategy-portfolio-transactions.v1", ownerId: "local", strategyId: "saved", transactions: [] };
  if (dataset === "strategy-equity" || dataset === "strategy-holdings") return { schemaVersion: "trader.strategy-results.v1", dataset, ownerId: "local", strategyId: "saved", strategy, retrievedAt: asOf,
    coverage: { status: "unavailable" }, warnings: ["fixture"], ...(dataset === "strategy-equity" ? { basis: "saved_backtest", equity: null, run: null, provenance: "unavailable" }
      : { basis: "current_ledger", holdings: [], provenance: {}, holdingsValue: null, unrealizedGain: null }) };
  return page(dataset);
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value));
}
function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent));
  return result.structuredContent as Record<string, unknown>;
}
function argumentsFor(dataset: string): Record<string, unknown> {
  const definition = DATA_CATALOG.find(item => item.id === dataset)!;
  const args: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(definition.parameters)) {
    if (!rule.required) continue;
    args[key] = key === "symbol" ? "AAPL" : key === "strategy" ? "portfolio-golden-cross" : key === "date" ? "2026-09-01" : "Apple";
  }
  if (dataset.startsWith("sec-")) args.symbol = "AAPL";
  if (dataset === "options-history") args.contract = "AAPL260918C00200000";
  if (dataset === "technicals") args.indicators = "RSI,MACD";
  return args;
}

test("MCP groups expose every supported dataset exactly once, with no deprecated aliases", () => {
  const datasets = ids.flatMap(id => Object.values(MCP_SERVERS[id].tools));
  assert.equal(new Set(datasets).size, datasets.length);
  assert.deepEqual([...datasets, "source-status"].sort(), DATA_CATALOG.filter(item => !item.deprecated).map(item => item.id).sort());
  assert.deepEqual(ids.map(id => Object.keys(MCP_SERVERS[id].tools).length + 1), [24, 4, 8, 7]);
});

for (const id of ids) {
  test(`${id}: protocol, isolated tools and all dataset contracts (${id === "market" ? "injected reader" : "portable stdio"})`, async t => {
    const requests: URL[] = [];
    const baseUrl = await mockApi(t, (request, response) => {
      assert.equal(request.method, "GET");
      assert.equal(request.headers.authorization, undefined);
      const url = new URL(request.url!, "http://127.0.0.1"); requests.push(url);
      const dataset = url.pathname.split("/").at(-1)!;
      json(response, dataset === "source-status" ? { sources: [{
        id: "fred", name: "FRED", nameJa: "FRED", description: "fixture", descriptionJa: "検証用",
        sourceUrl: "https://example.com", inputs: ["series", "date"], defaults: { series: "DGS10" },
        credential: "FRED_API_KEY", configured: false,
      }] }
        : nativeData(dataset));
    });
    const client = await connect(t, id, baseUrl);
    assert.equal(client.getServerVersion()?.name, MCP_SERVERS[id].name);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...Object.keys(MCP_SERVERS[id].tools), "get_status"].sort());
    assert.equal(requests.length, 0, "discovery must work offline");
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.outputSchema?.type, "object");
      const definition = readToolDefinitions(id, path.join(path.dirname(executable(id)), "tools.yaml")).find(item => item.name === tool.name)!;
      assert.deepEqual(tool.outputSchema, definition.outputSchema, "tools/list must publish the YAML output schema");
    }
    for (const [name, dataset] of Object.entries(MCP_SERVERS[id].tools)) {
      const result = await client.callTool({ name, arguments: argumentsFor(dataset) });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const expected = nativeData(dataset);
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(expected) }]);
      assert.equal(requests.at(-1)!.pathname, `/api/v1/data/${dataset}`);
    }
    const status = await client.callTool({ name: "get_status", arguments: {} });
    assert.notEqual(status.isError, true, JSON.stringify(status));
    assert.equal(structured(status).checkedDataset, MCP_SERVERS[id].statusDataset);
    assert.equal(structured(status).reachable, true);
    assert.equal(requests.at(-1)!.searchParams.get("limit"), id === "13f" || id === "x-finance" ? "1" : null);
    if (id === "13f" || id === "x-finance") {
      assert.deepEqual(structured(status).provenance, page("").provenance);
      assert.deepEqual(structured(status).coverage, page("").coverage);
      assert.equal(structured(status).rows, undefined, "status should not return post/holding contents");
    }
    const count = requests.length;
    await assert.rejects(client.callTool({ name: id === "market" ? "get_x_posts" : "get_quote", arguments: { symbol: "AAPL" } }), { code: -32602 });
    assert.equal(requests.length, count, "a foreign tool must never reach HTTP");
  });
}

test("typed schemas and canonical semantic validation reject bad inputs without HTTP", async t => {
  let calls = 0;
  const baseUrl = await mockApi(t, (_request, response) => { calls++; json(response, {}); });
  const client = await connect(t, "market", baseUrl);
  for (const [name, args] of [
    ["get_quote", {}], ["get_quote", { symbol: "AAPL", baseUrl: "https://example.com" }],
    ["get_ohlcv", { symbol: "AAPL", count: "10" }], ["get_ohlcv", { symbol: "AAPL", count: 1.5 }],
    ["get_ohlcv", { symbol: "AAPL", fresh: "1" }], ["get_ohlcv", { symbol: "AAPL", interval: "bad" }],
    ["get_sec_filings", {}], ["get_analyst_ratings", { symbol: "AAPL", from: "2026-02-30" }],
    ["get_analyst_ratings", { symbol: "AAPL", from: "2026-09-02", to: "2026-09-01" }],
    ["get_options_history", { symbol: "AAPL", contract: "MSFT260918C00200000" }],
    ["get_options_history", { symbol: "AAPL", expiration: "2025-04-17", side: "put" }],
    ["get_options_history", { symbol: "AAPL", contract: "AAPL260918C00200000", strike: "200" }],
    ["get_status", { path: "/private" }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
  }
  assert.equal(calls, 0);
});

test("flags and option tuples use the shared canonical request contract", async t => {
  const paths: URL[] = [];
  const baseUrl = await mockApi(t, (request, response) => { const url = new URL(request.url!, "http://localhost"); paths.push(url); json(response, nativeData(url.pathname.split("/").at(-1)!)); });
  const client = await connect(t, "market", baseUrl);
  for (const fresh of [true, false]) {
    const result = await client.callTool({ name: "get_ohlcv", arguments: { symbol: "AAPL", fresh, count: 100 } });
    assert.notEqual(result.isError, true);
    assert.equal(paths.at(-1)!.searchParams.get("fresh"), fresh ? "1" : null);
  }
  const result = await client.callTool({ name: "get_options_history", arguments: { symbol: "NBIS", expiration: "2025-04-17", side: "put", strike: "89", source: "yahoo" } });
  assert.notEqual(result.isError, true);
  assert.equal(paths.at(-1)!.pathname, "/api/v1/data/options-history");
  assert.equal(paths.at(-1)!.searchParams.get("contract"), "NBIS250417P00089000");
  assert.equal(paths.at(-1)!.searchParams.has("expiration"), false);
  assert.equal(paths.at(-1)!.searchParams.get("source"), "yahoo");
});

test("empty pages preserve nextCursor and revision conflicts surface without hidden retries", async t => {
  const requests: URL[] = [];
  const baseUrl = await mockApi(t, (request, response) => {
    const url = new URL(request.url!, "http://localhost"); requests.push(url);
    if (url.searchParams.has("cursor")) json(response, { error: { code: "shared_cursor_revision_changed", message: "Restart explicitly" } }, 409);
    else json(response, page("x-posts"));
  });
  const client = await connect(t, "x-finance", baseUrl);
  const first = await client.callTool({ name: "get_x_posts", arguments: { account: "example", limit: 1 } });
  assert.deepEqual(first.structuredContent, page("x-posts"));
  assert.equal(requests.length, 1);
  const second = await client.callTool({ name: "get_x_posts", arguments: { account: "example", limit: 1, cursor: "next_page" } });
  assert.equal(second.isError, true);
  assert.deepEqual(structured(second).error, { code: "shared_cursor_revision_changed", message: "Restart explicitly", status: 409 });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get("account"), "example");
});

test("API failures, redirects, malformed responses and timeout never become successful status", async t => {
  let mode = "api";
  const baseUrl = await mockApi(t, (_request, response) => {
    if (mode === "api") json(response, { error: { code: "shared_publication_invalid", message: "Publication unavailable" } }, 503);
    else if (mode === "redirect") { response.writeHead(302, { Location: "https://example.com/private" }); response.end(); }
    else if (mode === "text") response.end("not json");
    else if (mode === "shape") json(response, {});
    // timeout deliberately never responds; fixture cleanup closes the socket.
  });
  const client = await connect(t, "x-finance", baseUrl, 100);
  for (const [nextMode, code] of [["api", "shared_publication_invalid"], ["redirect", "redirect_rejected"], ["text", "invalid_response"], ["shape", "invalid_response"], ["timeout", "timeout"]]) {
    mode = nextMode;
    const result = await client.callTool({ name: "get_status", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal((structured(result).error as { code: string }).code, code);
  }
});

test("modern MCP discovery exposes the same tool contract", async t => {
  const baseUrl = await mockApi(t, (_request, response) => json(response, page("institutional-filings")));
  const client = await connect(t, "13f", baseUrl, 2000, true);
  assert.equal((await client.listTools()).tools.length, 4);
  assert.notEqual((await client.callTool({ name: "get_status", arguments: {} })).isError, true);
});

test("oversized MCP results fail explicitly instead of truncating data or exceeding the transport buffer", async t => {
  const baseUrl = await mockApi(t, (_request, response) => json(response, { text: "x".repeat(4 * 1024 * 1024), warnings: ["keep me"] }));
  const client = await connect(t, "market", baseUrl);
  const result = await client.callTool({ name: "get_news", arguments: { symbol: "AAPL" } });
  assert.equal(result.isError, true);
  assert.equal((structured(result).error as { code: string }).code, "response_too_large");
});

test("MCP cancellation aborts the pending local HTTP read", async t => {
  let seen: () => void = () => {};
  let closed: () => void = () => {};
  const received = new Promise<void>(resolve => { seen = resolve; });
  const aborted = new Promise<void>(resolve => { closed = resolve; });
  const baseUrl = await mockApi(t, (_request, response) => {
    response.once("close", closed); seen();
  });
  const client = await connect(t, "market", baseUrl, 5000);
  const controller = new AbortController();
  const pending = client.callTool({ name: "get_quote", arguments: { symbol: "AAPL" } }, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await received;
  controller.abort();
  await rejected;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([aborted, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("HTTP read was not cancelled")), 2000); })]); }
  finally { clearTimeout(timer); }
});

test("each MCP folder contains only documented text files, with no fake Codex config", async () => {
  assert.deepEqual((await readdir(path.join(root, "mcp"))).filter(name => name !== ".DS_Store").sort(), ids.map(id => MCP_SERVERS[id].folder).sort());
  for (const id of ids) {
    const folder = path.dirname(executable(id));
    const files = (await readdir(folder, { recursive: true })).filter(name => name !== "src").filter(name => name !== ".DS_Store").sort();
    assert.deepEqual(files, (id === "market" ? ["LICENSES.txt", "README.md", "tools.yaml", "server.mjs", "src/market.py", "src/sidecar.py", "src/financial_history.py", "src/talib_indicators.py", "src/requirements.txt"] : ["LICENSES.txt", "README.md", "tools.yaml", "server.mjs"]).sort());
    for (const name of files) {
      const bytes = await readFile(path.join(folder, name));
      assert.equal(bytes.includes(0), false, "no binary files");
      assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      assert.equal((await stat(path.join(folder, name))).mode & 0o111, 0, "plain non-executable text files");
      assert.doesNotMatch(bytes.toString(), /\/Users\/ryotarokobayashi\//);
    }
    const readme = await readFile(path.join(folder, "README.md"), "utf8");
    assert.ok(readme.includes("~/.codex/config.toml"));
    const help = spawnSync(process.execPath, [executable(id), "--help"], { cwd: "/", encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.equal(help.stderr, "");
  }
});

test("distributed JavaScript and docs match the authoritative source", () => {
  const generated = spawnSync(process.execPath, ["--import", "tsx", "src/tooling/scripts/build-mcp.ts", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
});

test("startup rejects non-local destinations and malformed options without stdout", () => {
  for (const value of ["https://example.com", "http://localhost@evil.example", "http://127.0.0.1/path", "file:///tmp/data", "http://localhost?token=secret"]) assert.throws(() => localBaseUrl(value));
  for (const value of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"]) assert.equal(localBaseUrl(value), value);
  for (const args of [["x-finance"], ["--timeout-ms", "0"], ["--base-url", "https://example.com?token=secret"], ["--base-url"], ["--timeout-ms", "20", "--timeout-ms", "30"]]) {
    const result = spawnSync(process.execPath, [executable("market"), ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "mcp_startup_error");
    assert.doesNotMatch(result.stderr, /secret/);
  }
});

async function portableMarket(t: TestContext, pythonPath = "/missing-market-python") {
  const isolated = await mkdtemp(path.join(tmpdir(), "standalone-market-"));
  t.after(() => rm(isolated, { recursive: true, force: true }));
  const folder = path.join(isolated, "market");
  await cp(path.dirname(executable("market")), folder, { recursive: true });
  const trace = path.join(isolated, "calls.jsonl");
  const preload = path.join(isolated, "guard.mjs");
  await writeFile(preload, `
import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const trace = ${JSON.stringify(trace)};
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  appendFileSync(trace, JSON.stringify({pid: child.pid, command: args[0], args: args[1]})+'\\n');
  return child;
};
syncBuiltinESMExports();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // Credentials never go in the trace.
  appendFileSync(trace, JSON.stringify({origin: url.origin, path: url.pathname})+'\\n');
  if (url.hostname === 'production.dataviz.cnn.io') return Response.json({fear_and_greed: {
    score: 53.4, rating: 'neutral', timestamp: '2026-09-04T20:00:00+00:00', previous_close: 0
  }});
  if (url.hostname === '127.0.0.1' && !['3001','8791'].includes(url.port) && url.pathname === '/v1/indicators') return realFetch(input, init);
  throw new Error('Unexpected network destination: '+url.origin);
};
`);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, path.join(folder, "server.mjs")],
    cwd: isolated, stderr: "pipe", env: { HOME: isolated, NODE_PATH: "", NODE_OPTIONS: "", MARKET_PYTHON: pythonPath,
      // Poison any accidentally inherited Trader configuration.
      TRADER_BASE_URL: "http://127.0.0.1:3001", TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791", TRADER_MARKET_PROVIDER: "mock" } });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  const client = new Client({ name: "portable-market-test", version: "1.0.0" });
  t.after(async () => { await client.close(); assert.equal(stderr, ""); });
  await client.connect(transport);
  const calls = async (): Promise<Record<string, unknown>[]> => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { client, calls, folder };
}

test("copied Market executes upstream adapters with no Trader, repository, node_modules or Python runtime", async t => {
  const { client, calls } = await portableMarket(t);
  assert.equal((await client.listTools()).tools.length, 24);
  const status = await client.callTool({ name: "get_status", arguments: {} });
  assert.notEqual(status.isError, true);
  assert.deepEqual(await calls(), [], "configuration must not contact Trader or launch Python");
  const result = await client.callTool({ name: "get_fear_greed_index", arguments: {} });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = structured(result);
  const rows = payload.rows as Record<string, unknown>[];
  assert.equal(rows[0].score, 53.4);
  assert.equal(rows[0].week, null);
  assert.equal(rows[0].sourceTime, "2026-09-04T20:00:00.000Z");
  assert.ok(payload.coverage);
  assert.equal((await calls()).length, 1);
  assert.equal((await calls())[0].origin, "https://production.dataviz.cnn.io");
  const missing = await client.callTool({ name: "list_technical_indicators", arguments: {} });
  assert.equal(missing.isError, true);
  assert.equal((structured(missing).error as { code: string }).code, "market_runtime_unavailable");
});

const marketPython = process.env.MARKET_PYTHON ?? path.join(homedir(), ".cache/trader-market/python/bin/python");
const pythonReady = spawnSync(marketPython, ["-B", "-c", "import talib, yfinance, tradingview_websocket"], { timeout: 20000 }).status === 0;
test("copied Market owns its Python helper and terminates it on MCP disconnect", { skip: !pythonReady && "Run server.mjs --setup for Python integration coverage" }, async t => {
  const { client, calls, folder } = await portableMarket(t, marketPython);
  const result = await client.callTool({ name: "list_technical_indicators", arguments: {} });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(structured(result).engine, "TA-Lib");
  assert.ok((structured(result).indicators as unknown[]).length > 100);
  const entries = await calls();
  const pid = entries.find(item => item.pid)?.pid as number;
  assert.ok(pid);
  assert.ok(entries.some(item => item.path === "/v1/indicators" && !["http://127.0.0.1:3001", "http://127.0.0.1:8791"].includes(String(item.origin))));
  await client.close();
  const until = Date.now() + 3000;
  let alive = true;
  while (alive && Date.now() < until) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); }
    catch { alive = false; }
  }
  assert.equal(alive, false, "owned helper must terminate with MCP");
  assert.equal((await readdir(path.join(folder, "src"))).includes("__pycache__"), false);
});

test("editing distributed YAML changes tool discovery and validation without rebuilding JavaScript", async t => {
  let calls = 0;
  const baseUrl = await mockApi(t, (_request, response) => { calls++; json(response, page("institutional-managers")); });
  const client = await connect(t, "13f", baseUrl, 2000, false, text => {
    const doc = load(text, { schema: JSON_SCHEMA }) as { tools: Record<string, { description: string; inputSchema: Record<string, unknown> }> };
    const tool = doc.tools.list_institutional_managers;
    tool.description = "日本語で編集した機関投資家の照会";
    tool.inputSchema.required = ["institution"];
    doc.tools = { list_funds: tool };
    return dump(doc);
  });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "list_funds");
  assert.equal(tools[0].description, "日本語で編集した機関投資家の照会");
  assert.deepEqual(tools[0].inputSchema.required, ["institution"]);
  assert.equal((await client.callTool({ name: "list_funds", arguments: {} })).isError, true);
  assert.equal(calls, 0);
  assert.notEqual((await client.callTool({ name: "list_funds", arguments: { institution: "123" } })).isError, true);
  assert.equal(calls, 1);
  await assert.rejects(client.callTool({ name: "list_institutional_managers", arguments: {} }), { code: -32602 });
});

test("missing, malformed or cross-server YAML fails startup without exposing YAML contents", async t => {
  const isolated = await mkdtemp(path.join(tmpdir(), "invalid-mcp-yaml-"));
  t.after(() => rm(isolated, { recursive: true, force: true }));
  await cp(path.dirname(executable("market")), isolated, { recursive: true });
  const file = path.join(isolated, "tools.yaml");
  const original = await readFile(file, "utf8");
  const cases = [undefined, "tools: [secret-value", "tools: {}\ntools: {}", original.replace("dataset: quote", "dataset: x-posts"),
    original.replace("required: [symbol]", "required: []"), original.replace("type: string", "type: integer"),
    original.replace("outputSchema: &quote", "unsupportedOutput: &quote")];
  for (const content of cases) {
    if (content === undefined) await rm(file); else await writeFile(file, content);
    const result = spawnSync(process.execPath, [path.join(isolated, "server.mjs")], { cwd: isolated, encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "mcp_startup_error");
    assert.match(result.stderr, /tools.yaml/);
    assert.doesNotMatch(result.stderr, /secret-value/);
  }
});

test("output schemas reject missing fields and wrong nested types while preserving extensions and nulls", async t => {
  let payload = nativeData("bars");
  const baseUrl = await mockApi(t, (_request, response) => json(response, payload));
  const client = await connect(t, "market", baseUrl);
  payload = { ...nativeData("bars"), extraProviderMetadata: { missing: null, note: "保持する追加情報" } };
  const valid = await client.callTool({ name: "get_ohlcv", arguments: { symbol: "AAPL" } });
  assert.notEqual(valid.isError, true);
  assert.deepEqual(valid.structuredContent, payload);
  assert.equal(structured(valid).requestedCount, null);
  delete payload.instrument;
  const missing = await client.callTool({ name: "get_ohlcv", arguments: { symbol: "AAPL" } });
  assert.equal(missing.isError, true);
  payload = nativeData("bars");
  (payload.bars as { items: { close: unknown }[] }).items[0].close = "価格ではない文字列";
  const wrong = await client.callTool({ name: "get_ohlcv", arguments: { symbol: "AAPL" } });
  assert.equal(wrong.isError, true);
  payload = nativeData("technicals");
  const technicals = await client.callTool({ name: "get_technicals", arguments: { symbol: "AAPL" } });
  assert.notEqual(technicals.isError, true);
  assert.deepEqual(technicals.structuredContent, payload, "warm-up nulls must remain null");
});

test("editing outputSchema in a copied folder changes runtime output validation", async t => {
  const baseUrl = await mockApi(t, (_request, response) => json(response, page("institutional-filings")));
  const client = await connect(t, "13f", baseUrl, 2000, false, text => {
    const doc = load(text, { schema: JSON_SCHEMA }) as { tools: Record<string, { outputSchema: { required: string[]; properties: Record<string, unknown> } }> };
    const output = doc.tools.get_status.outputSchema;
    output.required.push("customRequiredField");
    output.properties.customRequiredField = { type: "string" };
    return dump(doc);
  });
  const tool = (await client.listTools()).tools.find(item => item.name === "get_status")!;
  assert.ok((tool.outputSchema?.required as string[]).includes("customRequiredField"));
  assert.equal((await client.callTool({ name: "get_status", arguments: {} })).isError, true);
});
