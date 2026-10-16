import assert from "node:assert/strict";
import test from "node:test";

import {
  clearGoogleFinanceProviderCache,
  createGoogleFinanceProvider,
  extractGoogleFinanceAnalystData,
  GoogleFinanceProviderError,
  type GoogleFinanceFetch,
} from "../api/google-finance/analyst.server";
import type {
  Instrument,
  ProviderRequestContext,
} from "../src/app/platform/provider-contracts";

const NOW = new Date("2026-08-16T16:00:00.000Z");
const CONTEXT = {
  requestId: "google-finance-analyst-test",
  asOf: NOW.toISOString(),
} as const satisfies ProviderRequestContext;

const INSTRUMENT = {
  instrumentId: "us:XNAS:NBIS",
  symbol: "NBIS",
  name: "Nebius Group N.V.",
  assetType: "common_stock",
  active: true,
  listingCountry: "US",
  exchange: "NASDAQ Global Select Market",
  exchangeMic: "XNAS",
  currency: "USD",
  provenance: {
    providerId: "fixture",
    sourceId: "fixture:NBIS",
    asOf: NOW.toISOString(),
    ingestedAt: NOW.toISOString(),
  },
} as const satisfies Instrument;

const SUMMARY = [
  "Nebius Group",
  "USD",
  144,
  410,
  264.22,
  -4.85,
  10,
  "Buy",
  6,
  0,
  4,
  null,
  2,
] as const;

function ratingRow(input: Readonly<{
  id: string;
  analyst: string;
  firm: string;
  rating: string;
  date: string;
  target?: number;
  action?: string;
  timestamp?: string;
  totalRatings?: number;
}>) {
  const row: unknown[] = Array.from({ length: 30 }, () => null);
  row[0] = input.id;
  row[1] = input.analyst;
  row[2] = input.firm;
  row[3] = input.rating;
  row[4] = input.date;
  row[5] = `https://www.tipranks.com/news/example/${input.id}`;
  row[9] = 0.67;
  row[10] = 12.3;
  row[11] = input.totalRatings ?? 42;
  row[12] = input.totalRatings === 0 ? 0 : 28;
  row[13] = input.totalRatings === 0 ? 0 : 4.5;
  row[19] = input.target ?? 0;
  row[20] = input.target === undefined ? 0 : 1;
  row[21] = input.target === undefined ? "" : "USD";
  row[22] = input.target ?? 0;
  row[23] = input.target === undefined ? 0 : 1;
  row[24] = input.target === undefined ? "" : "USD";
  row[26] = input.timestamp ?? "2026-08-14T12:00:00";
  row[27] = input.action ?? "Maintained";
  return row;
}

const NBIS_ROWS = [
  ratingRow({ id: "northland", analyst: "Michael Latimore", firm: "Northland Securities", rating: "Buy", date: "08/13/2026", target: 410, action: "Reiterated", timestamp: "2026-08-13T10:00:00" }),
  ratingRow({ id: "morgan", analyst: "Andrew McNellis", firm: "Morgan Stanley", rating: "Hold", date: "08/13/2026", target: 144, action: "Reiterated", timestamp: "2026-08-13T11:00:00" }),
  ratingRow({ id: "bofa", analyst: "Brad Sills", firm: "Bank of America", rating: "Buy", date: "08/13/2026", target: 310, action: "Reiterated", timestamp: "2026-08-13T12:00:00" }),
  ratingRow({ id: "citi", analyst: "Tyler Radke", firm: "Citi", rating: "Buy", date: "08/14/2026", target: 324, timestamp: "2026-08-14T12:00:00" }),
  ratingRow({ id: "goldman", analyst: "Gabriela Borges", firm: "Goldman Sachs", rating: "Buy", date: "08/10/2026", target: 286, timestamp: "2026-08-10T12:00:00" }),
  ratingRow({ id: "davidson", analyst: "Gil Luria", firm: "D.A. Davidson", rating: "Hold", date: "08/10/2026", target: 175, timestamp: "2026-08-10T13:00:00" }),
  ratingRow({ id: "piper", analyst: "Brent Bracelin", firm: "Piper Sandler", rating: "Hold", date: "08/04/2026", target: 224, action: "Initiated", timestamp: "2026-08-04T12:00:00" }),
  ratingRow({ id: "baird", analyst: "William Power", firm: "Robert W. Baird", rating: "Buy", date: "07/21/2026", target: 250, action: "Initiated", timestamp: "2026-07-21T12:00:00" }),
  ratingRow({ id: "freedom", analyst: "Leonid Timashev", firm: "Freedom Capital Markets", rating: "Buy", date: "07/20/2026", action: "Upgraded", timestamp: "2026-07-20T12:00:00" }),
  ratingRow({ id: "exane", analyst: "Stefan Slowinski", firm: "Exane BNP Paribas", rating: "Hold", date: "06/02/2026", target: 255, action: "Initiated", timestamp: "2026-06-02T12:00:00" }),
] as const;

