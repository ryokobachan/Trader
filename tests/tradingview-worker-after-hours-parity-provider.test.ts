import assert from "node:assert/strict";
import test from "node:test";

import {
  createTradingViewWorkerLatestCloseStream,
  type TradingViewWorkerWebSocket,
} from "../api/tradingview-websocket/index.server";
import type { SyntheticLatestClose } from "../src/app/platform/provider-contracts";

const EXCHANGES = ["BINANCE", "BITGET", "KUCOIN", "MEXC"] as const;
const SESSION_ID = "qs_abcdefghijkl";
const BASE_MILLISECONDS = Date.parse("2026-08-13T12:00:00.000Z");

type SocketListener = (event: unknown) => void;

class FakeTradingViewSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<SocketListener>>();
  accepted = 0;
  closed = 0;

  accept() {
    this.accepted += 1;
  }

  send(value: string | ArrayBuffer | ArrayBufferView) {
    assert.equal(typeof value, "string");
    this.sent.push(value as string);
  }

  close() {
    this.closed += 1;
  }

  addEventListener(type: string, listener: SocketListener) {
    const listeners = this.#listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: SocketListener) {
    this.#listeners.get(type)?.delete(listener);
  }

  message(data: string) {
    this.#dispatch("message", { data });
  }

  #dispatch(type: string, event: unknown) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function frame(payload: unknown) {
  const message = JSON.stringify(payload);
  return `~m~${new TextEncoder().encode(message).byteLength}~m~${message}`;
}

function qsd(
  sourceSymbol: string,
  values: Readonly<Record<string, unknown>>,
  status = "ok",
  sessionId = SESSION_ID,
) {
  const exchange = sourceSymbol.slice(0, sourceSymbol.indexOf(":"));
  return frame({
    m: "qsd",
    p: [sessionId, {
      n: sourceSymbol,
      s: status,
      v: {
        currency_code: "USDT",
        update_mode: "streaming",
        type: "swap",
        exchange,
        pro_name: sourceSymbol,
        ...values,
      },
    }],
  });
}

function heartbeat(value = "~h~worker-golden") {
  return `~m~${new TextEncoder().encode(value).byteLength}~m~${value}`;
}

function decodeProtocolMessages(values: readonly string[]) {
  const messages: Array<Record<string, unknown>> = [];
  for (const value of values) {
    let offset = 0;
    while (offset < value.length) {
      assert.equal(value.slice(offset, offset + 3), "~m~");
      const lengthEnd = value.indexOf("~m~", offset + 3);
      assert.notEqual(lengthEnd, -1);
      const byteLength = Number(value.slice(offset + 3, lengthEnd));
      assert.ok(Number.isSafeInteger(byteLength) && byteLength >= 0);
      const start = lengthEnd + 3;
      let end = start;
      let observedBytes = 0;
      while (end < value.length && observedBytes < byteLength) {
        const character = value[end]!;
        observedBytes += new TextEncoder().encode(character).byteLength;
        end += 1;
      }
      assert.equal(observedBytes, byteLength);
      const payload = value.slice(start, end);
      if (!payload.startsWith("~h~")) {
        messages.push(JSON.parse(payload) as Record<string, unknown>);
      }
      offset = end;
    }
  }
  return messages;
}

function missing(symbol: string, exchange = "BINANCE"): SyntheticLatestClose {
  return {
    symbol,
    sourceSymbol: `${exchange}:${symbol}USDT.P`,
    close: null,
    currency: "USDT",
    source: "tradingview-websocket",
    updatedAt: null,
  };
}

function present(
  symbol: string,
  exchange: typeof EXCHANGES[number],
  close: number,
  milliseconds: number,
): SyntheticLatestClose {
  return {
    symbol,
    sourceSymbol: `${exchange}:${symbol}USDT.P`,
    close,
    currency: "USDT",
    source: "tradingview-websocket",
    updatedAt: new Date(milliseconds).toISOString(),
  };
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 1_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker stream state.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function nextValue(
  reader: ReadableStreamDefaultReader<SyntheticLatestClose>,
  timeoutMilliseconds = 1_000,
) {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("Timed out waiting for worker stream value.")),
      timeoutMilliseconds,
    )),
  ]);
  assert.equal(result.done, false);
  assert.ok(result.value);
  return result.value;
}

