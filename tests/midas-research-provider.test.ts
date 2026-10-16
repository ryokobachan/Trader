import assert from "node:assert/strict";
import test from "node:test";

import { GET as getDataSources } from "../src/app/api/v1/midas/data-sources/route";
import { GET as getIdeas } from "../src/app/api/v1/midas/ideas/route";
import { GET as getInstitutionalPortfolios } from "../src/app/api/v1/midas/institutional-portfolios/route";
import { GET as getXAccount } from "../src/app/api/v1/midas/x-analysis/accounts/[authorHandle]/route";
import { discoverData } from "../api/data/discovery";
import { GET as getXAnalysis } from "../src/app/api/v1/midas/x-analysis/route";
import {
  DEFAULT_MIDAS_API_BASE_URL,
  proxyMidasResearchRequest,
  proxyMidasXAccountDetailRequest,
} from "../src/app/platform/midas-research.server";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

function inputUrl(input: FetchInput): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input);
  return new URL(input.url);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installBaseUrl(value: string, after: (callback: () => void) => void): void {
  const previous = process.env.TRADER_MIDAS_API_BASE_URL;
  process.env.TRADER_MIDAS_API_BASE_URL = value;
  after(() => {
    if (previous === undefined) delete process.env.TRADER_MIDAS_API_BASE_URL;
    else process.env.TRADER_MIDAS_API_BASE_URL = previous;
  });
}

test("retired institutional and X routes return replacement metadata without any Midas request", { concurrency: false }, async (t) => {
  installBaseUrl("https://unreachable-midas.example.test", t.after.bind(t));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Retired APIs must not fetch"); });
  for (const [route, expected] of [
    [getInstitutionalPortfolios, ["institutional-filings", "institutional-holdings", "strategy-performance"]],
    [getXAnalysis, ["x-mentions", "x-author-scores", "x-author-strategies"]],
    [getXAccount, ["x-accounts", "x-posts", "x-mentions", "x-mention-outcomes"]],
  ] as const) {
    const response = await route();
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { error: { code: string }; replacements: Array<{ dataset: string; endpoint: string; describe: string }> };
    assert.equal(body.error.code, "data_endpoint_replaced");
    assert.deepEqual(body.replacements, expected.map(dataset => ({ dataset, endpoint: `/api/v1/data/${dataset}`, describe: `/api/v1/data/${dataset}/describe` })));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("legacy catalog path returns independent discovery while excluded Ideas retains its explicit legacy route", { concurrency: false }, async (t) => {
  installBaseUrl(DEFAULT_MIDAS_API_BASE_URL, t.after.bind(t));
  const captured: URL[] = [];
  const inits: FetchInit[] = [];
  t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: FetchInit) => {
    captured.push(inputUrl(input)); inits.push(init);
    return jsonResponse({ available: true });
  });
  const catalog = await getDataSources(new Request("http://trader.test/api/v1/midas/data-sources"));
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), discoverData());
  assert.equal(catalog.headers.get("Deprecation"), "true");
  assert.equal(captured.length, 0);
  const ideasResponse = await getIdeas(new Request("http://trader.test/api/v1/midas/ideas?q=quality%20value&view=detail", { headers: { Authorization: "Bearer browser-secret", "X-Request-Id": "ideas-request" } }));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].pathname, "/api/ideas");
  assert.equal(captured[0].searchParams.get("q"), "quality value");
  assert.deepEqual(captured[0].searchParams.getAll("view"), ["list"]);
  const upstreamHeaders = new Headers(inits[0]?.headers);
  assert.equal(upstreamHeaders.get("x-request-id"), "ideas-request");
  assert.equal(upstreamHeaders.has("authorization"), false);
  assert.equal(ideasResponse.status, 200);
});

