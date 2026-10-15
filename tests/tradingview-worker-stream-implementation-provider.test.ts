import assert from "node:assert/strict";
import test from "node:test";

import {
  createTradingViewWorkerLatestCloseStream,
  TradingViewSidecarError,
  type TradingViewWorkerWebSocket,
} from "../api/tradingview-websocket/index.server";
import { GET } from "../src/app/api/v1/watchlists/after-hours/stream/route";

const SESSION_ID = "qs_abcdefghijkl";

function frame(payload: string): string {
  return `~m~${new TextEncoder().encode(payload).byteLength}~m~${payload}`;
}

function protocol(method: string, parameters: readonly unknown[]): string {
  return frame(JSON.stringify({ m: method, p: parameters }));
}

function decodeProtocol(value: string): Readonly<{ m: string; p: readonly unknown[] }> {
  const match = value.match(/^~m~([1-9][0-9]*)~m~([\s\S]+)$/);
  assert.ok(match);
  assert.equal(new TextEncoder().encode(match[2]!).byteLength, Number(match[1]));
  return JSON.parse(match[2]!) as Readonly<{ m: string; p: readonly unknown[] }>;
}

class FakeTradingViewSocket implements TradingViewWorkerWebSocket {
  readonly sent: string[] = [];
  readonly closeCalls: Array<readonly [number | undefined, string | undefined]> = [];
  accepted = 0;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  accept() {
    this.accepted += 1;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push([code, reason]);
  }

