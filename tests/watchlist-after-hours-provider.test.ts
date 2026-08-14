import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import { POST } from "../src/app/api/v1/watchlists/after-hours/route";
import {
  isNominalUsRegularSession,
  millisecondsUntilNextUsSessionBoundary,
  shouldReplaceMarketSessionObservation,
  shouldUseAfterHoursPrices,
  type MarketSessionObservation,
} from "../src/app/features/watchlist/after-hours-stream";
import type { WatchlistAfterHoursResponse } from "../src/app/platform/provider-contracts";
import {
  createTradingViewSidecarProvider,
  DEFAULT_TRADINGVIEW_SYNTHETIC_EXCHANGES,
  loadTradingViewScannerLatestCloses,
  TradingViewSidecarError,
  tradingViewSyntheticExchanges,
  type TradingViewSidecarFetch,
} from "../api/tradingview-websocket/index.server";

const SIDECAR_PAYLOAD = {
  schemaVersion: "unicorn.tradingview-sidecar.v1",
  exchange: "BINANCE",
  exchanges: ["BINANCE", "BITGET", "KUCOIN", "MEXC"],
  resolutionStrategy: "ordered_fallback",
  items: [
    {
      symbol: "AAPL",
      sourceSymbol: "BINANCE:AAPLUSDT.P",
      close: 312.34,
      currency: "USDT",
      source: "tradingview-websocket",
      updatedAt: "2026-08-09T01:30:00Z",
    },
    {
      symbol: "ZZZZZZZZZZ",
      sourceSymbol: "BINANCE:ZZZZZZZZZZUSDT.P",
      close: null,
      currency: "USDT",
      source: "tradingview-websocket",
      updatedAt: null,
    },
  ],
  ingestedAt: "2026-08-09T01:30:01Z",
} as const;

const OKLO_PAYLOAD = {
  schemaVersion: "unicorn.tradingview-sidecar.v1",
  exchange: "BINANCE",
  exchanges: ["BINANCE", "BITGET", "KUCOIN", "MEXC"],
  resolutionStrategy: "ordered_fallback",
  items: [
    {
      symbol: "AAPL",
      sourceSymbol: "BINANCE:AAPLUSDT.P",
      close: 312.34,
      currency: "USDT",
      source: "tradingview-websocket",
      updatedAt: "2026-08-09T01:30:00Z",
    },
    {
      symbol: "OKLO",
      sourceSymbol: "BITGET:OKLOUSDT.P",
      close: 48.51,
      currency: "USDT",
      source: "tradingview-websocket",
      updatedAt: "2026-08-09T01:30:00Z",
    },
  ],
  ingestedAt: "2026-08-09T01:30:01Z",
} as const;

function sessionObservation(
  state: MarketSessionObservation["state"],
  observedAt: string,
): MarketSessionObservation {
  return { state, observedAt: Date.parse(observedAt) };
}

test("switches the derived price exactly at nominal U.S. market boundaries", () => {
  assert.equal(shouldUseAfterHoursPrices([]), false);
  assert.equal(
    shouldUseAfterHoursPrices([], new Date("2026-08-10T13:29:59.999Z")),
    true,
  );
  assert.equal(
    shouldUseAfterHoursPrices([], new Date("2026-08-10T13:30:00.000Z")),
    false,
  );
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("pre_market", "2026-08-10T13:30:01.000Z")],
      new Date("2026-08-10T13:30:01.000Z"),
    ),
    false,
    "a delayed pre-market provider state cannot reverse the open transition",
  );
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("closed", "2026-08-10T13:30:01.000Z")],
      new Date("2026-08-10T13:30:01.000Z"),
    ),
    false,
    "a freshly ingested hosted-provider closure cannot reverse the open transition",
  );
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("closed", "2026-08-10T13:29:59.900Z")],
      new Date("2026-08-10T13:30:00.100Z"),
    ),
    false,
    "a delayed closed SSE event retains its provider ingestion time across the open",
  );
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("regular", "2026-08-10T19:59:59.000Z")],
      new Date("2026-08-10T20:00:00.000Z"),
    ),
    true,
    "a pre-close regular quote cannot delay the 16:00 transition",
  );
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("regular", "2026-08-10T20:00:01.000Z")],
      new Date("2026-08-10T20:00:01.000Z"),
    ),
    true,
    "a lagging regular provider state cannot reverse the close transition",
  );
  assert.equal(
    shouldUseAfterHoursPrices([], new Date("2026-08-09T16:00:00.000Z")),
    true,
    "weekends remain outside the regular session",
  );
});

