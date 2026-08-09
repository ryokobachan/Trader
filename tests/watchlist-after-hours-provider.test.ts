import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import { POST } from "../src/app/api/v1/watchlists/after-hours/route";
import type { WatchlistAfterHoursResponse } from "../src/app/platform/provider-contracts";
import {
  createTradingViewSidecarProvider,
  DEFAULT_TRADINGVIEW_SYNTHETIC_EXCHANGES,
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
  assert.match(source, /close_value is not None and close_value > 0/);
  assert.doesNotMatch(source, /ThreadPoolExecutor/);
});

test("watchlist UI renders a derived USDT perpetual close column with a dash fallback", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");

  assert.match(pageSource, /t\("watchlist\.afterHours"\)/);
  assert.match(pageSource, /t\("watchlist\.afterHoursTooltip", \{ symbol: item\.ticker \}\)/);
  assert.match(pageSource, /\/api\/v1\/watchlists\/after-hours/);
  assert.match(pageSource, /afterHours\[item\.ticker\]/);
  assert.match(pageSource, /: "-"/);
  assert.match(pageSource, /className="watch-price">\{formatWatchlistPrice\(item\)\}/);
  assert.match(pageSource, /afterHoursClose > item\.price/);
  assert.match(pageSource, /afterHoursClose < item\.price/);
  assert.match(styles, /\.watch-after-hours\.is-higher\s*{\s*color: var\(--green\)/);
  assert.match(styles, /\.watch-after-hours\.is-lower\s*{\s*color: var\(--red\)/);
  assert.match(styles, /\.watch-after-hours\.is-equal\s*{\s*color: #fff/);
});

test("watchlist rows expose an accessible context menu backed by the durable delete endpoint", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /onContextMenu=\{\(event\) =>/);
  assert.match(pageSource, /event\.key !== "ContextMenu"/);
  assert.match(pageSource, /event\.shiftKey && event\.key === "F10"/);
  assert.match(pageSource, /open: rowContextMenu !== null/);
  assert.match(pageSource, /restoreFocusRef: rowContextTriggerRef/);
  assert.match(pageSource, /role="menuitem"/);
  assert.match(pageSource, /t\("watchlist\.remove"\)/);
  assert.match(pageSource, /method: "DELETE"/);
  assert.match(pageSource, /items: watchlist\.items\.filter\(\(item\) => item\.id !== existing\.id\)/);
  assert.match(pageSource, /onDelete=\{removeWatchlistItem\}/);
});
