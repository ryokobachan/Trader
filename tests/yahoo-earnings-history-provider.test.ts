import assert from "node:assert/strict";
import test from "node:test";

import type { Instrument } from "../src/app/platform/provider-contracts";
import {
  createYahooEarningsHistoryClient,
  YahooEarningsHistoryError,
} from "../api/yahoo/earnings.server";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const MU: Instrument = {
  instrumentId: "us:XNAS:MU",
  symbol: "MU",
  name: "Micron Technology, Inc.",
  assetType: "common_stock",
  active: true,
  listingCountry: "US",
  exchange: "NASDAQ Global Select Market",
  exchangeMic: "XNAS",
  currency: "USD",
  provenance: {
    providerId: "yahoo",
    sourceId: "test",
    asOf: "2026-08-08T00:00:00.000Z",
    ingestedAt: "2026-08-08T00:00:01.000Z",
  },
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function visualizationPayload() {
  return {
    finance: {
      error: null,
      result: [{
        documents: [{
          // Deliberately shuffled: normalization must follow column ids, not
          // a provider-specific hard-coded array position.
          columns: [
            { id: "epsactual" },
            { id: "ticker" },
            { id: "startdatetime" },
            { id: "epsestimate" },
            { id: "epssurprisepct" },
          ],
          rows: [
            [null, "MU", "2026-09-23T20:00:00.000Z", 31.31, null],
            [25.11, "MU", "2026-06-24T20:01:00.000Z", 20.69, 21.39],
            [12.2, "MU", "2026-03-18T20:01:00.000Z", 9.16, 33.21],
            [999, "AAPL", "2026-01-01T20:00:00.000Z", 998, 1],
          ],
        }],
      }],
    },
  };
}

function earningsTrendPayload() {
  return {
    quoteSummary: {
      error: null,
      result: [{
        earningsTrend: {
          trend: [
            {
              period: "0q",
              endDate: "2026-08-31",
              earningsEstimate: { avg: { raw: 31.32898 } },
              revenueEstimate: { avg: { raw: 50_838_974_970 } },
            },
            {
              period: "+1q",
              endDate: "2026-11-30",
              earningsEstimate: { avg: { raw: 34.86624 } },
              revenueEstimate: { avg: { raw: 56_711_909_380 } },
            },
            {
              period: "0y",
              endDate: "2026-08-31",
              revenueEstimate: { avg: { raw: 129_758_113_130 } },
            },
          ],
        },
      }],
    },
  };
}

function quarterlyRevenuePayload() {
  return {
    timeseries: {
      error: null,
      result: [{
        meta: { symbol: ["MU"], type: ["quarterlyTotalRevenue"] },
        quarterlyTotalRevenue: [
          {
            asOfDate: "2026-02-28",
            currencyCode: "USD",
            reportedValue: { raw: 23_860_000_000 },
          },
          {
            asOfDate: "2026-05-31",
            currencyCode: "USD",
            reportedValue: { raw: 41_456_000_000 },
          },
        ],
      }],
    },
  };
}

test("normalizes Yahoo earnings history and enriches actual and forecast revenue", async () => {
  const requests: Array<{ url: URL; init?: FetchInit }> = [];
  const fetchImplementation = (async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === "/v1/finance/visualization") {
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("cookie"), "A3=private-cookie");
      assert.equal(url.searchParams.get("crumb"), "private-crumb");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.entityIdType, "sp_earnings");
      assert.equal(body.size, 24);
      assert.deepEqual(body.query.operands[0].operands[0].operands, ["ticker", "MU"]);
      return jsonResponse(visualizationPayload());
    }
    if (url.pathname === "/v10/finance/quoteSummary/MU") {
      assert.equal(url.searchParams.get("modules"), "earningsTrend");
      assert.equal(url.searchParams.get("crumb"), "private-crumb");
      return jsonResponse(earningsTrendPayload());
    }
    if (url.pathname.endsWith("/timeseries/MU")) {
      assert.equal(url.searchParams.get("type"), "quarterlyTotalRevenue");
      assert.equal(url.searchParams.has("crumb"), false);
      return jsonResponse(quarterlyRevenuePayload());
    }
    return jsonResponse({}, 404);
  }) as typeof globalThis.fetch;

  const client = createYahooEarningsHistoryClient({
    fetchImplementation,
    getCredential: async () => ({
      cookie: "A3=private-cookie",
      crumb: "private-crumb",
    }),
    timeoutMs: 1_000,
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  });
  const events = await client.getEarnings(MU);

  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.reportDate), [
    "2026-09-23",
    "2026-06-24",
    "2026-03-18",
  ]);
  assert.deepEqual(events[0], {
    reportDate: "2026-09-23",
    fiscalDateEnding: "2026-08-31",
    epsEstimate: 31.31,
    revenueEstimate: 50_838_974_970,
    provenance: {
      providerId: "yahoo",
      sourceId: "yahoo-earnings:MU:2026-09-23",
      asOf: "2026-09-23",
      ingestedAt: "2026-08-09T00:00:00.000Z",
      sourceUrl: "https://query1.finance.yahoo.com/v1/finance/visualization?lang=en-US&region=US",
    },
  });
  assert.equal(events[1]?.fiscalDateEnding, "2026-05-31");
  assert.equal(events[1]?.epsActual, 25.11);
  assert.equal(events[1]?.epsEstimate, 20.69);
  assert.equal(events[1]?.revenueActual, 41_456_000_000);
  assert.equal(events[2]?.fiscalDateEnding, "2026-02-28");
  assert.equal(events[2]?.revenueActual, 23_860_000_000);
  assert.equal(requests.length, 3);
  for (const event of events) {
    assert.equal((event.provenance.sourceUrl ?? "").includes("private-crumb"), false);
    assert.equal((event.provenance.sourceUrl ?? "").includes("private-cookie"), false);
  }
});