async function openHarness(
  symbols: readonly string[],
  observedAt: () => Date,
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  const socket = new FakeTradingViewSocket();
  const stream = await createTradingViewWorkerLatestCloseStream(
    environment,
    symbols,
    { requestId: "worker-after-hours-golden" },
    {
      connect: async () => socket as unknown as TradingViewWorkerWebSocket,
      now: observedAt,
      sessionId: () => SESSION_ID,
      streamTtlMs: 60_000,
      livenessTimeoutMs: 60_000,
      freshnessCheckMs: 60_000,
    },
  );
  const reader = stream.getReader();
  await waitFor(() => socket.sent.length >= 1);
  return { socket, reader };
}

test("worker stream uses the local sidecar protocol and preserves requested-symbol event order", async () => {
  const { socket, reader } = await openHarness(
    [" msft ", "aapl"],
    () => new Date(BASE_MILLISECONDS),
  );
  try {
    assert.deepEqual(await nextValue(reader), missing("MSFT"));
    assert.deepEqual(await nextValue(reader), missing("AAPL"));

    await waitFor(() => decodeProtocolMessages(socket.sent).filter(
      (message) => message.m === "quote_add_symbols",
    ).length === EXCHANGES.length * 2);
    const protocol = decodeProtocolMessages(socket.sent);
    assert.deepEqual(protocol.slice(0, 3).map((message) => message.m), [
      "set_auth_token",
      "quote_create_session",
      "quote_set_fields",
    ]);
    assert.deepEqual(protocol[0]?.p, ["unauthorized_user_token"]);
    assert.deepEqual(protocol[1]?.p, [SESSION_ID]);
    assert.ok(Array.isArray(protocol[2]?.p));
    assert.deepEqual(new Set((protocol[2]!.p as unknown[]).slice(1)), new Set([
      "lp",
      "lp_time",
      "ch",
      "chp",
      "current_session",
      "currency_code",
      "volume",
      "open_price",
      "high_price",
      "low_price",
      "prev_close_price",
      "update_mode",
      "exchange",
      "pro_name",
      "type",
    ]));
    const addedSources = protocol
      .filter((message) => message.m === "quote_add_symbols")
      .map((message) => (message.p as unknown[])[1]);
    assert.deepEqual(new Set(addedSources), new Set([
      ...EXCHANGES.map((exchange) => `${exchange}:MSFTUSDT.P`),
      ...EXCHANGES.map((exchange) => `${exchange}:AAPLUSDT.P`),
    ]));

    socket.message([
      qsd("BINANCE:AAPLUSDT.P", {
        lp: 303.1,
        lp_time: BASE_MILLISECONDS / 1_000,
        currency_code: "USDT",
      }),
      qsd("BINANCE:MSFTUSDT.P", {
        lp: 492.2,
        lp_time: BASE_MILLISECONDS / 1_000,
        currency_code: "USDT",
      }),
    ].join(""));
    assert.deepEqual(
      [await nextValue(reader), await nextValue(reader)],
      [
        present("AAPL", "BINANCE", 303.1, BASE_MILLISECONDS),
        present("MSFT", "BINANCE", 492.2, BASE_MILLISECONDS),
      ],
    );

    const ping = heartbeat();
    socket.message(ping);
    await waitFor(() => socket.sent.includes(ping));
  } finally {
    await reader.cancel();
  }
});