test("commits same-state observations across a boundary without accepting stale events", () => {
  const beforeOpen = sessionObservation("closed", "2026-09-07T13:29:55.000Z");
  const atOpen = sessionObservation("closed", "2026-09-07T13:30:00.000Z");
  assert.equal(shouldReplaceMarketSessionObservation(beforeOpen, atOpen), true);
  assert.equal(
    shouldReplaceMarketSessionObservation(
      sessionObservation("closed", "2026-09-07T13:30:01.000Z"),
      sessionObservation("closed", "2026-09-07T13:30:10.000Z"),
    ),
    false,
  );
  assert.equal(shouldReplaceMarketSessionObservation(atOpen, beforeOpen), false);
});

test("keeps nominal boundaries authoritative over every fresh provider state", () => {
  const holidayNow = new Date("2026-09-07T14:00:00.000Z");
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("closed", "2026-09-07T13:59:30.000Z")],
      holidayNow,
    ),
    false,
    "a provider-closed state cannot keep or restore the visible value after 09:30",
  );
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("regular", "2026-09-07T13:59:30.000Z")],
      holidayNow,
    ),
    false,
  );
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("after_hours", "2026-11-27T17:59:45.000Z")],
      new Date("2026-11-27T18:00:00.000Z"),
    ),
    false,
    "provider state cannot enable the visible value before the nominal 16:00 boundary",
  );
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("after_hours", "2026-11-27T17:55:00.000Z")],
      new Date("2026-11-27T18:00:00.000Z"),
    ),
    false,
    "a stale provider state falls back to the nominal regular clock",
  );
  assert.equal(
    shouldUseAfterHoursPrices(
      [sessionObservation("after_hours", "2026-08-10T13:29:59.000Z")],
      new Date("2026-08-10T13:30:00.000Z"),
    ),
    false,
    "a pre-open observation does not cross the opening boundary",
  );
});

test("ignores mixed per-symbol provider sessions during nominal regular hours", () => {
  const now = new Date("2026-08-10T17:00:00.000Z");
  assert.equal(
    shouldUseAfterHoursPrices([
      sessionObservation("after_hours", "2026-08-10T16:59:55.000Z"),
      sessionObservation("regular", "2026-08-10T16:59:50.000Z"),
    ], now),
    false,
    "the New York clock keeps the shared U.S. session disabled",
  );
  assert.equal(
    shouldUseAfterHoursPrices([
      sessionObservation("regular", "2026-08-10T16:59:50.000Z"),
      sessionObservation("after_hours", "2026-08-10T16:59:55.000Z"),
    ], now),
    false,
    "event order cannot change the nominal-clock result",
  );
  assert.equal(
    shouldUseAfterHoursPrices([
      sessionObservation("after_hours", "2026-08-10T16:59:55.000Z"),
      sessionObservation("regular", "2026-08-10T16:58:00.000Z"),
    ], now),
    false,
    "fresh non-regular observations cannot override nominal regular hours",
  );
  assert.equal(
    shouldUseAfterHoursPrices([
      sessionObservation("closed", "2026-08-10T16:59:55.000Z"),
      sessionObservation("after_hours", "2026-08-10T16:59:50.000Z"),
    ], now),
    false,
  );
});

