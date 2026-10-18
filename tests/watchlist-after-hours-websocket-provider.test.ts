import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  handleWatchlistAfterHoursWebSocketUpgrade,
  type WatchlistAfterHoursRelayWebSocket,
} from "../src/app/platform/watchlist-after-hours-websocket.server";
import {
  parseWatchlistAfterHoursStreamMessage,
} from "../src/app/features/watchlist/after-hours-stream";
import type { SyntheticLatestClose } from "../src/app/platform/provider-contracts";

class FakeRelayWebSocket extends EventTarget implements WatchlistAfterHoursRelayWebSocket {
  readyState = 1;
  bufferedAmount = 0;
  accepted = false;
  readonly sent: string[] = [];
  readonly closes: Readonly<{ code?: number; reason?: string }>[] = [];

  accept() {
    this.accepted = true;
  }

  send(message: string | ArrayBuffer | ArrayBufferView) {
    if (typeof message !== "string") throw new Error("expected text frame");
    this.sent.push(message);
  }

  close(code?: number, reason?: string) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
  }

  browserClose() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

function missing(symbol: string): SyntheticLatestClose {
  return {
    symbol,
    sourceSymbol: `BINANCE:${symbol}USDT.P`,
    close: null,
    currency: "USDT",
    source: "tradingview-websocket",
    updatedAt: null,
  };
}

function present(symbol: string, close: number): SyntheticLatestClose {
  return {
    ...missing(symbol),
    close,
    updatedAt: "2026-08-13T12:00:00.000Z",
  };
}

function upgradeRequest(
  symbols: string,
  headers: HeadersInit = {},
  signal?: AbortSignal,
) {
  return new Request(
    `https://trader.example/api/v1/watchlists/after-hours/stream?symbols=${symbols}`,
    {
      headers: {
        origin: "https://trader.example",
        "sec-fetch-site": "same-origin",
        upgrade: "websocket",
        "oai-authenticated-user-id": "site-user-1",
        ...Object.fromEntries(new Headers(headers)),
      },
      signal,
    },
  );
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}

