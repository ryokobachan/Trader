import assert from "node:assert/strict";
import test from "node:test";

import {
  loadTradingViewWorkerQuoteLongPoll,
  type TradingViewWorkerWebSocket,
} from "../api/tradingview-websocket/index.server";
import { POST } from "../src/app/api/v1/watchlists/quotes/poll/route";
import type { Instrument, WatchlistQuotesResponse } from "../src/app/platform/provider-contracts";

const SESSION_ID = "qs_abcdefghijkl";
const OBSERVED_AT = "2026-08-13T14:00:00.000Z";
const EPOCH_SECONDS = Date.parse(OBSERVED_AT) / 1_000;

const INSTRUMENT = {
  instrumentId: "us:XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetType: "common_stock",
  active: true,
  listingCountry: "US",
  exchange: "NASDAQ",
  exchangeMic: "XNAS",
  currency: "USD",
  provenance: {
    providerId: "fixture",
    sourceId: "fixture:AAPL",
    asOf: OBSERVED_AT,
    ingestedAt: OBSERVED_AT,
  },
} as const satisfies Instrument;

type Listener = EventListenerOrEventListenerObject;

class FakeTradingViewSocket implements TradingViewWorkerWebSocket {
  readonly sent: string[] = [];
  readonly closeCalls: Array<readonly [number | undefined, string | undefined]> = [];
  accepted = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  accept() {
    this.accepted += 1;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push([code, reason]);
  }

  addEventListener(type: "message" | "close" | "error", listener: Listener) {
    const values = this.listeners.get(type) ?? new Set<Listener>();
    values.add(listener);
    this.listeners.set(type, values);
  }