test("calculates exact session boundaries across U.S. daylight-saving changes", () => {
  assert.equal(isNominalUsRegularSession(new Date("2026-03-09T13:30:00.000Z")), true);
  assert.equal(isNominalUsRegularSession(new Date("2026-11-02T14:30:00.000Z")), true);
  assert.equal(
    millisecondsUntilNextUsSessionBoundary(new Date("2026-03-09T13:29:59.000Z")),
    1_000,
  );
  assert.equal(
    millisecondsUntilNextUsSessionBoundary(new Date("2026-03-09T13:30:00.000Z")),
    6.5 * 60 * 60_000,
  );
  assert.equal(
    millisecondsUntilNextUsSessionBoundary(new Date("2026-11-02T14:29:59.000Z")),
    1_000,
  );
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("batches derived TradingView symbols without putting the token or tickers in the URL", async () => {
  const token = "sidecar-bearer-secret";
  let requestUrl: URL | undefined;
  let requestBody: unknown;
  const fetch: TradingViewSidecarFetch = async (input, init) => {
    requestUrl = new URL(input instanceof Request ? input.url : String(input));
    requestBody = JSON.parse(String(init?.body));
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    return json(SIDECAR_PAYLOAD);
  };
  const adapter = createTradingViewSidecarProvider({
    UNICORN_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
    UNICORN_TRADINGVIEW_SIDECAR_TOKEN: token,
  }, { fetch });

  const items = await adapter.syntheticMarket.getLatestCloses(
    ["aapl", "ZZZZZZZZZZ"],
    { requestId: "request-1" },
  );
  assert.equal(requestUrl?.pathname, "/v1/latest-closes");
  assert.equal(requestUrl?.search, "");
  assert.ok(!requestUrl?.toString().includes(token));
  assert.deepEqual(requestBody, { symbols: ["AAPL", "ZZZZZZZZZZ"] });
  assert.equal(items[0]?.close, 312.34);
  assert.equal(items[0]?.source, "tradingview-websocket");
  assert.equal(items[0]?.updatedAt, "2026-08-09T01:30:00.000Z");
  assert.equal(items[1]?.close, null);
  assert.equal(items[1]?.updatedAt, null);
});

test("rejects malformed sidecar values instead of guessing a close", async () => {
  const adapter = createTradingViewSidecarProvider({
    UNICORN_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
  }, {
    fetch: async () => json({
      ...SIDECAR_PAYLOAD,
      items: [
        { ...SIDECAR_PAYLOAD.items[0], close: "312.34" },
        SIDECAR_PAYLOAD.items[1],
      ],
    }),
  });
  await assert.rejects(
    () => adapter.syntheticMarket.getLatestCloses(
      ["AAPL", "ZZZZZZZZZZ"],
      { requestId: "request-2" },
    ),
    (error: unknown) => error instanceof TradingViewSidecarError && error.code === "invalid_response",
  );
});

test("resolves each ticker from the ordered server-owned exchange candidates", async () => {
  assert.deepEqual(
    tradingViewSyntheticExchanges({}),
    DEFAULT_TRADINGVIEW_SYNTHETIC_EXCHANGES,
  );
  assert.deepEqual(
    tradingViewSyntheticExchanges({
      UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES: "kucoin, bitget",
    }),
    ["KUCOIN", "BITGET"],
  );

  const adapter = createTradingViewSidecarProvider({
    UNICORN_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
  }, { fetch: async () => json(OKLO_PAYLOAD) });
  const items = await adapter.syntheticMarket.getLatestCloses(
    ["AAPL", "OKLO"],
    { requestId: "request-oklo" },
  );

  assert.equal(items[0]?.sourceSymbol, "BINANCE:AAPLUSDT.P");
  assert.equal(items[1]?.sourceSymbol, "BITGET:OKLOUSDT.P");
  assert.equal(items[1]?.close, 48.51);
});

test("rejects malformed exchange configuration and unconfigured response sources", async () => {
  for (const configured of ["BINANCE,BINANCE", "BINANCE, bad exchange", ",BINANCE"]) {
    assert.throws(
      () => tradingViewSyntheticExchanges({
        UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES: configured,
      }),
      (error: unknown) => error instanceof TradingViewSidecarError && error.code === "configuration",
    );
  }

  const adapter = createTradingViewSidecarProvider({
    UNICORN_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
  }, {
    fetch: async () => json({
      ...OKLO_PAYLOAD,
      items: [
        OKLO_PAYLOAD.items[0],
        { ...OKLO_PAYLOAD.items[1], sourceSymbol: "GATEIO:OKLOUSDT.P" },
      ],
    }),
  });
  await assert.rejects(
    () => adapter.syntheticMarket.getLatestCloses(
      ["AAPL", "OKLO"],
      { requestId: "request-unconfigured-source" },
    ),
    (error: unknown) => error instanceof TradingViewSidecarError && error.code === "invalid_response",
  );
});

test("watchlist API makes one authenticated sidecar request for the whole symbol batch", async () => {
  const token = "route-sidecar-secret";
  let requestCount = 0;
  let capturedPath = "";
  let capturedAuthorization = "";
  let capturedBody = "";
  const server = createServer((request, response) => {
    requestCount += 1;
    capturedPath = request.url ?? "";
    capturedAuthorization = request.headers.authorization ?? "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { capturedBody += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(SIDECAR_PAYLOAD));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const previousUrl = process.env.UNICORN_TRADINGVIEW_SIDECAR_URL;
  const previousToken = process.env.UNICORN_TRADINGVIEW_SIDECAR_TOKEN;
  process.env.UNICORN_TRADINGVIEW_SIDECAR_URL = `http://127.0.0.1:${address.port}`;
  process.env.UNICORN_TRADINGVIEW_SIDECAR_TOKEN = token;
  try {
    const response = await POST(new Request("http://localhost/api/v1/watchlists/after-hours", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols: ["aapl", "ZZZZZZZZZZ"] }),
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as WatchlistAfterHoursResponse;
    assert.equal(payload.schemaVersion, "unicorn.watchlist-after-hours.v1");
    assert.equal(payload.exchange, "BINANCE");
    assert.deepEqual(payload.exchanges, ["BINANCE", "BITGET", "KUCOIN", "MEXC"]);
    assert.equal(payload.items[0]?.sourceSymbol, "BINANCE:AAPLUSDT.P");
    assert.equal(payload.items[1]?.close, null);
    assert.equal(payload.selectedProvider, "tradingview-websocket");
    assert.equal(payload.streamSupported, true);
    assert.equal(payload.streamTransport, "sse");
    assert.equal(requestCount, 1);
    assert.equal(capturedPath, "/v1/latest-closes");
    assert.equal(capturedAuthorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(capturedBody), { symbols: ["AAPL", "ZZZZZZZZZZ"] });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousUrl === undefined) delete process.env.UNICORN_TRADINGVIEW_SIDECAR_URL;
    else process.env.UNICORN_TRADINGVIEW_SIDECAR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.UNICORN_TRADINGVIEW_SIDECAR_TOKEN;
    else process.env.UNICORN_TRADINGVIEW_SIDECAR_TOKEN = previousToken;
  }
});

test("Worker scanner resolves exact USDT.P symbols with ordered exchange fallback", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetch: TradingViewSidecarFetch = async (input, init) => {
    requestedUrl = input instanceof Request ? input.url : String(input);
    requestedInit = init;
    return Response.json({
      totalCount: 4,
      data: [
        {
          s: "BINANCE:AAPLUSDT.P",
          d: [303.2, 1_786_603_900, "USDT", "streaming", "swap", "crypto", "BINANCE"],
        },
        {
          s: "BITGET:AAPLUSDT.P",
          d: [303.05, 1_786_604_301, "USDT", "streaming", "swap", "crypto", "BITGET"],
        },
        {
          s: "BINANCE:NVDAUSDT.P",
          d: [224.49, 1_786_604_348, "USDT", "streaming", "swap", "crypto", "BINANCE"],
        },
        {
          s: "KUCOIN:NVDAUSDT.P",
          d: [224.3, 1_786_604_342, "USDT", "streaming", "swap", "crypto", "KUCOIN"],
        },
      ],
    });
  };

  const items = await loadTradingViewScannerLatestCloses(
    {},
    ["aapl", "nvda", "oklo"],
    { requestId: "scanner-contract" },
    { fetch, now: () => new Date("2026-08-13T07:00:00.000Z") },
  );

  assert.equal(requestedUrl, "https://scanner.tradingview.com/crypto/scan");
  assert.equal(requestedInit?.method, "POST");
  assert.equal(requestedInit?.cache, "no-store");
  assert.equal(new Headers(requestedInit?.headers).get("cache-control"), "no-cache");
  const body = JSON.parse(String(requestedInit?.body)) as {
    symbols: { tickers: string[]; query: { types: unknown[] } };
    columns: string[];
    range: number[];
  };
  assert.deepEqual(body.columns, [
    "close",
    "update_time",
    "currency",
    "update_mode",
    "type",
    "subtype",
    "exchange",
  ]);
  assert.deepEqual(body.range, [0, 12]);
  assert.deepEqual(body.symbols.tickers.slice(0, 4), [
    "BINANCE:AAPLUSDT.P",
    "BITGET:AAPLUSDT.P",
    "KUCOIN:AAPLUSDT.P",
    "MEXC:AAPLUSDT.P",
  ]);
  assert.deepEqual(items, [
    {
      symbol: "AAPL",
      sourceSymbol: "BITGET:AAPLUSDT.P",
      close: 303.05,
      currency: "USDT",
      source: "tradingview-websocket",
      updatedAt: "2026-08-13T06:58:21.000Z",
    },
    {
      symbol: "NVDA",
      sourceSymbol: "BINANCE:NVDAUSDT.P",
      close: 224.49,
      currency: "USDT",
      source: "tradingview-websocket",
      updatedAt: "2026-08-13T06:59:08.000Z",
    },
    {
      symbol: "OKLO",
      sourceSymbol: "BINANCE:OKLOUSDT.P",
      close: null,
      currency: "USDT",
      source: "tradingview-websocket",
      updatedAt: null,
    },
  ]);
});

test("Worker scanner returns null when every continuous USDT.P venue is stale", async () => {
  const items = await loadTradingViewScannerLatestCloses(
    {},
    ["AAPL"],
    { requestId: "scanner-closed-market" },
    {
      fetch: async () => Response.json({
        totalCount: 2,
        data: [
          {
            s: "BINANCE:AAPLUSDT.P",
            d: [
              302.9,
              1_786_176_000,
              "USDT",
              "streaming",
              "swap",
              "crypto",
              "BINANCE",
            ],
          },
          {
            s: "BITGET:AAPLUSDT.P",
            d: [
              303,
              1_786_176_060,
              "USDT",
              "streaming",
              "swap",
              "crypto",
              "BITGET",
            ],
          },
        ],
      }),
      now: () => new Date("2026-08-13T07:00:00.000Z"),
    },
  );

  assert.equal(items[0]?.sourceSymbol, "BINANCE:AAPLUSDT.P");
  assert.equal(items[0]?.close, null);
  assert.equal(items[0]?.updatedAt, null);
  assert.equal(items[0]?.currency, "USDT");
});

test("Worker scanner accepts the 5m boundary and rejects the first older second", async () => {
  const items = await loadTradingViewScannerLatestCloses(
    {},
    ["AAPL", "NVDA"],
    { requestId: "scanner-absolute-freshness-boundary" },
    {
      fetch: async () => Response.json({
        totalCount: 2,
        data: [
          {
            s: "BINANCE:AAPLUSDT.P",
            d: [303, 1_786_604_100, "USDT", "streaming", "swap", "crypto", "BINANCE"],
          },
          {
            s: "BINANCE:NVDAUSDT.P",
            d: [224, 1_786_604_099, "USDT", "streaming", "swap", "crypto", "BINANCE"],
          },
        ],
      }),
      now: () => new Date("2026-08-13T07:00:00.000Z"),
    },
  );

  assert.equal(items[0]?.close, 303, "exactly 5m old remains current");
  assert.equal(items[0]?.updatedAt, "2026-08-13T06:55:00.000Z");
  assert.equal(items[1]?.close, null, "5m01s old is no longer current");
  assert.equal(items[1]?.updatedAt, null);
});

test("Worker scanner rejects unknown, duplicate, mislabeled, delayed, or future quote data", async () => {
  const valid = [303, 1_786_604_348, "USDT", "streaming", "swap", "crypto", "BINANCE"];
  const malformedRows = [
    [{ s: "GATEIO:AAPLUSDT.P", d: [...valid.slice(0, -1), "GATEIO"] }],
    [
      { s: "BINANCE:AAPLUSDT.P", d: valid },
      { s: "BINANCE:AAPLUSDT.P", d: [303, 1_786_604_349, ...valid.slice(2)] },
    ],
    [{ s: "BINANCE:AAPLUSDT.P", d: [303, 1_786_604_348, "USD", ...valid.slice(3)] }],
    [{ s: "BINANCE:AAPLUSDT.P", d: [303, 1_786_604_348, "USDT", "delayed_streaming_900", ...valid.slice(4)] }],
    [{ s: "BINANCE:AAPLUSDT.P", d: [303, 1_786_604_348, "USDT", "streaming", "spot", ...valid.slice(5)] }],
    [{ s: "BINANCE:AAPLUSDT.P", d: [303, 1_786_604_348, "USDT", "streaming", "swap", "stock", "BINANCE"] }],
    [{ s: "BINANCE:AAPLUSDT.P", d: [...valid.slice(0, -1), "BITGET"] }],
    [{ s: "BINANCE:AAPLUSDT.P", d: [303, 1_786_604_500, ...valid.slice(2)] }],
  ];
  for (const data of malformedRows) {
    await assert.rejects(
      () => loadTradingViewScannerLatestCloses(
        {},
        ["AAPL"],
        { requestId: "scanner-malformed" },
        {
          fetch: async () => Response.json({ totalCount: data.length, data }),
          now: () => new Date("2026-08-13T07:00:00.000Z"),
        },
      ),
      (error: unknown) => error instanceof TradingViewSidecarError
        && error.code === "invalid_response",
    );
  }
});

test("Worker scanner cancels oversized bodies and reports a timeout during body streaming", async () => {
  let oversizedBodyCanceled = false;
  const oversizedBody = new ReadableStream<Uint8Array>({
    pull() {
      // The declared size must fail before the body is consumed.
    },
    cancel() {
      oversizedBodyCanceled = true;
    },
  });
  await assert.rejects(
    () => loadTradingViewScannerLatestCloses(
      {},
      ["AAPL"],
      { requestId: "scanner-oversized" },
      {
        fetch: async () => new Response(oversizedBody, {
          headers: {
            "content-length": String(600 * 1_024),
            "content-type": "application/json",
          },
        }),
      },
    ),
    (error: unknown) => error instanceof TradingViewSidecarError
      && error.code === "invalid_response",
  );
  assert.equal(oversizedBodyCanceled, true);

  let upstreamSignalAborted = false;
  const stalledFetch: TradingViewSidecarFetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => {
          upstreamSignalAborted = true;
          controller.error(signal.reason ?? new DOMException("Aborted", "AbortError"));
        }, { once: true });
      },
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    () => loadTradingViewScannerLatestCloses(
      { UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS: "2000" },
      ["AAPL"],
      { requestId: "scanner-body-timeout" },
      { fetch: stalledFetch },
    ),
    (error: unknown) => error instanceof TradingViewSidecarError
      && error.code === "request_timeout",
  );
  assert.equal(upstreamSignalAborted, true);
});

