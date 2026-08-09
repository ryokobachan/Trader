import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildYahooDevelopmentEnvironment,
  yahooDevelopmentCommand,
} from "../scripts/dev-with-yahoo.mjs";

test("builds a forced keyless Yahoo and Benzinga profile without Midas or FMP settings", () => {
  const environment = buildYahooDevelopmentEnvironment({
    PATH: "/usr/bin",
    FMP_API_KEY: "not-forwarded",
    FMP_BASE_URL: "https://not-forwarded.example",
    MIDAS_ENV_FILE: "/not/forwarded/.env",
    MIDAS_UNICORN_API_TOKEN: "not-forwarded",
    UNICORN_USAGE_MODE: "hosted",
    UNICORN_ENABLE_YAHOO_COMPAT: "false",
    UNICORN_INSTRUMENT_PROVIDER: "fmp",
    UNICORN_MARKET_PROVIDER: "mock",
    UNICORN_PROFILE_PROVIDER: "fmp",
    UNICORN_NEWS_PROVIDER: "fmp",
    UNICORN_FUNDAMENTALS_PROVIDER: "fmp",
    UNICORN_EARNINGS_PROVIDER: "fmp",
    UNICORN_FUNDAMENTALS_PROVIDERS: "fmp,sec-companyfacts",
    UNICORN_ANALYST_PROVIDER: "fmp",
  });

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.UNICORN_USAGE_MODE, "personal");
  assert.equal(environment.UNICORN_ENABLE_YAHOO_COMPAT, "true");
  assert.equal(environment.UNICORN_INSTRUMENT_PROVIDER, "yahoo");
  assert.equal(environment.UNICORN_MARKET_PROVIDER, "yahoo");
  assert.equal(environment.UNICORN_PROFILE_PROVIDER, "yahoo");
  assert.equal(environment.UNICORN_FUNDAMENTALS_PROVIDER, "yahoo");
  assert.equal(environment.UNICORN_EARNINGS_PROVIDER, "yahoo");
  assert.equal(environment.UNICORN_ANALYST_PROVIDER, "benzinga");
  assert.equal(environment.UNICORN_NEWS_PROVIDER, "yahoo");
  assert.equal(environment.UNICORN_FUNDAMENTALS_PROVIDERS, undefined);
  assert.equal(environment.FMP_API_KEY, undefined);
  assert.equal(environment.FMP_BASE_URL, undefined);
  assert.equal(environment.MIDAS_ENV_FILE, undefined);
  assert.equal(environment.MIDAS_UNICORN_API_TOKEN, undefined);
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
  const launcherUrl = new URL("../scripts/dev-with-yahoo.mjs", import.meta.url).href;
  const evaluation = `
    import { buildYahooDevelopmentEnvironment } from ${JSON.stringify(launcherUrl)};
    buildYahooDevelopmentEnvironment({
      FMP_API_KEY: "not-for-output",
      MIDAS_UNICORN_API_TOKEN: "also-not-for-output"
    });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", evaluation], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