  removeEventListener(type: "message" | "close" | "error", listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  message(data: string) {
    for (const listener of this.listeners.get("message") ?? []) {
      const event = new MessageEvent("message", { data });
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

function frame(payload: unknown) {
  const value = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `~m~${new TextEncoder().encode(value).byteLength}~m~${value}`;
}

function qsd(
  overrides: Readonly<Record<string, unknown>> = {},
  sessionId = SESSION_ID,
) {
  return frame({
    m: "qsd",
    p: [sessionId, {
      n: "NASDAQ:AAPL",
      s: "ok",
      v: {
        lp: 315,
        lp_time: EPOCH_SECONDS,
        ch: 3,
        chp: (3 / 312) * 100,
        current_session: "market",
        currency_code: "USD",
        volume: 120,
        open_price: 312,
        high_price: 316,
        low_price: 311,
        prev_close_price: 312,
        update_mode: "streaming",
        exchange: "Cboe One",
        pro_name: "NASDAQ:AAPL",
        type: "stock",
        ...overrides,
      },
    }],
  });
}

function decodeProtocol(value: string): Readonly<{ m: string; p: readonly unknown[] }> {
  const match = value.match(/^~m~([1-9][0-9]*)~m~([\s\S]+)$/);
  assert.ok(match);
  assert.equal(new TextEncoder().encode(match[2]!).byteLength, Number(match[1]));
  return JSON.parse(match[2]!) as Readonly<{ m: string; p: readonly unknown[] }>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for quote poll state.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("Worker quote poll subscribes to exact USD listing IDs and returns a canonical initial batch", async () => {
  const socket = new FakeTradingViewSocket();
  const pending = loadTradingViewWorkerQuoteLongPoll(
    [INSTRUMENT],
    new Map(),
    { requestId: "worker-quote-initial" },
    {
      connect: async () => socket,
      now: () => new Date(OBSERVED_AT),
      sessionId: () => SESSION_ID,
      initialWaitMs: 200,
    },
  );
  await waitFor(() => socket.sent.length === 4);
  const protocol = socket.sent.map(decodeProtocol);
  assert.deepEqual(protocol.map(({ m }) => m), [
    "set_auth_token",
    "quote_create_session",
    "quote_set_fields",
    "quote_add_symbols",
  ]);
  assert.deepEqual(protocol[0]?.p, ["unauthorized_user_token"]);
  assert.deepEqual(protocol[1]?.p, [SESSION_ID]);
  assert.deepEqual(protocol[3]?.p, [SESSION_ID, "NASDAQ:AAPL"]);
  assert.ok(protocol[2]?.p.includes("lp"));
  assert.ok(protocol[2]?.p.includes("lp_time"));
  assert.ok(protocol[2]?.p.includes("currency_code"));
  assert.ok(protocol[2]?.p.includes("open_price"));
  assert.ok(protocol[2]?.p.includes("high_price"));
  assert.ok(protocol[2]?.p.includes("low_price"));
  assert.ok(protocol[2]?.p.includes("volume"));

  socket.message(qsd());
  const result = await pending;
  assert.equal(result.reason, "initial");
  assert.equal(result.quotes.length, 1);
  assert.deepEqual(result.quotes[0], {
    instrumentId: INSTRUMENT.instrumentId,
    price: 315,
    change: 3,
    changePercent: (3 / 312) * 100,
    previousClose: 312,
    open: 312,
    high: 316,
    low: 311,
    volume: 120,
    currency: "USD",
    marketState: "regular",
    delaySeconds: 0,
    provenance: {
      providerId: "tradingview-websocket",
      sourceId: "tradingview-websocket:NASDAQ:AAPL:realtime-quote",
      asOf: OBSERVED_AT,
      ingestedAt: OBSERVED_AT,
      sourceUrl: "wss://data.tradingview.com/socket.io/websocket",
    },
  });
  assert.equal(socket.closeCalls.length, 1);
});

test("an unchanged cursor holds the HTTP request and a later TradingView tick returns immediately", async () => {
  const socket = new FakeTradingViewSocket();
  const pending = loadTradingViewWorkerQuoteLongPoll(
    [INSTRUMENT],
    new Map([["AAPL", { asOf: OBSERVED_AT, price: 315 }]]),
    { requestId: "worker-quote-changed" },
    {
      connect: async () => socket,
      now: () => new Date("2026-08-13T14:00:02.000Z"),
      sessionId: () => SESSION_ID,
      longPollWaitMs: 500,
    },
  );
  await waitFor(() => socket.sent.length === 4);
  socket.message(qsd());
  assert.equal(await Promise.race([
    pending.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 20)),
  ]), "waiting");

  socket.message(qsd({ lp: 315.25, lp_time: EPOCH_SECONDS + 1 }));
  const result = await pending;
  assert.equal(result.reason, "changed");
  assert.equal(result.quotes[0]?.price, 315.25);
  assert.equal(result.quotes[0]?.provenance.asOf, "2026-08-13T14:00:01.000Z");
  assert.equal(result.quotes[0]?.currency, "USD");
});

test("an unchanged cursor returns the validated batch at the bounded timeout", async () => {
  const socket = new FakeTradingViewSocket();
  const pending = loadTradingViewWorkerQuoteLongPoll(
    [INSTRUMENT],
    new Map([["AAPL", { asOf: OBSERVED_AT, price: 315 }]]),
    { requestId: "worker-quote-timeout" },
    {
      connect: async () => socket,
      now: () => new Date(OBSERVED_AT),
      sessionId: () => SESSION_ID,
      longPollWaitMs: 30,
    },
  );
  await waitFor(() => socket.sent.length === 4);
  socket.message(qsd());
  const result = await pending;
  assert.equal(result.reason, "timeout");
  assert.equal(result.quotes[0]?.price, 315);
  assert.equal(socket.closeCalls.length, 1);
});

test("Worker quote poll rejects mislabeled and malformed values until a complete USD equity quote arrives", async () => {
  const socket = new FakeTradingViewSocket();
  const pending = loadTradingViewWorkerQuoteLongPoll(
    [INSTRUMENT],
    new Map(),
    { requestId: "worker-quote-integrity" },
    {
      connect: async () => socket,
      now: () => new Date(OBSERVED_AT),
      sessionId: () => SESSION_ID,
      initialWaitMs: 500,
    },
  );
  await waitFor(() => socket.sent.length === 4);
  socket.message(qsd({ currency_code: "USDT" }));
  socket.message(qsd({ currency_code: "USD", pro_name: "NASDAQ:MSFT" }));
  socket.message(qsd({ pro_name: "NASDAQ:AAPL", low_price: 317 }));
  assert.equal(await Promise.race([
    pending.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 20)),
  ]), "waiting");
  socket.message(qsd({ low_price: 311 }));
  const result = await pending;
  assert.equal(result.quotes[0]?.price, 315);
});

test("quote poll route keeps the existing response schema and reports the native TradingView provider", async () => {
  const previousInstrument = process.env.TRADER_INSTRUMENT_PROVIDER;
  process.env.TRADER_INSTRUMENT_PROVIDER = "mock";
  const previousFetch = globalThis.fetch;
  const socket = new FakeTradingViewSocket();
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://data.tradingview.com/socket.io/websocket");
    assert.equal(new Headers(init?.headers).get("upgrade"), "websocket");
    return Object.assign(new Response(null), { webSocket: socket });
  }) as typeof globalThis.fetch;
  try {
    const pending = POST(new Request("http://localhost/api/v1/watchlists/quotes/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols: ["AAPL"] }),
    }));
    await waitFor(() => socket.sent.length === 4);
    const sessionId = String(decodeProtocol(socket.sent[1]!).p[0]);
    socket.message(qsd({}, sessionId));
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-long-poll-result"), "initial");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const payload = await response.json() as WatchlistQuotesResponse;
    assert.equal(payload.schemaVersion, "trader.watchlist-quotes.v1");
    assert.deepEqual(payload.selectedProviders, {
      instrument: "mock",
      market: "tradingview-websocket",
    });
    assert.equal(payload.items[0]?.quote?.price, 315, JSON.stringify(payload));
    assert.equal(payload.items[0]?.quote?.currency, "USD");
    assert.equal(payload.streamSupported, false);
    assert.equal(payload.longPollSupported, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousInstrument === undefined) delete process.env.TRADER_INSTRUMENT_PROVIDER;
    else process.env.TRADER_INSTRUMENT_PROVIDER = previousInstrument;
  }
});

test("quote poll route rejects an invalid cursor before opening TradingView", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("invalid input must not reach TradingView");
  });
  const response = await POST(new Request("http://localhost/api/v1/watchlists/quotes/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      symbols: ["AAPL"],
      cursors: { AAPL: { asOf: "not-a-date", price: 315 } },
    }),
  }));
  assert.equal(response.status, 400);
  assert.equal(fetchMock.mock.callCount(), 0);

  const crossOrigin = await POST(new Request(
    "http://localhost/api/v1/watchlists/quotes/poll",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ symbols: ["AAPL"] }),
    },
  ));
  assert.equal(crossOrigin.status, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});