test("sidecar latest-close snapshots are bounded and honor caller aborts", async () => {
  let oversizedBodyCanceled = false;
  const adapter = createTradingViewSidecarProvider({
    UNICORN_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
  }, {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        oversizedBodyCanceled = true;
      },
    }), {
      headers: {
        "content-length": String(300 * 1_024),
        "content-type": "application/json",
      },
    }),
  });
  await assert.rejects(
    () => adapter.syntheticMarket.getLatestCloses(
      ["AAPL"],
      { requestId: "sidecar-oversized" },
    ),
    (error: unknown) => error instanceof TradingViewSidecarError
      && error.code === "invalid_response",
  );
  assert.equal(oversizedBodyCanceled, true);

  const caller = new AbortController();
  let linkedSignalAborted = false;
  const abortableAdapter = createTradingViewSidecarProvider({
    UNICORN_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791",
  }, {
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => {
        linkedSignalAborted = true;
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
      queueMicrotask(() => caller.abort());
    }),
  });
  await assert.rejects(
    () => abortableAdapter.syntheticMarket.getLatestCloses(
      ["AAPL"],
      { requestId: "sidecar-caller-abort", signal: caller.signal },
    ),
    (error: unknown) => error instanceof TradingViewSidecarError
      && error.code === "upstream_error",
  );
  assert.equal(linkedSignalAborted, true);
});

