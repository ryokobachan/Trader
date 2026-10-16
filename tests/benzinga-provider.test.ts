import assert from "node:assert/strict";
import test from "node:test";

import type { Instrument, ProviderRequestContext } from "../src/app/platform/provider-contracts";
import {
  benzingaProviderRegistration,
  BenzingaProviderError,
  createBenzingaProvider,
  type BenzingaFetch,
} from "../api/benzinga/analyst.server";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const SECRET = "benzinga token?with&reserved=characters";
const ENDPOINT = "https://www.benzinga.com/api-next/calendar/ratings";
const CONTEXT = {
  requestId: "benzinga-provider-test",
  asOf: NOW.toISOString(),
} as const satisfies ProviderRequestContext;

const INSTRUMENT = {
  instrumentId: "us:XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetType: "common_stock",
  active: true,
  listingCountry: "US",
  exchange: "NASDAQ Global Select Market",
  exchangeMic: "XNAS",
  currency: "USD",
  provenance: {
    providerId: "fixture",
    sourceId: "fixture:AAPL",
    asOf: NOW.toISOString(),
    ingestedAt: NOW.toISOString(),
  },
} as const satisfies Instrument;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function rating(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rating-1",
    ticker: "AAPL",
    date: "2026-08-01",
    time: "10:00:00",
    updated: Date.parse("2026-08-01T14:01:00.000Z") / 1_000,
    currency: "USD",
    analyst: "Example Securities",
    analyst_name: "Alex Analyst",
    firm_id: "firm-1",
    analyst_id: "analyst-1",
    rating_current: "Buy",
    pt_current: 150,
    ...overrides,
  };
}

function providerWithRows(
  rows: readonly Record<string, unknown>[],
  responseShape: "array" | "data" | "ratings" | "results" = "data",
) {
  const payload = responseShape === "array" ? rows : { [responseShape]: rows };
  return createBenzingaProvider({}, {
    fetch: async () => json(payload),
    now: () => new Date(NOW),
  });
}

function expectSafeError(
  forbidden: readonly string[],
  code?: BenzingaProviderError["code"],
) {
  return (error: unknown) => {
    assert.ok(error instanceof BenzingaProviderError);
    if (code) assert.equal(error.code, code);
    for (const value of forbidden) {
      assert.equal(error.message.includes(value), false);
      assert.equal(String(error.stack).includes(value), false);
    }
    return true;
  };
}

test("registers a keyless, independently selectable analyst provider", () => {
  assert.equal(benzingaProviderRegistration.manifest.id, "benzinga");
  assert.deepEqual(benzingaProviderRegistration.manifest.capabilities, [
    "analyst.consensus",
    "analyst.ratings",
  ]);
  assert.deepEqual(benzingaProviderRegistration.manifest.requiredEnv, []);

  const provider = benzingaProviderRegistration.create({});
  assert.ok(provider.analyst);
  assert.equal(typeof provider.analyst?.getRatingHistory, "function");
  assert.equal(provider.instrument, undefined);
  assert.equal(provider.market, undefined);
  assert.equal(provider.fundamentals, undefined);
  assert.equal(provider.news, undefined);
});

test("preserves the Midas request contract and adds the working public filter aliases", async () => {
  let captured: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const fetch: BenzingaFetch = async (input, init) => {
    captured = requestUrl(input);
    capturedInit = init;
    return json([rating()]);
  };
  const provider = createBenzingaProvider({}, {
    fetch,
    now: () => new Date(NOW),
  });

  const consensus = await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT);
  assert.ok(captured);
  assert.equal(captured.origin + captured.pathname, ENDPOINT);
  assert.equal(captured.searchParams.get("pagesize"), "1000");
  assert.equal(captured.searchParams.get("pageSize"), "1000");
  assert.equal(captured.searchParams.get("parameters[tickers]"), "AAPL");
  assert.equal(captured.searchParams.get("symbols"), "AAPL");
  assert.equal(
    captured.searchParams.get("parameters[date_from]"),
    new Date(NOW.getTime() - 900 * 86_400_000).toISOString().slice(0, 10),
  );
  assert.equal(captured.searchParams.get("parameters[date_to]"), "2026-08-09");
  assert.equal(
    captured.searchParams.get("fields"),
    "*,ratings_accuracy.smart_score,ratings_accuracy.overall_success_rate,ratings_accuracy.total_ratings",
  );
  assert.deepEqual([...captured.searchParams.keys()], [
    "pagesize",
    "parameters[date_from]",
    "parameters[date_to]",
    "parameters[tickers]",
    "symbols",
    "pageSize",
    "fields",
  ]);
  assert.equal(captured.searchParams.has("token"), false);
  assert.equal(capturedInit?.redirect, "manual");
  assert.equal(new Headers(capturedInit?.headers).get("Accept"), "application/json");
  assert.equal(
    new Headers(capturedInit?.headers).get("User-Agent"),
    "midas/benzinga-analyst-ratings",
  );
  assert.equal(consensus?.targetConsensus, 150);
  assert.equal(consensus?.provenance.sourceUrl, ENDPOINT);
});