function callback(key: string, data: unknown) {
  return `AF_initDataCallback({key:'${key}',hash:'changing-hash',data:${JSON.stringify(data)},sideChannel:{}});`;
}

function page(input: Readonly<{
  symbol?: string;
  exchange?: string;
  summary?: readonly unknown[];
  rows?: readonly unknown[][];
  analystKey?: string;
  includeListing?: boolean;
}> = {}) {
  const symbol = input.symbol ?? "NBIS";
  const exchange = input.exchange ?? "NASDAQ";
  const identity = input.includeListing === false
    ? callback("ds:3", [[["unrelated"]]])
    : callback("ds:3", [[["instrument-id", [symbol, exchange], "Company"]]]);
  return [
    "<!doctype html><html><body>",
    callback("ds:1", [["unrelated ds:7 marker"], []]),
    identity,
    // This expression is deliberately never evaluated by the extractor.
    `AF_initDataCallback({key:'${input.analystKey ?? "ds:7"}',before:(()=>{throw new Error('must not execute')})(),data:${JSON.stringify([
      input.summary ?? SUMMARY,
      input.rows ?? NBIS_ROWS,
    ])},sideChannel:{}});`,
    "</body></html>",
  ].join("");
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

test("extracts the AF_initDataCallback data array without executing page JavaScript", () => {
  const parsed = extractGoogleFinanceAnalystData(
    page({ analystKey: "ds:42" }),
    { symbol: "NBIS", exchange: "NASDAQ" },
  );
  assert.equal(parsed.callbackKey, "ds:42", "shape detection survives a callback-key change");
  assert.deepEqual(parsed.summary, {
    companyName: "Nebius Group",
    currency: "USD",
    targetLow: 144,
    targetHigh: 410,
    targetConsensus: 264.22,
    targetUpsidePercent: -4.85,
    analystCount: 10,
    consensus: "Buy",
    buy: 6,
    sell: 0,
    hold: 4,
  });
  assert.equal(parsed.rows.length, 10);
  assert.equal(parsed.rows[0]?.[2], "Northland Securities");
});

test("fails closed when a non-empty analyst row no longer matches the known shape", () => {
  assert.throws(
    () => extractGoogleFinanceAnalystData(
      page({ rows: [NBIS_ROWS[0], ["unexpected-envelope-row"]] }),
      { symbol: "NBIS", exchange: "NASDAQ" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof GoogleFinanceProviderError);
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );
});

test("reproduces NBIS ten ratings, nine targets, and the 264.22 target average", async () => {
  clearGoogleFinanceProviderCache();
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const fetch: GoogleFinanceFetch = async (input, init) => {
    capturedUrl = new URL(input instanceof Request ? input.url : String(input));
    capturedInit = init;
    return htmlResponse(page());
  };
  const provider = createGoogleFinanceProvider({}, {
    fetch,
    now: () => new Date(NOW),
  });
  const result = await provider.analyst!.getConsensus(INSTRUMENT, CONTEXT);

  assert.ok(capturedUrl);
  assert.ok(capturedInit);
  assert.equal(capturedUrl.origin + capturedUrl.pathname, "https://www.google.com/finance/beta/quote/NBIS:NASDAQ");
  assert.equal(capturedUrl.searchParams.get("tab"), "analysis");
  assert.equal(capturedUrl.searchParams.get("hl"), "en");
  assert.equal(capturedInit.redirect, "manual");
  assert.equal(new Headers(capturedInit.headers).get("Accept-Language"), "en-US,en;q=0.9");
  assert.equal(result?.firmCount, 10);
  assert.equal(result?.ratingCount, 10);
  assert.equal(result?.priceTargetCount, 9);
  assert.equal(result?.analystCount, 9);
  assert.equal(result?.buy, 6);
  assert.equal(result?.hold, 4);
  assert.equal(result?.targetLow, 144);
  assert.equal(result?.targetHigh, 410);
  assert.equal(result?.targetConsensus, 264.22222222222223);
  assert.equal(result?.constituents?.find((item) => item.firm.includes("Freedom"))?.priceTarget, undefined);
  assert.equal(result?.provenance.providerId, "google-finance");
});

test("maps Yahoo-style class-share symbols only at the Google Finance boundary", async () => {
  clearGoogleFinanceProviderCache();
  let capturedUrl: URL | undefined;
  const classShare = {
    ...INSTRUMENT,
    instrumentId: "us:XNYS:BRK-B",
    symbol: "BRK-B",
    name: "Berkshire Hathaway Inc. Class B",
    exchange: "NYSE",
    exchangeMic: "XNYS",
  } as const satisfies Instrument;
  const rows = [ratingRow({
    id: "berkshire-target",
    analyst: "Class Share Analyst",
    firm: "Class Share Research",
    rating: "Buy",
    date: "08/14/2026",
    target: 604,
    timestamp: "2026-08-14T12:00:00",
  })];
  const provider = createGoogleFinanceProvider({}, {
    fetch: async (input) => {
      capturedUrl = new URL(input instanceof Request ? input.url : String(input));
      return htmlResponse(page({ symbol: "BRK.B", exchange: "NYSE", rows }));
    },
    now: () => new Date(NOW),
  });
  const result = await provider.analyst!.getConsensus(classShare, CONTEXT);

  assert.ok(capturedUrl);
  assert.match(capturedUrl.pathname, /\/BRK\.B:NYSE$/);
  assert.equal(result?.instrumentId, classShare.instrumentId);
  assert.equal(result?.targetConsensus, 604);
  assert.equal(result?.constituents?.[0]?.providerId, "google-finance");
});

test("does not present zero-filled analyst accuracy placeholders as measured scores", async () => {
  clearGoogleFinanceProviderCache();
  const rows = [ratingRow({
    id: "no-track-record",
    analyst: "New Analyst",
    firm: "New Research",
    rating: "Buy",
    date: "08/14/2026",
    target: 300,
    totalRatings: 0,
    timestamp: "2026-08-14T12:00:00",
  })];
  const provider = createGoogleFinanceProvider({}, {
    fetch: async () => htmlResponse(page({ rows })),
    now: () => new Date(NOW),
  });
  const result = await provider.analyst!.getRatingHistory!(INSTRUMENT, {
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
  }, CONTEXT);

  assert.equal(result.items[0]?.totalRatings, 0);
  assert.equal(result.items[0]?.analystStarRating, undefined);
  assert.equal(result.items[0]?.overallSuccessRate, undefined);
});

test("accepts matching listings with no analyst coverage but rejects an invalid or wrong listing", async () => {
  clearGoogleFinanceProviderCache();
  const emptySummary = ["", "", 0, 0, 0, 0, 0, "", 0, 0, 0, null, 0] as const;
  const validProvider = createGoogleFinanceProvider({}, {
    fetch: async () => htmlResponse(page({ summary: emptySummary, rows: [] })),
    now: () => new Date(NOW),
  });
  assert.equal(await validProvider.analyst!.getConsensus(INSTRUMENT, CONTEXT), null);

  clearGoogleFinanceProviderCache();
  const invalidProvider = createGoogleFinanceProvider({}, {
    fetch: async () => htmlResponse(page({ summary: emptySummary, rows: [], includeListing: false })),
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => invalidProvider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof GoogleFinanceProviderError);
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );

  assert.throws(
    () => extractGoogleFinanceAnalystData(
      page({ symbol: "NBIS", exchange: "NYSE", summary: emptySummary, rows: [] }),
      { symbol: "NBIS", exchange: "NASDAQ" },
    ),
    GoogleFinanceProviderError,
  );
});

test("rejects malformed callback HTML and oversized responses with safe errors", async () => {
  assert.throws(
    () => extractGoogleFinanceAnalystData("<html>captcha</html>", { symbol: "NBIS", exchange: "NASDAQ" }),
    GoogleFinanceProviderError,
  );

  clearGoogleFinanceProviderCache();
  const provider = createGoogleFinanceProvider({}, {
    fetch: async () => new Response(page(), {
      headers: {
        "content-type": "text/html",
        "content-length": "100001",
      },
    }),
    maxHtmlBytes: 100_000,
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof GoogleFinanceProviderError);
      assert.equal(error.code, "invalid_response");
      assert.equal(error.message.includes("HTML"), false);
      return true;
    },
  );

  clearGoogleFinanceProviderCache();
  const chunkedProvider = createGoogleFinanceProvider({}, {
    fetch: async () => htmlResponse("x".repeat(100_001)),
    maxHtmlBytes: 100_000,
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => chunkedProvider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof GoogleFinanceProviderError);
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );
});

test("rejects impossible calendar dates before fetching Google Finance", async () => {
  clearGoogleFinanceProviderCache();
  let calls = 0;
  const provider = createGoogleFinanceProvider({}, {
    fetch: async () => {
      calls += 1;
      return htmlResponse(page());
    },
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.analyst!.getRatingHistory!(INSTRUMENT, {
      dateFrom: "2026-02-30",
      dateTo: "2026-08-16",
    }, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof GoogleFinanceProviderError);
      assert.equal(error.code, "invalid_request");
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("applies timeout through response body parsing", async () => {
  clearGoogleFinanceProviderCache();
  const provider = createGoogleFinanceProvider({}, {
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: () => new Promise<string>(() => {}),
    }) as Response,
    timeoutMs: 5,
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof GoogleFinanceProviderError);
      assert.equal(error.code, "timeout");
      return true;
    },
  );
});
