import assert from "node:assert/strict";
import test from "node:test";

import {
  handleWatchlistAfterHoursLongPoll,
  isChangedAfterHoursPollItem,
} from "../src/app/platform/watchlist-after-hours-long-poll.server";
import type {
  SyntheticLatestClose,
  WatchlistAfterHoursPollResponse,
} from "../src/app/platform/provider-contracts";

const EXCHANGES = ["BINANCE", "BITGET", "KUCOIN", "MEXC"] as const;

function close(
  price: number | null,
  updatedAt: string | null,
  exchange = "BINANCE",
): SyntheticLatestClose {
  return {
    symbol: "AAPL",
    sourceSymbol: `${exchange}:AAPLUSDT.P`,
    close: price,
    currency: "USDT",
    source: "tradingview-websocket",
    updatedAt,
  };
}

function request(
  cursors: readonly Record<string, unknown>[] = [],
  symbols: readonly string[] = ["AAPL"],
) {
  return new Request("http://localhost/api/v1/watchlists/after-hours/poll", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ symbols, cursors }),
  });
}

function stream(...items: readonly SyntheticLatestClose[]) {
  let cancelled = 0;
  return {
    source: new ReadableStream<SyntheticLatestClose>({
      start(controller) {
        for (const item of items) controller.enqueue(item);
      },
      cancel() {
        cancelled += 1;
      },
    }),
    cancelled: () => cancelled,
  };
}

test("long poll skips initial null and matching cursor, then returns one changed USDT.P tick", async () => {
  const fixture = stream(
    close(null, null),
    close(300, "2026-08-13T08:00:00.000Z"),
    close(300.01, "2026-08-13T08:00:01.000Z"),
  );
  let capturedSymbols: readonly string[] = [];
  const response = await handleWatchlistAfterHoursLongPoll(request([{
    symbol: "AAPL",
    sourceSymbol: "BINANCE:AAPLUSDT.P",
    close: 300,
    updatedAt: "2026-08-13T08:00:00.000Z",
  }]), {
    environment: {},
    createStream: async (_environment, symbols) => {
      capturedSymbols = symbols;
      return fixture.source;
    },
    now: () => new Date("2026-08-13T08:00:02.000Z"),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const payload = await response.json() as WatchlistAfterHoursPollResponse;
  assert.deepEqual(capturedSymbols, ["AAPL"]);
  assert.equal(payload.schemaVersion, "unicorn.watchlist-after-hours-poll.v1");
  assert.equal(payload.timedOut, false);
  assert.deepEqual(payload.items, [close(300.01, "2026-08-13T08:00:01.000Z")]);
  assert.equal(fixture.cancelled(), 1);
});

test("long poll returns an empty successful response at its bounded timeout and cancels upstream", async () => {
  const fixture = stream(close(null, null));
  const response = await handleWatchlistAfterHoursLongPoll(request(), {
    environment: {},
    createStream: async () => fixture.source,
    waitTimeoutMs: 10,
    now: () => new Date("2026-08-13T08:00:20.000Z"),
  });
  const payload = await response.json() as WatchlistAfterHoursPollResponse;
  assert.equal(response.status, 200);
  assert.equal(payload.timedOut, true);
  assert.deepEqual(payload.items, []);
  assert.equal(fixture.cancelled(), 1);
});

test("poll comparator suppresses lower-priority warm-up values while the preferred cursor is fresh", () => {
  const cursor = {
    symbol: "AAPL",
    sourceSymbol: "BINANCE:AAPLUSDT.P",
    close: 300,
    updatedAt: "2026-08-13T08:00:00.000Z",
  } as const;
  assert.equal(
    isChangedAfterHoursPollItem(
      close(300.5, "2026-08-13T08:04:59.999Z", "BITGET"),
      cursor,
      EXCHANGES,
    ),
    false,
  );
  assert.equal(
    isChangedAfterHoursPollItem(
      close(300.5, "2026-08-13T08:05:00.000Z", "BITGET"),
      cursor,
      EXCHANGES,
    ),
    true,
  );
  assert.equal(
    isChangedAfterHoursPollItem(
      close(300.01, "2026-08-13T08:00:00.000Z"),
      cursor,
      EXCHANGES,
    ),
    true,
    "same-second price changes must not be lost",
  );
  assert.equal(isChangedAfterHoursPollItem(close(null, null), cursor, EXCHANGES), false);
});

test("long poll rejects cross-origin, malformed cursors, and unconfigured source exchanges before upstream", async () => {
  let streamCalls = 0;
  const dependencies = {
    environment: {},
    createStream: async () => {
      streamCalls += 1;
      return new ReadableStream<SyntheticLatestClose>();
    },
  } as const;

  const crossOrigin = await handleWatchlistAfterHoursLongPoll(new Request(
    "http://localhost/api/v1/watchlists/after-hours/poll",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ symbols: ["AAPL"], cursors: [] }),
    },
  ), dependencies);
  assert.equal(crossOrigin.status, 403);

  const extraField = await handleWatchlistAfterHoursLongPoll(request([{
    symbol: "AAPL",
    sourceSymbol: "BINANCE:AAPLUSDT.P",
    close: 300,
    updatedAt: "2026-08-13T08:00:00.000Z",
    unexpected: true,
  }]), dependencies);
  assert.equal(extraField.status, 400);

  const wrongExchange = await handleWatchlistAfterHoursLongPoll(request([{
    symbol: "AAPL",
    sourceSymbol: "GATEIO:AAPLUSDT.P",
    close: 300,
    updatedAt: "2026-08-13T08:00:00.000Z",
  }]), dependencies);
  assert.equal(wrongExchange.status, 400);
  assert.equal(streamCalls, 0);
});

test("public long poll fails closed without a Sites owner identity", async () => {
  const response = await handleWatchlistAfterHoursLongPoll(new Request(
    "https://unicorn.example/api/v1/watchlists/after-hours/poll",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://unicorn.example",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ symbols: ["AAPL"], cursors: [] }),
    },
  ), {
    environment: {},
    createStream: async () => new ReadableStream<SyntheticLatestClose>(),
  });
  assert.equal(response.status, 401);
});
