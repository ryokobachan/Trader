import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  mergeMidasEnv,
  MIDAS_ENV_ALLOWLIST,
  parseMidasEnv,
} from "../src/tooling/scripts/dev-with-midas-env.mjs";

test("parses basic, quoted, and exported allowlisted values", () => {
  const parsed = parseMidasEnv(`
    # Midas development settings
    BENZINGA_API_TOKEN=benzinga-token
    BENZINGA_API_KEY='legacy-benzinga-key'
    export BENZINGA_TIMEOUT_SECONDS='15'
    BENZINGA_ANALYST_RATINGS_ENDPOINT="https://ratings.example.test/calendar/ratings?mode=dev#fragment"
    BENZINGA_ANALYST_RATINGS_DISABLED=false
    API_SERVER_KEY=must-not-cross-the-boundary
    X_API_BEARER_TOKEN="also-blocked"
  `);

  assert.deepEqual(parsed, {
    BENZINGA_API_TOKEN: "benzinga-token",
    BENZINGA_API_KEY: "legacy-benzinga-key",
    BENZINGA_TIMEOUT_SECONDS: "15",
    BENZINGA_ANALYST_RATINGS_ENDPOINT: "https://ratings.example.test/calendar/ratings?mode=dev#fragment",
    BENZINGA_ANALYST_RATINGS_DISABLED: "false",
  });
  assert.deepEqual(Object.keys(parsed).sort(), [...MIDAS_ENV_ALLOWLIST].sort());
  assert.equal("API_SERVER_KEY" in parsed, false);
  assert.equal("X_API_BEARER_TOKEN" in parsed, false);
});

test("handles comments and ignores malformed allowlisted assignments", () => {
  const parsed = parseMidasEnv(`
    BENZINGA_API_TOKEN=value-before-comment # local note
    BENZINGA_ANALYST_RATINGS_ENDPOINT=https://example.test/path#literal-fragment
    BENZINGA_TIMEOUT_SECONDS="unterminated
    BENZINGA_API_KEY="valid" unexpected-suffix
  `);

  assert.deepEqual(parsed, {
    BENZINGA_API_TOKEN: "value-before-comment",
    BENZINGA_ANALYST_RATINGS_ENDPOINT: "https://example.test/path#literal-fragment",
  });
});

test("merges only allowlisted values, preserves existing values, and applies Trader defaults", () => {
  const merged = mergeMidasEnv(
    {
      PATH: "/usr/bin",
      MIDAS_ENV_FILE: "/private/source.env",
      BENZINGA_API_TOKEN: "existing-benzinga-token",
      TRADER_USAGE_MODE: "team",
      TRADER_MARKET_PROVIDER: "massive",
    },
    {
      BENZINGA_API_TOKEN: "midas-benzinga-token",
      BENZINGA_TIMEOUT_SECONDS: "20",
      API_SERVER_KEY: "blocked-api-key",
    },
  );

  assert.equal(merged.PATH, "/usr/bin");
  assert.equal(merged.MIDAS_ENV_FILE, undefined);
  assert.equal(merged.BENZINGA_API_TOKEN, "existing-benzinga-token");
  assert.equal(merged.BENZINGA_TIMEOUT_SECONDS, "20");
  assert.equal(merged.API_SERVER_KEY, undefined);
  assert.equal(merged.TRADER_USAGE_MODE, "team");
  assert.equal(merged.TRADER_ENABLE_YAHOO_COMPAT, "true");
  assert.equal(merged.TRADER_INSTRUMENT_PROVIDER, "yahoo");
  assert.equal(merged.TRADER_MARKET_PROVIDER, "massive");
  assert.equal(merged.TRADER_PROFILE_PROVIDER, "yahoo");
  assert.equal(merged.TRADER_FUNDAMENTALS_PROVIDER, "tradingview");
  assert.equal(merged.TRADER_EARNINGS_PROVIDER, "tradingview");
  assert.equal(merged.TRADER_RESEARCH_PROVIDER, "yahoo");
  assert.equal(merged.TRADER_ANALYST_PROVIDER, "google-finance-benzinga");
  assert.equal(merged.TRADER_NEWS_PROVIDER, "yahoo");
});

test("retired FMP credentials are neither imported from Midas nor inherited by Trader", () => {
  const parsed = parseMidasEnv("FMP_API_KEY=retired-secret\nFMP_BASE_URL=https://old.example.test\nFMP_TIMEOUT_SECONDS=20");
  assert.deepEqual(parsed, {});
  assert.equal(MIDAS_ENV_ALLOWLIST.some((name) => name.startsWith("FMP_")), false);
  const merged = mergeMidasEnv({ FMP_API_KEY: "inherited-secret", FMP_CUSTOM_TOKEN: "inherited-other" }, {
    FMP_API_KEY: "attempted-import", FMP_BASE_URL: "https://old.example.test",
  });
  assert.equal(Object.keys(merged).some((name) => name.startsWith("FMP_")), false);
});

test("importing and using helpers emits no secret values", () => {
  const launcherUrl = new URL("../src/tooling/scripts/dev-with-midas-env.mjs", import.meta.url).href;
  const secret = "secret-that-must-not-be-printed";
  const evaluation = `
    import { parseMidasEnv, mergeMidasEnv } from ${JSON.stringify(launcherUrl)};
    const parsed = parseMidasEnv(${JSON.stringify(`BENZINGA_API_TOKEN=${secret}\nAPI_SERVER_KEY=blocked`)});
    mergeMidasEnv({}, parsed);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", evaluation], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});

test("launcher reports an unreadable source without exposing its path", () => {
  const launcherPath = fileURLToPath(new URL("../src/tooling/scripts/dev-with-midas-env.mjs", import.meta.url));
  const secretPath = `/tmp/midas-private-${process.pid}-do-not-print.env`;
  const result = spawnSync(process.execPath, [launcherPath], {
    env: { ...process.env, MIDAS_ENV_FILE: secretPath },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes(secretPath), false);
  assert.equal(result.stderr.includes(secretPath), false);
  assert.match(result.stderr, /could not be read/i);
});

test("documents the TradingView, Google Finance and Yahoo real-data roles", async () => {
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");

  assert.match(example, /^# TRADER_INSTRUMENT_PROVIDER=yahoo$/m);
  assert.match(example, /^# TRADER_PROFILE_PROVIDER=yahoo$/m);
  assert.match(example, /^# TRADER_FUNDAMENTALS_PROVIDER=tradingview$/m);
  assert.match(example, /^# TRADER_EARNINGS_PROVIDER=tradingview$/m);
  assert.match(example, /^# TRADER_RESEARCH_PROVIDER=yahoo$/m);
  assert.match(example, /^# TRADER_ANALYST_PROVIDER=google-finance-benzinga$/m);
  assert.match(example, /^# TRADER_NEWS_PROVIDER=yahoo$/m);
  assert.doesNotMatch(example, /^(?:# )?(?:FMP_|TRADER_\w+_PROVIDER=fmp)/m);
});