test("returns the complete Midas-compatible rating history as a canonical DTO", async () => {
  let captured: URL | undefined;
  const provider = createBenzingaProvider({ BENZINGA_API_TOKEN: SECRET }, {
    fetch: async (input) => {
      captured = requestUrl(input);
      return json({
        data: [
          rating({
            id: "mu-new",
            ticker: "MU",
            name: "Micron Technology, Inc.",
            date: "2026-07-10",
            time: "10:15:30",
            updated: Date.parse("2026-07-12T00:00:00.000Z") / 1_000,
            analyst: "North Star Securities",
            analyst_name: "Morgan Example",
            firm_id: "firm-mu",
            analyst_id: "analyst-mu",
            action_company: "Maintains",
            action_pt: "Raises",
            rating_current: "Outperform",
            rating_prior: "Neutral",
            pt_current: "170",
            pt_prior: "150",
            adjusted_pt_current: "175",
            adjusted_pt_prior: "155",
            pt_pct_change: "12.90",
            importance: "5",
            ratings_accuracy: {
              smart_score: "4.5",
              overall_success_rate: "68.2",
              total_ratings: "124",
            },
          }),
          // Midas retains an event even when the provider omits analyst IDs.
          rating({
            id: "mu-old",
            ticker: "MU",
            date: "2024-01-02",
            time: "09:00:00",
            analyst: null,
            analyst_name: null,
            firm_id: null,
            analyst_id: null,
            rating_current: "Buy",
            rating_prior: "Hold",
            pt_current: 90,
            adjusted_pt_current: null,
          }),
          rating({ id: "wrong-symbol", ticker: "AAPL", date: "2026-01-01" }),
          rating({
            id: "zero-target",
            ticker: "MU",
            date: "2025-01-02",
            pt_current: 0,
            pt_prior: "0",
            adjusted_pt_current: 0,
            adjusted_pt_prior: "0",
          }),
          rating({ id: "out-of-range", ticker: "MU", date: "2023-12-31" }),
        ],
      });
    },
    now: () => new Date(NOW),
  });
  const muInstrument = {
    ...INSTRUMENT,
    instrumentId: "us:XNAS:MU",
    symbol: "MU",
    name: "Micron Technology, Inc.",
  } as const satisfies Instrument;

  const history = await provider.analyst?.getRatingHistory?.(
    muInstrument,
    { dateFrom: "2024-01-01", dateTo: "2026-07-11", pageSize: 777 },
    CONTEXT,
  );

  assert.ok(captured);
  assert.equal(captured.searchParams.get("pagesize"), "777");
  assert.equal(captured.searchParams.get("pageSize"), "777");
  assert.equal(captured.searchParams.get("parameters[date_from]"), "2024-01-01");
  assert.equal(captured.searchParams.get("parameters[date_to]"), "2026-07-11");
  assert.equal(captured.searchParams.get("parameters[tickers]"), "MU");
  assert.equal(captured.searchParams.get("symbols"), "MU");
  assert.equal(
    captured.searchParams.get("fields"),
    "*,ratings_accuracy.smart_score,ratings_accuracy.overall_success_rate,ratings_accuracy.total_ratings",
  );
  assert.ok(history);
  assert.equal(history.instrumentId, "us:XNAS:MU");
  assert.equal(history.symbol, "MU");
  assert.equal(history.dateFrom, "2024-01-01");
  assert.equal(history.dateTo, "2026-07-11");
  assert.equal(history.pageSize, 777);
  assert.equal(history.items.length, 3);
  assert.equal(history.items[0].eventId, "mu-new");
  assert.equal(history.items[0].eventTime, "2026-07-10T14:15:30.000Z");
  assert.equal(history.items[0].analystFirm, "North Star Securities");
  assert.equal(history.items[0].analystName, "Morgan Example");
  assert.equal(history.items[0].action, "Maintains / Raises");
  assert.equal(history.items[0].ratingCurrent, "Outperform");
  assert.equal(history.items[0].ratingPrior, "Neutral");
  assert.equal(history.items[0].priceTarget, 170);
  assert.equal(history.items[0].previousPriceTarget, 150);
  assert.equal(history.items[0].adjustedPriceTarget, 175);
  assert.equal(history.items[0].adjustedPreviousPriceTarget, 155);
  assert.equal(history.items[0].effectivePriceTarget, 175);
  assert.equal(history.items[0].smartScore, 4.5);
  assert.equal(history.items[0].overallSuccessRate, 68.2);
  assert.equal(history.items[0].totalRatings, 124);
  assert.equal(history.items[1].eventId, "zero-target");
  assert.equal(history.items[1].priceTarget, undefined);
  assert.equal(history.items[1].previousPriceTarget, undefined);
  assert.equal(history.items[1].adjustedPriceTarget, undefined);
  assert.equal(history.items[1].adjustedPreviousPriceTarget, undefined);
  assert.equal(history.items[1].effectivePriceTarget, undefined);
  assert.equal(history.items[2].eventId, "mu-old");
  assert.equal(history.items[2].effectivePriceTarget, 90);
  assert.equal(history.provenance.sourceUrl, ENDPOINT);
  assert.equal(history.provenance.sourceUrl?.includes(SECRET), false);
  assert.equal("rawJson" in history.items[0], false);
});