test("legacy X helper details normalize the handle and forward only bounded detail filters", async (t) => {
  let capturedUrl: URL | undefined;
  let capturedInit: FetchInit;
  const fetchMock = t.mock.fn(async (input: FetchInput, init?: FetchInit) => {
    capturedUrl = inputUrl(input);
    capturedInit = init;
    return jsonResponse({ account: { authorHandle: "investnorthwise" } });
  });

  const response = await proxyMidasXAccountDetailRequest(
    new Request(
      "http://trader.test/api/v1/midas/x-analysis/accounts/InvestNorthWise"
        + "?mentionLimit=25&mentionOffset=10&mentionSymbol=%EF%BC%A1%EF%BC%A1%EF%BC%B0%EF%BC%AC",
      { headers: { "X-Request-Id": "x-account-detail-request" } },
    ),
    "@InvestNorthWise",
    {
      baseUrl: DEFAULT_MIDAS_API_BASE_URL,
      fetch: fetchMock,
    },
  );

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.ok(capturedUrl);
  assert.equal(capturedUrl.origin, DEFAULT_MIDAS_API_BASE_URL);
  assert.equal(capturedUrl.pathname, "/api/x-analysis/investnorthwise");
  assert.equal(capturedUrl.searchParams.get("mentionLimit"), "25");
  assert.equal(capturedUrl.searchParams.get("mentionOffset"), "10");
  assert.equal(capturedUrl.searchParams.get("mentionSymbol"), "AAPL");
  assert.equal(capturedInit?.method, "GET");
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  const upstreamHeaders = new Headers(capturedInit?.headers);
  assert.equal(upstreamHeaders.get("x-request-id"), "x-account-detail-request");
  assert.equal(upstreamHeaders.has("authorization"), false);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-request-id"), "x-account-detail-request");
  assert.deepEqual(await response.json(), {
    account: { authorHandle: "investnorthwise" },
  });
});

test("legacy X helper details reject unsafe handles and invalid or duplicate filters", async (t) => {
  const fetchMock = t.mock.fn(async () => {
    throw new Error("fetch must not run for an invalid X account detail request");
  });
  const dependencies = {
    baseUrl: DEFAULT_MIDAS_API_BASE_URL,
    fetch: fetchMock,
  };
  const requests = [
    proxyMidasXAccountDetailRequest(
      new Request("http://trader.test/api/v1/midas/x-analysis/accounts/invalid"),
      "../../admin",
      dependencies,
    ),
    proxyMidasXAccountDetailRequest(
      new Request("http://trader.test/api/v1/midas/x-analysis/accounts/empty"),
      "@@@",
      dependencies,
    ),
    proxyMidasXAccountDetailRequest(
      new Request("http://trader.test/api/v1/midas/x-analysis/accounts/test?upstream=/admin"),
      "test",
      dependencies,
    ),
    proxyMidasXAccountDetailRequest(
      new Request("http://trader.test/api/v1/midas/x-analysis/accounts/test?mentionLimit=0"),
      "test",
      dependencies,
    ),
    proxyMidasXAccountDetailRequest(
      new Request("http://trader.test/api/v1/midas/x-analysis/accounts/test?mentionLimit=101"),
      "test",
      dependencies,
    ),
    proxyMidasXAccountDetailRequest(
      new Request("http://trader.test/api/v1/midas/x-analysis/accounts/test?mentionOffset=100001"),
      "test",
      dependencies,
    ),
    proxyMidasXAccountDetailRequest(
      new Request("http://trader.test/api/v1/midas/x-analysis/accounts/test?mentionLimit=1&mentionLimit=2"),
      "test",
      dependencies,
    ),
    proxyMidasXAccountDetailRequest(
      new Request(`http://trader.test/api/v1/midas/x-analysis/accounts/test?mentionSymbol=${"A".repeat(21)}`),
      "test",
      dependencies,
    ),
  ];

  const responses = await Promise.all(requests);
  assert.equal(fetchMock.mock.callCount(), 0);
  for (const response of responses) {
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const payload = await response.json() as { error?: { code?: string } };
    assert.equal(payload.error?.code, "invalid_query");
  }
});