test("refreshes credentials after one unauthorized visualization response", async () => {
  let credentialRound = 1;
  let visualizationCalls = 0;
  const fetchImplementation = (async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/finance/visualization") {
      visualizationCalls += 1;
      assert.equal(url.searchParams.get("crumb"), `crumb-${visualizationCalls}`);
      assert.equal(new Headers(init?.headers).get("cookie"), `A3=cookie-${visualizationCalls}`);
      return visualizationCalls === 1
        ? jsonResponse({ secret: "crumb-1 A3=cookie-1" }, 401)
        : jsonResponse(visualizationPayload());
    }
    // Revenue enrichment is intentionally best effort. Its failure must not
    // discard the actual/estimate history returned by the calendar endpoint.
    return jsonResponse({ secret: "crumb-2 A3=cookie-2" }, 503);
  }) as typeof globalThis.fetch;
  const client = createYahooEarningsHistoryClient({
    fetchImplementation,
    getCredential: async (forceRefresh) => {
      if (forceRefresh) credentialRound += 1;
      return { cookie: `A3=cookie-${credentialRound}`, crumb: `crumb-${credentialRound}` };
    },
    timeoutMs: 1_000,
  });

  const events = await client.getEarnings(MU);
  assert.equal(visualizationCalls, 2);
  assert.equal(credentialRound, 2);
  assert.equal(events.length, 3);
  assert.equal(events[0]?.epsEstimate, 31.31);
  assert.equal(events[0]?.revenueEstimate, undefined);
});

test("fails closed with sanitized errors for an unsuccessful core request", async () => {
  const fetchImplementation = (async () => jsonResponse({
    credential: "secret-crumb",
    cookie: "A3=secret-cookie",
  }, 500)) as typeof globalThis.fetch;
  const client = createYahooEarningsHistoryClient({
    fetchImplementation,
    getCredential: async () => ({
      cookie: "A3=secret-cookie",
      crumb: "secret-crumb",
    }),
    timeoutMs: 1_000,
  });

  await assert.rejects(
    client.getEarnings(MU),
    (error: unknown) => {
      assert.ok(error instanceof YahooEarningsHistoryError);
      assert.equal(error.code, "upstream_error");
      assert.equal(error.status, 500);
      assert.equal(error.message.includes("secret-crumb"), false);
      assert.equal(error.message.includes("secret-cookie"), false);
      return true;
    },
  );
});
