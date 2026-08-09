import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  mergeMidasEnv,
  MIDAS_ENV_ALLOWLIST,
  parseMidasEnv,
} from "../scripts/dev-with-midas-env.mjs";

test("parses basic, quoted, and exported allowlisted values", () => {
  const parsed = parseMidasEnv(`
    # Midas development settings
    FMP_API_KEY=plain-secret
    FMP_BASE_URL="https://example.test/stable?mode=dev#fragment"
    export FMP_TIMEOUT_SECONDS='25'
    SEC_EDGAR_USER_AGENT="Unicorn Research\\ncontact@example.test"
    BENZINGA_API_TOKEN=benzinga-token
    BENZINGA_API_KEY=legacy-benzinga-key
    BENZINGA_TIMEOUT_SECONDS=15
    BENZINGA_ANALYST_RATINGS_ENDPOINT=https://ratings.example.test/calendar/ratings
    BENZINGA_ANALYST_RATINGS_DISABLED=false
    API_SERVER_KEY=must-not-cross-the-boundary
    X_API_BEARER_TOKEN="also-blocked"
  `);

  assert.deepEqual(parsed, {
    FMP_API_KEY: "plain-secret",
    FMP_BASE_URL: "https://example.test/stable?mode=dev#fragment",
    FMP_TIMEOUT_SECONDS: "25",
    SEC_EDGAR_USER_AGENT: "Unicorn Research\ncontact@example.test",
    BENZINGA_API_TOKEN: "benzinga-token",
    BENZINGA_API_KEY: "legacy-benzinga-key",
    BENZINGA_TIMEOUT_SECONDS: "15",
    BENZINGA_ANALYST_RATINGS_ENDPOINT: "https://ratings.example.test/calendar/ratings",
    BENZINGA_ANALYST_RATINGS_DISABLED: "false",
  });
  assert.deepEqual(Object.keys(parsed).sort(), [...MIDAS_ENV_ALLOWLIST].sort());
  assert.equal("API_SERVER_KEY" in parsed, false);
  assert.equal("X_API_BEARER_TOKEN" in parsed, false);
});

test("handles comments and ignores malformed allowlisted assignments", () => {
  const parsed = parseMidasEnv(`
    FMP_API_KEY=value-before-comment # local note
    FMP_BASE_URL=https://example.test/path#literal-fragment
    FMP_TIMEOUT_SECONDS="unterminated
    SEC_EDGAR_USER_AGENT="valid" unexpected-suffix
  `);

  assert.deepEqual(parsed, {
    FMP_API_KEY: "value-before-comment",
    FMP_BASE_URL: "https://example.test/path#literal-fragment",
  });
});

test("merges only allowlisted values, preserves existing values, and applies Unicorn defaults", () => {
  const merged = mergeMidasEnv(
    {
      PATH: "/usr/bin",
      MIDAS_ENV_FILE: "/private/source.env",
      FMP_API_KEY: "existing-fmp-key",
      UNICORN_USAGE_MODE: "team",
      UNICORN_MARKET_PROVIDER: "massive",
    },
    {
      FMP_API_KEY: "midas-fmp-key",
      FMP_BASE_URL: "https://example.test/stable",
      FMP_TIMEOUT_SECONDS: "20",
      SEC_EDGAR_USER_AGENT: "Unicorn contact@example.test",
      BENZINGA_API_TOKEN: "midas-benzinga-token",
      API_SERVER_KEY: "blocked-api-key",
    },
  );

  assert.equal(merged.PATH, "/usr/bin");
  assert.equal(merged.MIDAS_ENV_FILE, undefined);
  assert.equal(merged.FMP_API_KEY, "existing-fmp-key");
  assert.equal(merged.FMP_BASE_URL, "https://example.test/stable");
  assert.equal(merged.FMP_TIMEOUT_SECONDS, "20");
  assert.equal(merged.SEC_EDGAR_USER_AGENT, "Unicorn contact@example.test");
  assert.equal(merged.BENZINGA_API_TOKEN, "midas-benzinga-token");
  assert.equal(merged.API_SERVER_KEY, undefined);
  assert.equal(merged.UNICORN_USAGE_MODE, "team");
  assert.equal(merged.UNICORN_ENABLE_YAHOO_COMPAT, "true");
  assert.equal(merged.UNICORN_INSTRUMENT_PROVIDER, "yahoo");
  assert.equal(merged.UNICORN_MARKET_PROVIDER, "massive");
  assert.equal(merged.UNICORN_PROFILE_PROVIDER, "fmp");
  assert.equal(merged.UNICORN_FUNDAMENTALS_PROVIDER, "yahoo");
  assert.equal(merged.UNICORN_EARNINGS_PROVIDER, "fmp");
  assert.equal(merged.UNICORN_ANALYST_PROVIDER, "benzinga");
  assert.equal(merged.UNICORN_NEWS_PROVIDER, "yahoo");
});

test("importing and using helpers emits no secret values", () => {
  const launcherUrl = new URL("../scripts/dev-with-midas-env.mjs", import.meta.url).href;
  const secret = "secret-that-must-not-be-printed";
  const evaluation = `
    import { parseMidasEnv, mergeMidasEnv } from ${JSON.stringify(launcherUrl)};
    const parsed = parseMidasEnv(${JSON.stringify(`FMP_API_KEY=${secret}\nAPI_SERVER_KEY=blocked`)});
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
  const launcherPath = fileURLToPath(new URL("../scripts/dev-with-midas-env.mjs", import.meta.url));
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

test("documents Yahoo as the instrument search provider in the local real-data profile", async () => {
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");

  assert.match(example, /^# UNICORN_INSTRUMENT_PROVIDER=yahoo$/m);
  assert.match(example, /^# UNICORN_PROFILE_PROVIDER=fmp$/m);
  assert.match(example, /^# UNICORN_FUNDAMENTALS_PROVIDER=yahoo$/m);
  assert.match(example, /^# UNICORN_EARNINGS_PROVIDER=fmp$/m);
  assert.match(example, /^# UNICORN_ANALYST_PROVIDER=benzinga$/m);
  assert.match(example, /^# UNICORN_NEWS_PROVIDER=yahoo$/m);
  assert.doesNotMatch(example, /^# UNICORN_INSTRUMENT_PROVIDER=fmp$/m);
});