test("keeps a non-USD rating event but never relabels its targets as USD", async () => {
  const provider = providerWithRows([rating({
    id: "eur-history",
    currency: "EUR",
    rating_current: "Outperform",
    rating_prior: "Neutral",
    pt_current: 999,
    pt_prior: 888,
    adjusted_pt_current: 1_001,
    adjusted_pt_prior: 889,
  })]);

  const history = await provider.analyst?.getRatingHistory?.(
    INSTRUMENT,
    { dateFrom: "2026-01-01", dateTo: "2026-08-09", pageSize: 20 },
    CONTEXT,
  );

  assert.ok(history);
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].currency, "EUR");
  assert.equal(history.items[0].ratingCurrent, "Outperform");
  assert.equal(history.items[0].ratingPrior, "Neutral");
  assert.equal(history.items[0].priceTarget, undefined);
  assert.equal(history.items[0].previousPriceTarget, undefined);
  assert.equal(history.items[0].adjustedPriceTarget, undefined);
  assert.equal(history.items[0].adjustedPreviousPriceTarget, undefined);
  assert.equal(history.items[0].effectivePriceTarget, undefined);
});

test("rejects invalid history dates without making an upstream request", async () => {
  let requested = false;
  const provider = createBenzingaProvider({}, {
    fetch: async () => {
      requested = true;
      return json([]);
    },
    now: () => new Date(NOW),
  });

  await assert.rejects(
    provider.analyst!.getRatingHistory!(
      INSTRUMENT,
      { dateFrom: "2026-07-11", dateTo: "2024-01-01", pageSize: 1000 },
      CONTEXT,
    ),
    (error: unknown) => (
      error instanceof BenzingaProviderError && error.code === "invalid_request"
    ),
  );
  assert.equal(requested, false);
});

test("supports the Midas token aliases without leaking a credential into provenance", async () => {
  const requested: URL[] = [];
  const fetch: BenzingaFetch = async (input) => {
    requested.push(requestUrl(input));
    return json({ ratings: [rating()] });
  };
  const provider = createBenzingaProvider({
    BENZINGA_API_TOKEN: SECRET,
    BENZINGA_API_KEY: "legacy-must-not-win",
  }, {
    fetch,
    now: () => new Date(NOW),
    pageSize: 25,
  });

  const result = await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(requested[0].searchParams.get("token"), SECRET);
  assert.equal(requested[0].searchParams.get("pageSize"), "25");
  assert.equal(requested[0].searchParams.get("symbols"), "AAPL");
  assert.equal(requested[0].searchParams.get("pagesize"), "25");
  assert.equal(result?.provenance.sourceUrl?.includes(SECRET), false);

  let legacyToken: string | null = null;
  const legacy = createBenzingaProvider({ BENZINGA_API_KEY: "legacy-token" }, {
    fetch: async (input) => {
      legacyToken = requestUrl(input).searchParams.get("token");
      return json([]);
    },
    now: () => new Date(NOW),
  });
  await legacy.analyst?.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(legacyToken, "legacy-token");
});