test("watchlist API ignores the FMP market role and keeps the Worker USDT.P contract", async () => {
  const previousUrl = process.env.UNICORN_TRADINGVIEW_SIDECAR_URL;
  const previousMarket = process.env.UNICORN_MARKET_PROVIDER;
  const previousFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  delete process.env.UNICORN_TRADINGVIEW_SIDECAR_URL;
  process.env.UNICORN_MARKET_PROVIDER = "fmp";
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://scanner.tradingview.com/crypto/scan");
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      totalCount: 1,
      data: [{
        s: "BINANCE:AAPLUSDT.P",
        d: [
          303,
          Math.floor(Date.now() / 1_000),
          "USDT",
          "streaming",
          "swap",
          "crypto",
          "BINANCE",
        ],
      }],
    });
  }) as typeof globalThis.fetch;
  try {
    const response = await POST(new Request("http://localhost/api/v1/watchlists/after-hours", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols: ["aapl", "nvda"] }),
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as WatchlistAfterHoursResponse;
    assert.equal(payload.exchange, "BINANCE");
    assert.deepEqual(payload.exchanges, ["BINANCE", "BITGET", "KUCOIN", "MEXC"]);
    assert.equal(payload.selectedProvider, "tradingview-websocket");
    assert.equal(payload.streamSupported, false);
    assert.equal(payload.streamTransport, undefined);
    assert.equal(payload.items[0]?.sourceSymbol, "BINANCE:AAPLUSDT.P");
    assert.equal(payload.items[0]?.currency, "USDT");
    assert.equal(payload.items[1]?.sourceSymbol, "BINANCE:NVDAUSDT.P");
    assert.equal(payload.items[1]?.close, null);
    assert.ok(body);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.UNICORN_TRADINGVIEW_SIDECAR_URL;
    else process.env.UNICORN_TRADINGVIEW_SIDECAR_URL = previousUrl;
    if (previousMarket === undefined) delete process.env.UNICORN_MARKET_PROVIDER;
    else process.env.UNICORN_MARKET_PROVIDER = previousMarket;
  }
});