  addEventListener(type: "message" | "close" | "error", listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "message" | "close" | "error", listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener);
  }

  message(payload: string) {
    this.dispatch("message", new MessageEvent("message", { data: payload }));
  }

  private dispatch(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

function quote(
  sourceSymbol: string,
  values: Readonly<Record<string, unknown>>,
  state = "ok",
) {
  return protocol("qsd", [SESSION_ID, {
    n: sourceSymbol,
    s: state,
    v: values,
  }]);
}

function labels(sourceSymbol: string, exchange: string) {
  return {
    currency_code: "USDT",
    update_mode: "streaming",
    type: "swap",
    exchange,
    pro_name: sourceSymbol,
  } as const;
}

test("Worker opens one guest quote session for the exact configured USDT.P sources", async () => {
  const socket = new FakeTradingViewSocket();
  const abort = new AbortController();
  const stream = await createTradingViewWorkerLatestCloseStream(
    { TRADER_TRADINGVIEW_SYNTHETIC_EXCHANGES: "BINANCE,BITGET" },
    ["aapl", "nvda"],
    { requestId: "worker-protocol", signal: abort.signal },
    {
      connect: async (signal) => {
        assert.equal(signal.aborted, false);
        return socket;
      },
      now: () => new Date("2026-08-13T08:00:00.000Z"),
      sessionId: () => SESSION_ID,
      streamTtlMs: 5_000,
      livenessTimeoutMs: 5_000,
    },
  );
  const reader = stream.getReader();
  assert.deepEqual((await reader.read()).value, {
    symbol: "AAPL",
    sourceSymbol: "BINANCE:AAPLUSDT.P",
    close: null,
    currency: "USDT",
    source: "tradingview-websocket",
    updatedAt: null,
  });
  assert.equal((await reader.read()).value?.symbol, "NVDA");

  const messages = socket.sent.map(decodeProtocol);
  assert.deepEqual(messages.slice(0, 3).map(({ m }) => m), [
    "set_auth_token",
    "quote_create_session",
    "quote_set_fields",
  ]);
  assert.deepEqual(messages[0]?.p, ["unauthorized_user_token"]);
  assert.deepEqual(messages[1]?.p, [SESSION_ID]);
  assert.ok(messages[2]?.p.includes("lp"));
  assert.ok(messages[2]?.p.includes("lp_time"));
  assert.ok(messages[2]?.p.includes("currency_code"));
  assert.ok(messages[2]?.p.includes("type"));
  assert.deepEqual(messages.slice(3).map(({ p }) => p), [
    [SESSION_ID, "BINANCE:AAPLUSDT.P"],
    [SESSION_ID, "BITGET:AAPLUSDT.P"],
    [SESSION_ID, "BINANCE:NVDAUSDT.P"],
    [SESSION_ID, "BITGET:NVDAUSDT.P"],
  ]);

  const heartbeat = "~h~1786619543";
  socket.message(frame(heartbeat));
  assert.equal(socket.sent.at(-1), frame(heartbeat));
  await reader.cancel();
  assert.equal(socket.closeCalls.length, 1);
});

test("Worker merges partial qsd values and preserves ordered exchange selection", async () => {
  const socket = new FakeTradingViewSocket();
  const observedAt = Date.parse("2026-08-13T08:00:00.000Z");
  const stream = await createTradingViewWorkerLatestCloseStream(
    { TRADER_TRADINGVIEW_SYNTHETIC_EXCHANGES: "BINANCE,BITGET" },
    ["AAPL"],
    { requestId: "worker-qsd" },
    {
      connect: async () => socket,
      now: () => new Date(observedAt),
      sessionId: () => SESSION_ID,
      streamTtlMs: 5_000,
      livenessTimeoutMs: 5_000,
    },
  );
  const reader = stream.getReader();
  await reader.read(); // requested-order initial null

  const bitget = "BITGET:AAPLUSDT.P";
  socket.message(quote(bitget, labels(bitget, "Bitget")));
  socket.message(quote(bitget, { lp: 302.5, lp_time: observedAt / 1_000 }));
  assert.deepEqual((await reader.read()).value, {
    symbol: "AAPL",
    sourceSymbol: bitget,
    close: 302.5,
    currency: "USDT",
    source: "tradingview-websocket",
    updatedAt: "2026-08-13T08:00:00.000Z",
  });

  const binance = "BINANCE:AAPLUSDT.P";
  socket.message(quote(binance, {
    ...labels(binance, "Binance"),
    lp: 302.6,
    lp_time: observedAt / 1_000,
  }));
  assert.equal((await reader.read()).value?.sourceSymbol, binance);

  // A newer lower-priority quote remains in the same <5m cohort, so it must
  // not create an event or replace the configured first exchange.
  socket.message(quote(bitget, {
    lp: 303,
    lp_time: (observedAt + 1_000) / 1_000,
  }));
  // A rollback must also stay silent. The next read must therefore be this
  // genuinely newer BINANCE value, not either ignored BITGET/rollback packet.
  socket.message(quote(binance, {
    lp: 99,
    lp_time: (observedAt - 1_000) / 1_000,
  }));
  socket.message(quote(binance, {
    lp: 303.1,
    lp_time: (observedAt + 2_000) / 1_000,
  }));
  const next = (await reader.read()).value;
  assert.equal(next?.sourceSymbol, binance);
  assert.equal(next?.close, 303.1);

  await reader.cancel();
});

test("Worker enforces the inclusive five-minute boundary and emits one canonical expiry", async () => {
  const socket = new FakeTradingViewSocket();
  let observedAt = Date.parse("2026-08-13T08:00:00.000Z");
  const stream = await createTradingViewWorkerLatestCloseStream(
    { TRADER_TRADINGVIEW_SYNTHETIC_EXCHANGES: "BINANCE" },
    ["AAPL"],
    { requestId: "worker-freshness" },
    {
      connect: async () => socket,
      now: () => new Date(observedAt),
      sessionId: () => SESSION_ID,
      streamTtlMs: 5_000,
      livenessTimeoutMs: 5_000,
    },
  );
  const reader = stream.getReader();
  await reader.read();

  const source = "BINANCE:AAPLUSDT.P";
  socket.message(quote(source, {
    ...labels(source, "Binance"),
    lp: 300,
    lp_time: (observedAt - 300_000) / 1_000,
  }));
  assert.equal((await reader.read()).value?.close, 300);

  observedAt += 1;
  socket.message(frame("~h~expiry"));
  assert.deepEqual((await reader.read()).value, {
    symbol: "AAPL",
    sourceSymbol: source,
    close: null,
    currency: "USDT",
    source: "tradingview-websocket",
    updatedAt: null,
  });

  // A mislabeled packet and an unallowlisted source cannot revive the value.
  socket.message(quote(source, {
    ...labels(source, "Binance"),
    currency_code: "USD",
    lp: 999,
    lp_time: observedAt / 1_000,
  }));
  socket.message(quote("MEXC:AAPLUSDT.P", {
    ...labels("MEXC:AAPLUSDT.P", "Mexc"),
    lp: 999,
    lp_time: observedAt / 1_000,
  }));
  socket.message(quote(source, {
    ...labels(source, "Binance"),
    lp: 301,
    lp_time: observedAt / 1_000,
  }));
  assert.equal((await reader.read()).value?.close, 301);
  await reader.cancel();
});

test("Worker rejects oversized symbol batches before connecting", async () => {
  let connected = false;
  await assert.rejects(
    () => createTradingViewWorkerLatestCloseStream(
      {},
      Array.from({ length: 51 }, (_, index) => `A${index}`),
      { requestId: "worker-too-many" },
      {
        connect: async () => {
          connected = true;
          return new FakeTradingViewSocket();
        },
        sessionId: () => SESSION_ID,
      },
    ),
    (error: unknown) => error instanceof TradingViewSidecarError
      && error.code === "invalid_request",
  );
  assert.equal(connected, false);
});

test("sidecar-free route upgrades the Worker websocket and relays canonical initial SSE", {
  timeout: 5_000,
}, async () => {
  const socket = new FakeTradingViewSocket();
  const previousFetch = globalThis.fetch;
  const previousSidecar = process.env.TRADER_TRADINGVIEW_SIDECAR_URL;
  const pairDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  let requestSignal: AbortSignal | null | undefined;
  delete process.env.TRADER_TRADINGVIEW_SIDECAR_URL;
  Object.defineProperty(globalThis, "WebSocketPair", {
    configurable: true,
    value: class WebSocketPair {},
  });
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://data.tradingview.com/socket.io/websocket");
    assert.equal(init?.cache, "no-store");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("upgrade"), "websocket");
    assert.equal(headers.get("origin"), "https://data.tradingview.com");
    requestSignal = init?.signal;
    return Object.assign(new Response(null), { webSocket: socket });
  }) as typeof globalThis.fetch;

  const downstream = new AbortController();
  try {
    const response = await GET(new Request(
      "http://localhost/api/v1/watchlists/after-hours/stream?symbols=AAPL",
      {
        headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
        signal: downstream.signal,
      },
    ));
    assert.equal(response.status, 200);
    assert.equal(socket.accepted, 1);
    assert.ok(requestSignal);
    assert.equal(requestSignal.aborted, false);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (!body.includes('"close":null')) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      body += decoder.decode(value, { stream: true });
    }
    const messages = body.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const source = "BINANCE:AAPLUSDT.P";
    assert.equal(messages.length, 1);
    assert.deepEqual(messages.map((message) => (
      message.item as Record<string, unknown>
    ).sourceSymbol), [source]);
    assert.deepEqual(messages.map((message) => (
      message.item as Record<string, unknown>
    ).currency), ["USDT"]);
    assert.deepEqual(messages.map((message) => (
      message.item as Record<string, unknown>
    ).source), ["tradingview-websocket"]);

    await reader.cancel();
    assert.ok(socket.closeCalls.length >= 1);
    // A successful websocket-upgrade fetch keeps its handshake signal alive;
    // downstream cancellation closes the socket explicitly instead.
    assert.equal(requestSignal.aborted, false);
  } finally {
    downstream.abort();
    globalThis.fetch = previousFetch;
    if (pairDescriptor) Object.defineProperty(globalThis, "WebSocketPair", pairDescriptor);
    else delete (globalThis as typeof globalThis & { WebSocketPair?: unknown }).WebSocketPair;
    if (previousSidecar === undefined) delete process.env.TRADER_TRADINGVIEW_SIDECAR_URL;
    else process.env.TRADER_TRADINGVIEW_SIDECAR_URL = previousSidecar;
  }
});