test("legacy X helper upstream failures return sanitized 503 JSON", async () => {
  const upstreamSecret = "x-detail-upstream-secret";
  const response = await proxyMidasXAccountDetailRequest(
    new Request("http://trader.test/api/v1/midas/x-analysis/accounts/test", {
      headers: { "X-Request-Id": "x-detail-failure" },
    }),
    "test",
    {
      baseUrl: DEFAULT_MIDAS_API_BASE_URL,
      fetch: async () => new Response(`failure: ${upstreamSecret}`, { status: 503 }),
    },
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-request-id"), "x-detail-failure");
  const body = await response.text();
  assert.equal(body.includes(upstreamSecret), false);
  assert.equal(body.includes(DEFAULT_MIDAS_API_BASE_URL), false);
  assert.equal(JSON.parse(body).error.code, "midas_unavailable");
});

test("the Midas API base URL can be overridden only through server configuration", { concurrency: false }, async (t) => {
  installBaseUrl("https://midas.example.test:9443", t.after.bind(t));
  let capturedUrl: URL | undefined;
  t.mock.method(globalThis, "fetch", async (input: FetchInput) => {
    capturedUrl = inputUrl(input);
    return jsonResponse({ available: true });
  });

  const response = await getIdeas(new Request("http://trader.test/api/v1/midas/ideas"));

  assert.equal(response.status, 200);
  assert.ok(capturedUrl);
  assert.equal(capturedUrl.origin, "https://midas.example.test:9443");
  assert.equal(capturedUrl.pathname, "/api/ideas");
  assert.equal(capturedUrl.searchParams.get("view"), "list");
});

test("legacy Ideas query allowlist rejects unknown, duplicate and oversized filters", { concurrency: false }, async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Invalid requests must not fetch"); });
  for (const query of ["upstream=/admin", "q=one&q=two", `q=${"a".repeat(201)}`]) {
    const response = await getIdeas(new Request(`http://trader.test/api/v1/midas/ideas?${query}`));
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, "invalid_query");
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("upstream and configuration failures return sanitized 503 JSON", { concurrency: false }, async (t) => {
  const upstreamSecret = "midas-upstream-secret";
  const upstreamResponse = await proxyMidasResearchRequest(
    new Request("http://trader.test/api/v1/midas/ideas", {
      headers: { "X-Request-Id": "failed-request" },
    }),
    "ideas",
    {
      baseUrl: DEFAULT_MIDAS_API_BASE_URL,
      fetch: async () => new Response(`failure: ${upstreamSecret}`, { status: 500 }),
    },
  );
  assert.equal(upstreamResponse.status, 503);
  assert.equal(upstreamResponse.headers.get("cache-control"), "private, no-store");
  const upstreamBody = await upstreamResponse.text();
  assert.equal(upstreamBody.includes(upstreamSecret), false);
  assert.equal(upstreamBody.includes(DEFAULT_MIDAS_API_BASE_URL), false);
  assert.equal(JSON.parse(upstreamBody).error.code, "midas_unavailable");

  const invalidJsonResponse = await proxyMidasResearchRequest(
    new Request("http://trader.test/api/v1/midas/ideas"),
    "ideas",
    {
      baseUrl: DEFAULT_MIDAS_API_BASE_URL,
      fetch: async () => new Response("not-json", { status: 200 }),
    },
  );
  assert.equal(invalidJsonResponse.status, 503);

  const redirectedPayload = jsonResponse({ available: true });
  Object.defineProperty(redirectedPayload, "url", {
    configurable: true,
    value: "https://unexpected.example.test/api/ideas",
  });
  const redirectedResponse = await proxyMidasResearchRequest(
    new Request("http://trader.test/api/v1/midas/ideas"),
    "ideas",
    {
      baseUrl: DEFAULT_MIDAS_API_BASE_URL,
      fetch: async () => redirectedPayload,
    },
  );
  assert.equal(redirectedResponse.status, 503);

  const fetchMock = t.mock.fn(async () => jsonResponse({ mustNot: "run" }));
  const invalidConfigurationResponse = await proxyMidasResearchRequest(
    new Request("http://trader.test/api/v1/midas/ideas"),
    "ideas",
    {
      baseUrl: `https://user:${upstreamSecret}@midas.example.test/private`,
      fetch: fetchMock,
    },
  );
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(invalidConfigurationResponse.status, 503);
  assert.equal((await invalidConfigurationResponse.text()).includes(upstreamSecret), false);
});

test("the proxy enforces a hard timeout and aborts the upstream request", { concurrency: false }, async () => {
  const captured: { signal?: AbortSignal } = {};
  const response = await proxyMidasResearchRequest(
    new Request("http://trader.test/api/v1/midas/ideas?q=test"),
    "ideas",
    {
      baseUrl: DEFAULT_MIDAS_API_BASE_URL,
      timeoutMs: 5,
      fetch: async (_input, init) => {
        if (init?.signal) captured.signal = init.signal;
        return new Promise<Response>(() => undefined);
      },
    },
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const payload = await response.json() as { error?: { code?: string } };
  assert.equal(payload.error?.code, "midas_timeout");
  assert.ok(captured.signal);
  assert.equal(captured.signal.aborted, true);
});