test("watchlist API rejects invalid or oversized batches before contacting a provider", async () => {
  for (const symbols of [[], ["AAPL", "bad symbol"], Array.from({ length: 51 }, (_, index) => `A${index}`)]) {
    const response = await POST(new Request("http://localhost/api/v1/watchlists/after-hours", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols }),
    }));
    assert.equal(response.status, 400);
  }
});

test("sidecar resolves a watchlist over one websocket with ordered exchange fallback", async () => {
  const source = await readFile(new URL("../api/tradingview-websocket/sidecar.py", import.meta.url), "utf8");

  assert.match(source, /DEFAULT_LATEST_CLOSE_EXCHANGES = \("BINANCE", "BITGET", "KUCOIN", "MEXC"\)/);
  assert.match(source, /session_symbols: dict\[str, tuple\[str, int\]\]/);
  assert.match(source, /websocket\.send_message\("chart_create_session"/);
  assert.match(source, /request_candidate\(symbol, observed_index \+ 1\)/);
  assert.match(source, /except WebSocketTimeoutException:/);
  assert.match(source, /advance_silent_candidates\(\)/);
  assert.match(source, /resolution_window \/ len\(exchanges\)/);
  assert.match(source, /"sourceSymbol": f"\{exchanges\[exchange_index\]\}:\{symbol\}USDT\.P"/);
  assert.match(source, /"resolutionStrategy": "ordered_fallback"/);
  assert.match(source, /values: dict\[str, dict\[str, float \| str\] \| None\]/);
  assert.match(source, /close_value is not None\s+and close_value > 0\s+and continuous_reference_is_fresh/);
  assert.doesNotMatch(source, /ThreadPoolExecutor/);
});

test("watchlist UI renders provider-selected after-hours prices with a dash fallback", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const i18nSource = await readFile(new URL("../src/app/platform/i18n.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /t\("watchlist\.afterHours"\)/);
  assert.match(pageSource, /t\("watchlist\.afterHoursTooltip", \{ symbol: item\.ticker \}\)/);
  assert.match(pageSource, /\/api\/v1\/watchlists\/after-hours/);
  assert.match(pageSource, /afterHours\[item\.ticker\]/);
  assert.match(pageSource, /shouldUseAfterHoursPrices\(/);
  assert.match(pageSource, /afterHoursTickerKey = afterHoursEnabled \? afterHoursTickers\.join/);
  assert.match(pageSource, /const nextTransport = response\.streamTransport/);
  assert.match(pageSource, /streamSupported = response\.streamSupported === true\s+&& nextTransport !== undefined/);
  assert.match(pageSource, /longPollSupported = response\.longPollSupported === true\s+&& !streamSupported/);
  assert.match(pageSource, /fetch\("\/api\/v1\/watchlists\/after-hours\/poll"/);
  assert.match(pageSource, /JSON\.stringify\(\{ symbols, cursors: longPollCursors\(\) \}\)/);
  assert.match(pageSource, /\|\| longPollController\s*\) return/);
  assert.match(pageSource, /longPollController\?\.abort\("long poll stopped"\)/);
  assert.match(pageSource, /scheduleLongPoll\(longPollRetryDelay === 1_000 \? 0 : longPollRetryDelay\)/);
  assert.doesNotMatch(pageSource, /\? "sse" : undefined/);
  assert.match(pageSource, /streamSupported === false/);
  assert.match(pageSource, /streamSupported !== true/);
  assert.match(pageSource, /streamSupported === true\) connectStream\(\)/);
  assert.match(pageSource, /reconnectTimer = undefined;\s+disconnectStream\(\)/);
  assert.match(pageSource, /refresh\(\);\s+window\.addEventListener\("focus", refreshNow\)/);
  assert.match(pageSource, /WATCHLIST_SESSION_STATE_REFRESH_MS = 15_000/);
  assert.match(pageSource, /millisecondsUntilNextUsSessionBoundary\(new Date\(\)\)/);
  assert.match(
    pageSource,
    /if \(isNominalUsRegularSession\(new Date\(observedAt\)\)\) \{\s*setAfterHoursBySymbol/,
  );
  assert.match(pageSource, /forceWatchlistQuoteSnapshotRef\.current\?\.\(\)/);
  assert.match(pageSource, /Date\.parse\(ingestedAt\)/);
  assert.match(pageSource, /shouldReplaceMarketSessionObservation\(current, observation\)/);
  assert.match(pageSource, /if \(force\) forceRefreshPending = true/);
  assert.match(pageSource, /const requestStartedAt = new Date\(startedAt\)/);
  assert.match(pageSource, /didMarketDataRequestStayInNominalSession\(requestStartedAt, new Date\(\)\)/);
  assert.match(pageSource, /requestStayedInsideTheSameNominalSession/);
  assert.match(pageSource, /if \(!requestStayedInsideTheSameNominalSession\) return/);
  assert.match(pageSource, /if \(forceRefreshPending && !disposed && !document\.hidden\)/);
  assert.match(pageSource, /quote\.marketState, quote\.provenance\.ingestedAt/);
  assert.match(pageSource, /item\.quote\.provenance\.ingestedAt/);
  assert.match(pageSource, /marketSessionClock === null \? undefined : new Date\(marketSessionClock\)/);
  assert.match(pageSource, /window\.setInterval\(updateMarketSessionClock, MARKET_SESSION_CLOCK_REFRESH_MS\)/);
  assert.match(pageSource, /window\.addEventListener\("pageshow", refreshNow\)/);
  assert.match(pageSource, /isFreshSyntheticLatestClose\(afterHoursItem\)/);
  assert.match(pageSource, /pruneStaleAfterHoursCloses\(current, observedAt\)/);
  assert.match(pageSource, /SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS \+ 1/);
  assert.match(pageSource, /afterHours=\{afterHoursEnabled \? afterHoursBySymbol\[stock\.ticker\] : undefined\}/);
  assert.match(pageSource, /: "-"/);
  assert.match(pageSource, /className="watch-price">\{formatWatchlistPrice\(item\)\}/);
  assert.match(pageSource, /formatSummaryAfterHoursPrice\(afterHoursClose\)/);
  assert.match(pageSource, /t\("watchlist\.afterHours"\)/);
  assert.match(i18nSource, /"watchlist\.afterHours": "After hours"/);
  assert.match(i18nSource, /"watchlist\.afterHours": "時間外"/);
  assert.match(pageSource, /afterHoursClose > item\.price/);
  assert.match(pageSource, /afterHoursClose < item\.price/);
  assert.match(styles, /\.watch-after-hours\.is-higher\s*{\s*color: var\(--green\)/);
  assert.match(styles, /\.watch-after-hours\.is-lower\s*{\s*color: var\(--red\)/);
  assert.match(styles, /\.watch-after-hours\.is-equal\s*{\s*color: #fff/);
});

test("watchlist rows expose an accessible context menu backed by the durable delete endpoint", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /onContextMenu=\{\(event\) =>/);
  assert.match(pageSource, /event\.key === "ContextMenu"/);
  assert.match(pageSource, /event\.shiftKey && event\.key === "F10"/);
  assert.match(pageSource, /open: rowContextMenu !== null/);
  assert.match(pageSource, /restoreFocusRef: rowContextTriggerRef/);
  assert.match(pageSource, /role="menuitem"/);
  assert.match(pageSource, /t\("watchlist\.remove"\)/);
  assert.match(pageSource, /method: "DELETE"/);
  assert.match(pageSource, /items: watchlist\.items\.filter\(\(item\) => item\.id !== existing\.id\)/);
  assert.match(pageSource, /onDelete=\{removeWatchlistItem\}/);
});