test("builds consensus from each analyst-firm pair's latest validly timed event", async () => {
  const afterCutoff = Date.parse("2026-08-10T00:00:00.000Z") / 1_000;
  const rows = [
    rating({ id: "a-old", firm_id: "f-a", analyst_id: "a", date: "2026-07-01", pt_current: 150 }),
    rating({
      id: "a-new",
      firm_id: "f-a",
      analyst_id: "a",
      date: "2026-08-06",
      pt_current: 155,
      adjusted_pt_current: 160,
      rating_current: "Strong Buy",
    }),
    rating({ id: "b", firm_id: "f-b", analyst_id: "b", pt_current: 100, rating_current: "Outperform" }),
    rating({ id: "c", firm_id: "f-c", analyst_id: "c", pt_current: 120, rating_current: "Equal-Weight" }),
    rating({ id: "d", firm_id: "f-d", analyst_id: "d", pt_current: 80, rating_current: "Underperform" }),
    rating({ id: "e", firm_id: "f-e", analyst_id: "e", pt_current: 60, rating_current: "Strong Sell" }),
    rating({ id: "f", firm_id: "f-f", analyst_id: "f", pt_current: 140, rating_current: "Speculative" }),
    // A newest no-target event prevents an older target for the same pair from
    // being silently revived.
    rating({ id: "g-old", firm_id: "f-g", analyst_id: "g", date: "2026-07-01", pt_current: 200 }),
    rating({ id: "g-new", firm_id: "f-g", analyst_id: "g", date: "2026-08-07", pt_current: null }),
    rating({ id: "eur", firm_id: "f-eur", analyst_id: "eur", currency: "EUR", pt_current: 999 }),
    rating({ id: "other-symbol", firm_id: "f-msft", analyst_id: "msft", ticker: "MSFT", pt_current: 999 }),
    rating({ id: "future", firm_id: "f-future", analyst_id: "future", date: "2026-08-10", pt_current: 999 }),
    rating({ id: "old", firm_id: "f-old", analyst_id: "old", date: "2023-01-01", pt_current: 999 }),
    rating({ id: "late-update", firm_id: "f-late", analyst_id: "late", updated: afterCutoff, pt_current: 999 }),
    rating({ id: "no-identity", firm_id: null, analyst_id: null, analyst: null, analyst_name: null, pt_current: 999 }),
  ];
  const provider = providerWithRows(rows);

  const result = await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT);
  assert.ok(result);
  assert.equal(result.targetLow, 60);
  assert.equal(result.targetHigh, 160);
  assert.equal(result.targetConsensus, 110);
  assert.equal(result.targetMedian, 110);
  assert.equal(result.analystCount, 6);
  assert.equal(result.strongBuy, 1);
  assert.equal(result.buy, 1);
  assert.equal(result.hold, 1);
  assert.equal(result.sell, 1);
  assert.equal(result.strongSell, 1);
  assert.equal(result.forwardEps, undefined);
  assert.equal(result.forwardRevenue, undefined);
  assert.equal(result.provenance.asOf, "2026-08-06T14:00:00.000Z");
});

test("omits recommendation counts when Benzinga's raw language cannot be mapped", async () => {
  const provider = providerWithRows([rating({ rating_current: "Highly Convictional" })], "ratings");
  const result = await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT);
  assert.ok(result);
  assert.equal(result.analystCount, 1);
  assert.equal("strongBuy" in result, false);
  assert.equal("buy" in result, false);
  assert.equal("hold" in result, false);
  assert.equal("sell" in result, false);
  assert.equal("strongSell" in result, false);
});

test("normalizes Midas event times from America/New_York to UTC", async () => {
  const provider = providerWithRows([rating({
    date: "2026-07-10",
    time: "14:37:42",
    updated: Date.parse("2026-07-10T18:38:03.000Z") / 1_000,
    pt_current: "101",
    adjusted_pt_current: "101.00",
  })], "results");
  const result = await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT);

  assert.equal(result?.targetConsensus, 101);
  assert.equal(result?.provenance.asOf, "2026-07-10T18:37:42.000Z");
});