test("raw Worker websocket relays canonical requested-order nulls and tick arrival order", async () => {
  const client = new FakeRelayWebSocket();
  const server = new FakeRelayWebSocket();
  const values = [
    missing("AAPL"),
    missing("MSFT"),
    present("MSFT", 501.25),
    present("AAPL", 303.75),
  ];
  const receivedSymbols: readonly string[][] = [];
  const response = await handleWatchlistAfterHoursWebSocketUpgrade(
    upgradeRequest("AAPL,MSFT"),
    {
      environment: {},
      createPair: () => ({ client, server }),
      createUpgradeResponse: (_socket, requestId) => new Response(null, {
        status: 200,
        headers: { "x-request-id": requestId },
      }),
      createStream: async (_environment, symbols) => {
        (receivedSymbols as string[][]).push([...symbols]);
        return new ReadableStream<SyntheticLatestClose>({
          start(controller) {
            for (const value of values) controller.enqueue(value);
            controller.close();
          },
        });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(server.accepted, true);
  await waitFor(() => server.sent.length === values.length);
  assert.deepEqual(receivedSymbols, [["AAPL", "MSFT"]]);
  assert.deepEqual(
    server.sent.map((payload) => parseWatchlistAfterHoursStreamMessage(payload)?.item),
    values,
  );
  assert.deepEqual(
    server.sent.map((payload) => JSON.parse(payload).type),
    ["quote", "quote", "quote", "quote"],
  );
  assert.ok(server.sent.every((payload) => payload.includes("USDT.P")));
  await waitFor(() => server.closes.length === 1);
  assert.equal(server.closes[0]?.code, 1000);
});

test("browser websocket close cancels the existing Market data provider stream exactly once", async () => {
  const client = new FakeRelayWebSocket();
  const server = new FakeRelayWebSocket();
  let cancelCount = 0;
  await handleWatchlistAfterHoursWebSocketUpgrade(upgradeRequest("AAPL"), {
    environment: {},
    createPair: () => ({ client, server }),
    createUpgradeResponse: () => new Response(null, { status: 200 }),
    createStream: async () => new ReadableStream<SyntheticLatestClose>({
      start(controller) {
        controller.enqueue(missing("AAPL"));
      },
      cancel() {
        cancelCount += 1;
      },
    }),
  });
  await waitFor(() => server.sent.length === 1);

  server.browserClose();
  await waitFor(() => cancelCount === 1);
  server.dispatchEvent(new Event("error"));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelCount, 1);
  assert.deepEqual(server.closes, []);
});

test("HTTP request abort after upgrade leaves Safari websocket relay alive until browser close", async () => {
  const requestController = new AbortController();
  const client = new FakeRelayWebSocket();
  const server = new FakeRelayWebSocket();
  let cancelCount = 0;
  await handleWatchlistAfterHoursWebSocketUpgrade(
    upgradeRequest("AAPL", {}, requestController.signal),
    {
      environment: {},
      createPair: () => ({ client, server }),
      createUpgradeResponse: () => new Response(null, { status: 200 }),
      createStream: async () => new ReadableStream<SyntheticLatestClose>({
        start(controller) {
          controller.enqueue(missing("AAPL"));
        },
        cancel() {
          cancelCount += 1;
        },
      }),
    },
  );
  await waitFor(() => server.sent.length === 1);

  requestController.abort("HTTP upgrade request completed");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelCount, 0);
  assert.equal(server.readyState, 1);

  server.browserClose();
  await waitFor(() => cancelCount === 1);
});

test("relay cancels upstream on setup failure and closes a slow browser", async () => {
  let setupCancelCount = 0;
  const setupFailure = await handleWatchlistAfterHoursWebSocketUpgrade(
    upgradeRequest("AAPL"),
    {
      environment: {},
      createPair: () => { throw new Error("pair unavailable"); },
      createStream: async () => new ReadableStream<SyntheticLatestClose>({
        cancel() {
          setupCancelCount += 1;
        },
      }),
    },
  );
  assert.equal(setupFailure.status, 500);
  assert.equal(setupCancelCount, 1);

  const client = new FakeRelayWebSocket();
  const server = new FakeRelayWebSocket();
  server.bufferedAmount = 1_048_577;
  let slowCancelCount = 0;
  await handleWatchlistAfterHoursWebSocketUpgrade(upgradeRequest("AAPL"), {
    environment: {},
    createPair: () => ({ client, server }),
    createUpgradeResponse: () => new Response(null, { status: 200 }),
    createStream: async () => new ReadableStream<SyntheticLatestClose>({
      start(controller) {
        controller.enqueue(present("AAPL", 303.75));
      },
      cancel() {
        slowCancelCount += 1;
      },
    }),
  });
  await waitFor(() => slowCancelCount === 1);
  await waitFor(() => server.closes.length === 1);
  assert.equal(server.sent.length, 0);
  assert.deepEqual(server.closes, [{ code: 1013, reason: "browser is too slow" }]);
});

test("websocket upgrade rejects cross-origin, unauthenticated, duplicate, and oversized input before upstream", async () => {
  let streamCalls = 0;
  const dependencies = {
    environment: {},
    createStream: async () => {
      streamCalls += 1;
      return new ReadableStream<SyntheticLatestClose>();
    },
  } as const;

  const crossOrigin = await handleWatchlistAfterHoursWebSocketUpgrade(
    upgradeRequest("AAPL", {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }),
    dependencies,
  );
  assert.equal(crossOrigin.status, 403);

  const unauthenticated = await handleWatchlistAfterHoursWebSocketUpgrade(new Request(
    "https://trader.example/api/v1/watchlists/after-hours/stream?symbols=AAPL",
    { headers: { origin: "https://trader.example", upgrade: "websocket" } },
  ), dependencies);
  assert.equal(unauthenticated.status, 401);

  const duplicate = await handleWatchlistAfterHoursWebSocketUpgrade(
    upgradeRequest("AAPL,AAPL"),
    dependencies,
  );
  assert.equal(duplicate.status, 400);

  const oversized = await handleWatchlistAfterHoursWebSocketUpgrade(
    upgradeRequest(Array.from({ length: 51 }, (_, index) => `S${index}`).join(",")),
    dependencies,
  );
  assert.equal(oversized.status, 400);
  assert.equal(streamCalls, 0);
});

test("Sites snapshots do not advertise Worker WebSocket and the client only connects to an explicit transport", async () => {
  const [workerSource, routeSource, pageSource] = await Promise.all([
    readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL(
      "../src/app/api/v1/watchlists/after-hours/route.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
  ]);

  const websocketIndex = workerSource.indexOf("handleWatchlistAfterHoursWebSocketUpgrade(request)");
  const vinextIndex = workerSource.indexOf("handler.fetch(request, env, ctx)");
  assert.ok(websocketIndex >= 0 && websocketIndex < vinextIndex);
  assert.match(routeSource, /streamSupported: sidecarConfigured/);
  assert.match(routeSource, /sidecarConfigured\s+\? \{ streamTransport: "sse" as const \}\s+: \{\}/);
  assert.doesNotMatch(routeSource, /streamTransport: "websocket"/);
  assert.match(pageSource, /new WebSocket\(socketUrl\)/);
  assert.match(pageSource, /const nextTransport = response\.streamTransport/);
  assert.match(pageSource, /streamSupported = response\.streamSupported === true\s+&& nextTransport !== undefined/);
  assert.doesNotMatch(pageSource, /response\.streamTransport\s+\?\?/);
  assert.match(pageSource, /if \(!isFreshSyntheticLatestClose\(message\.item\)\) return false;/);
  assert.match(pageSource, /WATCHLIST_AFTER_HOURS_PRESENT_TIMEOUT_MS = 30_000/);
  assert.match(pageSource, /WATCHLIST_AFTER_HOURS_LIVENESS_TIMEOUT_MS = 45_000/);
  assert.match(pageSource, /webSocket !== socket/);
  assert.match(pageSource, /socket\.onmessage = null/);
  assert.match(pageSource, /\|\| reconnectTimer !== undefined\s*\|\| Date\.now\(\) < reconnectNotBefore/);
  assert.match(pageSource, /if \(disposed \|\| failureHandled\) return;/);
  const failureBackoffIndex = pageSource.indexOf("reconnectNotBefore = Date.now() + delay;");
  const reconnectTimerIndex = pageSource.indexOf(
    "reconnectTimer = window.setTimeout(reconnectAfterBackoff, delay);",
    failureBackoffIndex,
  );
  const failureSnapshotIndex = pageSource.indexOf("refresh();", failureBackoffIndex);
  assert.ok(failureBackoffIndex >= 0);
  assert.ok(reconnectTimerIndex > failureBackoffIndex);
  assert.ok(failureSnapshotIndex > failureBackoffIndex);
  assert.ok(reconnectTimerIndex < failureSnapshotIndex);
  assert.match(pageSource, /fetch\("\/api\/v1\/watchlists\/after-hours"/);
  assert.match(pageSource, /if \(disposed \|\| document\.hidden \|\| refreshTimer !== undefined\) return;/);
});