test("worker stream enforces USDT and strict exchange-priority freshness cohorts", async () => {
  const { socket, reader } = await openHarness(
    ["AAPL"],
    () => new Date(BASE_MILLISECONDS),
  );
  try {
    assert.deepEqual(await nextValue(reader), missing("AAPL"));

    const pendingValid = reader.read();
    socket.message(qsd("BITGET:AAPLUSDT.P", {
      lp: 303.2,
      lp_time: BASE_MILLISECONDS / 1_000,
      currency_code: "USD",
    }));
    assert.equal(await Promise.race([
      pendingValid.then(() => "event"),
      new Promise<string>((resolve) => setTimeout(() => resolve("none"), 20)),
    ]), "none");
    socket.message(qsd("BITGET:AAPLUSDT.P", {
      lp: 303.2,
      lp_time: BASE_MILLISECONDS / 1_000,
      currency_code: "USDT",
    }));
    const first = await pendingValid;
    assert.equal(first.done, false);
    assert.deepEqual(first.value, present("AAPL", "BITGET", 303.2, BASE_MILLISECONDS));

    // A higher-priority candidate 299 seconds behind the freshest candidate is
    // still in its freshness cohort and therefore wins despite its older tick.
    socket.message(qsd("BINANCE:AAPLUSDT.P", {
      lp: 303.0,
      lp_time: (BASE_MILLISECONDS - 299_000) / 1_000,
      currency_code: "USDT",
    }));
    assert.deepEqual(
      await nextValue(reader),
      present("AAPL", "BINANCE", 303.0, BASE_MILLISECONDS - 299_000),
    );

    // Exactly 300 seconds behind is outside the relative cohort (`< 5m`), so
    // the next configured usable venue wins; MEXC cannot jump ahead of BITGET.
    socket.message(qsd("MEXC:AAPLUSDT.P", {
      lp: 303.4,
      lp_time: (BASE_MILLISECONDS + 1_000) / 1_000,
      currency_code: "USDT",
    }));
    assert.deepEqual(
      await nextValue(reader),
      present("AAPL", "BITGET", 303.2, BASE_MILLISECONDS),
    );

    // Once BINANCE returns to 299 seconds behind the freshest tick it becomes
    // the selected source again.
    socket.message(qsd("BINANCE:AAPLUSDT.P", {
      lp: 303.05,
      lp_time: (BASE_MILLISECONDS - 298_000) / 1_000,
      currency_code: "USDT",
    }));
    assert.deepEqual(
      await nextValue(reader),
      present("AAPL", "BINANCE", 303.05, BASE_MILLISECONDS - 298_000),
    );
  } finally {
    await reader.cancel();
  }
});

test("worker stream emits one canonical null transition beyond the exact five-minute boundary", async () => {
  let observedMilliseconds = BASE_MILLISECONDS;
  const { socket, reader } = await openHarness(
    ["AAPL"],
    () => new Date(observedMilliseconds),
  );
  try {
    assert.deepEqual(await nextValue(reader), missing("AAPL"));

    const boundaryTimestamp = BASE_MILLISECONDS - 300_000;
    socket.message(qsd("BINANCE:AAPLUSDT.P", {
      lp: 303.0,
      lp_time: boundaryTimestamp / 1_000,
      currency_code: "USDT",
    }));
    assert.deepEqual(
      await nextValue(reader),
      present("AAPL", "BINANCE", 303.0, boundaryTimestamp),
    );

    observedMilliseconds += 1;
    socket.message(qsd("BINANCE:AAPLUSDT.P", {
      lp: 303.01,
      lp_time: boundaryTimestamp / 1_000,
      currency_code: "USDT",
    }));
    assert.deepEqual(await nextValue(reader), missing("AAPL"));

    const pending = reader.read();
    socket.message(qsd("BINANCE:AAPLUSDT.P", {
      lp: 303.02,
      lp_time: boundaryTimestamp / 1_000,
      currency_code: "USDT",
    }));
    assert.equal(await Promise.race([
      pending.then(() => "event"),
      new Promise<string>((resolve) => setTimeout(() => resolve("none"), 20)),
    ]), "none");
    await reader.cancel();
    await pending.catch(() => undefined);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
});

test("worker stream uses the first configured source for missing transitions and rejects older source ticks", async () => {
  const { socket, reader } = await openHarness(
    ["AAPL"],
    () => new Date(BASE_MILLISECONDS),
    { UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES: "MEXC,BINANCE" },
  );
  try {
    assert.deepEqual(await nextValue(reader), missing("AAPL", "MEXC"));
    socket.message(qsd("BINANCE:AAPLUSDT.P", {
      lp: 303.2,
      lp_time: BASE_MILLISECONDS / 1_000,
      currency_code: "USDT",
    }));
    assert.deepEqual(
      await nextValue(reader),
      present("AAPL", "BINANCE", 303.2, BASE_MILLISECONDS),
    );

    const pendingNull = reader.read();
    socket.message(qsd("BINANCE:AAPLUSDT.P", {}, "permission_denied"));
    const transitioned = await pendingNull;
    assert.equal(transitioned.done, false);
    assert.deepEqual(transitioned.value, missing("AAPL", "MEXC"));

    const pending = reader.read();
    socket.message(qsd("BINANCE:AAPLUSDT.P", {
      lp: 302.0,
      lp_time: (BASE_MILLISECONDS - 1_000) / 1_000,
      currency_code: "USDT",
    }));
    assert.equal(await Promise.race([
      pending.then(() => "event"),
      new Promise<string>((resolve) => setTimeout(() => resolve("none"), 20)),
    ]), "none");
    await reader.cancel();
    await pending.catch(() => undefined);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
});