test("rejects nonexistent local times and returns null for empty or ineligible payloads", async (t) => {
  const invalidDst = rating({
    date: "2026-03-08",
    time: "02:30:00",
    updated: null,
  });
  for (const [name, shape] of [
    ["array", "array"],
    ["data", "data"],
    ["ratings", "ratings"],
    ["results", "results"],
  ] as const) {
    await t.test(name, async () => {
      const provider = providerWithRows([invalidDst], shape);
      assert.equal(await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT), null);
    });
  }
});

test("does not request out-of-scope instruments", async () => {
  let calls = 0;
  const provider = createBenzingaProvider({}, {
    fetch: async () => {
      calls += 1;
      return json([]);
    },
    now: () => new Date(NOW),
  });
  const invalid = { ...INSTRUMENT, symbol: "7203" } as unknown as Instrument;
  assert.equal(await provider.analyst?.getConsensus(invalid, CONTEXT), null);
  assert.equal(calls, 0);
});

test("sanitizes upstream, network, invalid-response, and configuration errors", async (t) => {
  await t.test("upstream", async () => {
    const provider = createBenzingaProvider({ BENZINGA_API_TOKEN: SECRET }, {
      fetch: async () => new Response(`private body ${SECRET}`, { status: 503 }),
      now: () => new Date(NOW),
    });
    await assert.rejects(
      provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
      expectSafeError([SECRET, ENDPOINT, "private body"], "upstream"),
    );
  });

  await t.test("network", async () => {
    const provider = createBenzingaProvider({}, {
      fetch: async () => {
        throw new Error(`network exposed ${SECRET} ${ENDPOINT}`);
      },
      now: () => new Date(NOW),
    });
    await assert.rejects(
      provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
      expectSafeError([SECRET, ENDPOINT, "network exposed"], "network"),
    );
  });

  await t.test("invalid response", async () => {
    const provider = createBenzingaProvider({}, {
      fetch: async () => new Response(SECRET, { status: 200 }),
      now: () => new Date(NOW),
    });
    await assert.rejects(
      provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
      expectSafeError([SECRET, ENDPOINT], "invalid_response"),
    );
  });

  await t.test("unknown success envelope", async () => {
    const provider = createBenzingaProvider({}, {
      fetch: async () => json({ message: "plan denied", error: { details: [] } }),
      now: () => new Date(NOW),
    });
    await assert.rejects(
      provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
      expectSafeError(["plan denied", ENDPOINT], "invalid_response"),
    );
  });

  await t.test("configuration", () => {
    assert.throws(
      () => createBenzingaProvider({
        BENZINGA_ANALYST_RATINGS_ENDPOINT: `not-a-url-${SECRET}`,
      }),
      expectSafeError([SECRET], "configuration"),
    );
    assert.throws(
      () => createBenzingaProvider({ BENZINGA_ANALYST_RATINGS_DISABLED: "true" }),
      expectSafeError([SECRET], "configuration"),
    );
  });
});

test("enforces a hard timeout even when fetch ignores AbortSignal", async () => {
  const fetch: BenzingaFetch = async () => new Promise<Response>(() => undefined);
  const provider = createBenzingaProvider({ BENZINGA_API_TOKEN: SECRET }, {
    fetch,
    now: () => new Date(NOW),
    timeoutMs: 5,
  });

  await assert.rejects(
    provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    expectSafeError([SECRET, ENDPOINT], "timeout"),
  );
});

test("strips query credentials from a developer-supplied endpoint", async () => {
  let captured: URL | undefined;
  const provider = createBenzingaProvider({
    BENZINGA_ANALYST_RATINGS_ENDPOINT: `https://ratings.example.test/custom?private=${SECRET}`,
  }, {
    fetch: async (input) => {
      captured = requestUrl(input);
      return json([rating()]);
    },
    now: () => new Date(NOW),
  });

  const result = await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT);
  assert.ok(captured);
  assert.equal(captured.searchParams.has("private"), false);
  assert.equal(result?.provenance.sourceUrl, "https://ratings.example.test/custom");
});
