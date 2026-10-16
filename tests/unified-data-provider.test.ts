import assert from "node:assert/strict";
import test from "node:test";
import { DATA_CATALOG } from "../src/tooling/data-catalog";
import { dataOpenApi, describeData, discoverData } from "../api/data/discovery";
import { dataDefinition, prepareDataRequest } from "../api/data/request";
import { dataDiscoveryResponse, getDataResponse } from "../api/data/route.server";
import { runTraderCli } from "../src/tooling/scripts/trader-cli";

test("catalog classification separates historical inputs, outcomes and current snapshots with working schema paths", () => {
  const inputs = discoverData([["category", "input"]]).datasets;
  assert.ok(inputs.some(item => item.id === "institutional-holdings"));
  assert.ok(inputs.some(item => item.id === "x-posts"));
  assert.ok(inputs.every(item => !["quote", "x-mention-outcomes", "strategy-performance"].includes(item.id)));
  assert.deepEqual(discoverData([["backtest", "usable"]]).datasets.map(item => item.id), ["bars", "technicals"]);
  const results = discoverData([["category", "result"]]).datasets;
  assert.ok(["strategy-equity", "strategy-holdings", "x-mention-outcomes", "x-author-scores"].every(id => results.some(item => item.id === id)));
  for (const item of DATA_CATALOG) {
    const description = describeData(item.id);
    assert.equal(description.endpoint, `/api/v1/data/${item.id}`);
    assert.equal(description.parameterSchema.additionalProperties, false);
    assert.ok(description.metadataPaths?.data.length);
    assert.ok(Object.hasOwn(dataOpenApi().paths, description.endpoint));
  }
  assert.throws(() => discoverData([["category", "input"], ["category", "result"]]));
  assert.throws(() => discoverData([["category", "nonsense"]]));
});

test("CLI and HTTP discovery expose the same offline catalog and OpenAPI", async () => {
  for (const [args, query, mode] of [
    [["data", "sources", "--category", "input", "--subject", "institution"], "?category=input&subject=institution", "catalog"],
    [["data", "openapi"], "", "openapi"],
  ] as const) {
    let stdout = "", stderr = "";
    const result = await runTraderCli(args, { env: {}, fetch: async () => { throw new Error("Discovery must be offline"); }, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    assert.equal(result, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), await dataDiscoveryResponse(new Request(`http://localhost:3001/api/v1/data${query}`), mode).json());
  }
  const response = dataDiscoveryResponse(new Request("http://localhost:3001/api/v1/data?password=hidden"), "openapi");
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /hidden/);
});

test("canonical dispatch is one in-process read preserving native bytes, original origin, auth context and status", async () => {
  const raw = '{"status":"partial","bars":{"items":[{"close":0},{}]},"dataMode":"fixture","warnings":["missing"]}';
  let calls = 0;
  const response = await getDataResponse(new Request("https://trader.example/api/v1/data/bars?symbol=nbis&count=20", {
    headers: { "oai-authenticated-user-id": "owner-one", "x-request-id": "trace-one" },
  }), "bars", async (request, prepared) => {
    calls++;
    assert.equal(request.url, "https://trader.example/api/v1/symbols/NBIS/bars?count=20");
    assert.equal(request.headers.get("oai-authenticated-user-id"), "owner-one");
    assert.equal(request.method, "GET");
    assert.equal(prepared.parameters.get("symbol"), "NBIS");
    return new Response(raw, { headers: { "Cache-Control": "private, max-age=50" } });
  });
  assert.equal(calls, 1);
  assert.equal(await response.text(), raw);
  assert.equal(response.headers.get("X-Trader-Dataset"), "bars");
  assert.equal(response.headers.get("X-Request-Id"), "trace-one");
  assert.equal(response.headers.get("Cache-Control"), "private, max-age=50");
  const denied = await getDataResponse(new Request("https://trader.example/api/v1/data/strategy?strategy=custom.alpha"), "strategy", async request => {
    assert.equal(request.url, "https://trader.example/api/v1/strategies/custom.alpha");
    assert.equal(request.headers.get("oai-authenticated-user-id"), null);
    return Response.json({ error: { code: "authentication_required" } }, { status: 401 });
  });
  assert.equal(denied.status, 401);
});

test("canonical parameter validation prevents provider work for unsafe or incoherent requests", async () => {
  let calls = 0;
  for (const [id, query] of [
    ["bars", "symbol=AAPL&symbol=MSFT"], ["bars", "symbol=AAPL&owner=other"], ["bars", "symbol=AAPL&count=10001"],
    ["institutional-holdings", "period=2026-02-31"], ["x-posts", "asOf=2026-01-01"], ["x-prices", "limit=1"],
    ["x-posts", "from=2026-02-01&to=2026-01-01"], ["x-posts", "cursor=../secret"], ["x-posts", "__proto__=x"],
    ["strategy-equity", "strategy=../../private"], ["options-history", "symbol=AAPL&contract=MSFT260918C00100000"],
    ["unknown", ""],
  ]) {
    const response = await getDataResponse(new Request(`http://localhost:3001/api/v1/data/${id}?${query}`), id, async () => { calls++; return Response.json({}); });
    assert.equal(response.status, id === "unknown" ? 404 : 400, `${id}?${query}`);
  }
  assert.equal(calls, 0);
  const failure = await getDataResponse(new Request("http://localhost:3001/api/v1/data/source-status"), "source-status", async () => { throw new Error("token=secret /private/path"); });
  assert.equal(failure.status, 502);
  assert.doesNotMatch(await failure.text(), /secret|private\/path/);
});

test("option identity and analyst parameters share one native mapping without hidden lookups", () => {
  const option = prepareDataRequest(dataDefinition("options-history"), new URLSearchParams("symbol=nbis&expiration=2025-04-17&side=put&strike=89&source=yahoo"));
  assert.equal(option.canonicalPath, "/api/v1/data/options-history?symbol=NBIS&source=yahoo&contract=NBIS250417P00089000");
  assert.equal(option.nativePath, "/api/v1/symbols/NBIS/options/prices?source=yahoo&contractId=NBIS250417P00089000");
  const analyst = prepareDataRequest(dataDefinition("analyst-ratings"), new URLSearchParams("symbol=AAPL&from=2025-01-01&to=2026-01-01&limit=200"));
  assert.equal(analyst.nativePath, "/api/v1/symbols/AAPL/analyst-ratings?date_from=2025-01-01&date_to=2026-01-01&pagesize=200");
  const shared = prepareDataRequest(dataDefinition("x-prices"), new URLSearchParams("symbol=%5EGSPC&asOf=2026-09-01T12%3A00%3A00Z"));
  assert.equal(shared.parameters.get("symbol"), "^GSPC");
});

test("deprecated Midas catalog command executes independent catalog only", async () => {
  const response = await getDataResponse(new Request("http://localhost:3001/api/v1/data/midas-data-sources"), "midas-data-sources");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), discoverData());
  assert.equal(describeData("midas-data-sources").deprecated, true);
});
