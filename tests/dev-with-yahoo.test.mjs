import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildYahooDevelopmentEnvironment,
  yahooDevelopmentCommand,
} from "../src/tooling/scripts/dev-with-yahoo.mjs";

test("builds a forced keyless Yahoo and Benzinga profile without Midas or FMP settings", () => {
  const environment = buildYahooDevelopmentEnvironment({
    PATH: "/usr/bin",
    FMP_API_KEY: "not-forwarded",
    FMP_BASE_URL: "https://not-forwarded.example",
    MIDAS_ENV_FILE: "/not/forwarded/.env",
    MIDAS_TRADER_API_TOKEN: "not-forwarded",
    TRADER_USAGE_MODE: "hosted",
    TRADER_ENABLE_YAHOO_COMPAT: "false",
    TRADER_INSTRUMENT_PROVIDER: "fmp",
    TRADER_MARKET_PROVIDER: "mock",
    TRADER_PROFILE_PROVIDER: "fmp",
    TRADER_NEWS_PROVIDER: "fmp",
    TRADER_FUNDAMENTALS_PROVIDER: "fmp",
    TRADER_EARNINGS_PROVIDER: "fmp",
    TRADER_ANALYST_PROVIDER: "fmp",
  });

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.TRADER_USAGE_MODE, "personal");
  assert.equal(environment.TRADER_ENABLE_YAHOO_COMPAT, "true");
  assert.equal(environment.TRADER_INSTRUMENT_PROVIDER, "yahoo");
  assert.equal(environment.TRADER_MARKET_PROVIDER, "tradingview-websocket");
  assert.equal(environment.TRADER_PROFILE_PROVIDER, "yahoo");
  assert.equal(environment.TRADER_FUNDAMENTALS_PROVIDER, "yahoo");
  assert.equal(environment.TRADER_EARNINGS_PROVIDER, "yahoo");
  assert.equal(environment.TRADER_ANALYST_PROVIDER, "benzinga");
  assert.equal(environment.TRADER_NEWS_PROVIDER, "yahoo");
  assert.equal(environment.FMP_API_KEY, undefined);
  assert.equal(environment.FMP_BASE_URL, undefined);
  assert.equal(environment.MIDAS_ENV_FILE, undefined);
  assert.equal(environment.MIDAS_TRADER_API_TOKEN, undefined);
});

test("constructs the npm command without a shell on Unix and Windows", () => {
  assert.deepEqual(yahooDevelopmentCommand("darwin"), {
    executable: "npm",
    args: ["run", "dev", "--", "--port", "3001"],
  });
  assert.deepEqual(yahooDevelopmentCommand("linux"), {
    executable: "npm",
    args: ["run", "dev", "--", "--port", "3001"],
  });
  assert.deepEqual(yahooDevelopmentCommand("win32"), {
    executable: "npm.cmd",
    args: ["run", "dev", "--", "--port", "3001"],
  });
});

test("importing and building the profile emits no secret values", () => {
  const launcherUrl = new URL("../src/tooling/scripts/dev-with-yahoo.mjs", import.meta.url).href;
  const evaluation = `
    import { buildYahooDevelopmentEnvironment } from ${JSON.stringify(launcherUrl)};
    buildYahooDevelopmentEnvironment({
      FMP_API_KEY: "not-for-output",
      MIDAS_TRADER_API_TOKEN: "also-not-for-output"
    });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", evaluation], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
