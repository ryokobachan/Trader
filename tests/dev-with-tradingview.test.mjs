import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROVIDER_ENVIRONMENT_KEYS } from "../api/environment.ts";

import {
  findAvailableLoopbackPort,
  isTradingViewSidecarHealth,
  selectedDevelopmentProfile,
  tradingViewDevelopmentProfile,
} from "../src/tooling/scripts/dev-with-tradingview.mjs";

test("forces chart bars through the authenticated local TradingView sidecar", () => {
  const environment = tradingViewDevelopmentProfile({
    PATH: "/usr/bin",
    UNICORN_BARS_PROVIDER: "yahoo",
    UNICORN_TRADINGVIEW_SIDECAR_URL: "https://ignored.example.test",
  }, "test-sidecar-token", 8876);

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.UNICORN_BARS_PROVIDER, "tradingview-websocket");
  assert.equal(environment.UNICORN_TRADINGVIEW_SIDECAR_URL, "http://127.0.0.1:8876");
  assert.equal(environment.UNICORN_TRADINGVIEW_SIDECAR_TOKEN, "test-sidecar-token");
  assert.equal(environment.UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS, "25000");
  assert.equal(environment.UNICORN_TRADINGVIEW_MAX_CANDLES, "10000");
});

test("keeps the default sidecar port separate from the Midas bridge", () => {
  const environment = tradingViewDevelopmentProfile({}, "test-sidecar-token");
  assert.equal(environment.UNICORN_TRADINGVIEW_SIDECAR_URL, "http://127.0.0.1:8791");
});

test("allocates an available loopback port and rejects unrelated health pages", async () => {
  const port = await findAvailableLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);
  assert.equal(isTradingViewSidecarHealth({ status: "ok" }), false);
  assert.equal(isTradingViewSidecarHealth({
    schemaVersion: "unicorn.tradingview-sidecar.v1",
    status: "ok",
    backend: "tradingview-websocket",
  }), true);
});

test("forwards the chart provider and sidecar credentials into local Worker bindings", () => {
  for (const binding of [
    "UNICORN_BARS_PROVIDER",
    "UNICORN_TRADINGVIEW_SIDECAR_URL",
    "UNICORN_TRADINGVIEW_SIDECAR_TOKEN",
    "UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS",
    "UNICORN_TRADINGVIEW_MAX_CANDLES",
  ]) {
    assert.ok(PROVIDER_ENVIRONMENT_KEYS.includes(binding));
  }
});

test("sidecar contract permits 10,000 candles and reports requested/returned counts", async () => {
  const source = await readFile(new URL("../api/tradingview-websocket/sidecar.py", import.meta.url), "utf8");
  assert.match(source, /MAX_CANDLE_COUNT = 10_000/);
  assert.match(source, /"requestedCount": count/);
  assert.match(source, /"returnedCount": len\(items\)/);
  assert.ok(
    source.indexOf("result_queue.get(timeout=timeout_seconds)")
      < source.indexOf("process.join(2)"),
    "large payloads must be drained before the child process is joined",
  );
});

test("selects the requested live-data profile without reading credential values", () => {
  assert.equal(selectedDevelopmentProfile(["--profile=yahoo"], { MIDAS_ENV_FILE: "/private/midas.env" }), "yahoo");
  assert.equal(selectedDevelopmentProfile(["--profile=midas"], {}), "midas");
  assert.equal(selectedDevelopmentProfile([], { MIDAS_ENV_FILE: "/private/midas.env" }), "midas");
  assert.equal(selectedDevelopmentProfile([], {}), "yahoo");
});
