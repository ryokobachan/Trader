import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { traderConfig } from "../src/app/trader.config";
import {
  defineTraderConfig,
  PROVIDER_IDS_BY_ROLE,
  TraderConfigError,
} from "../src/app/platform/trader-config";
import type { ProviderCapability } from "../src/app/platform/provider-contracts";
import { PROVIDER_ENVIRONMENT_KEYS } from "../api/environment";
import {
  listInstalledProviderManifests,
  resolveProviderSelections,
} from "../api/index.server";
import { strategyPackagesForLocale } from "../src/app/features/strategy/catalog";
import { createStrategyTranslator } from "../src/app/features/strategy/i18n";
import { buildStrategySummaryMetricRegistry } from "../src/app/features/strategy/metrics";

function editableConfig() {
  return structuredClone(traderConfig);
}

function expectConfigError(mutator: (value: ReturnType<typeof editableConfig>) => void, path: string) {
  const value = editableConfig();
  mutator(value);
  assert.throws(
    () => defineTraderConfig(value),
    (error: unknown) => {
      assert.ok(error instanceof TraderConfigError);
      assert.equal(error.path, path);
      return true;
    },
  );
}

test("loads one validated non-secret master configuration", () => {
  assert.equal(traderConfig.schemaVersion, "trader.config.v1");
  assert.equal(traderConfig.providers.instrument, "mock");
  assert.equal(traderConfig.providers.market, "mock");
  assert.equal(traderConfig.ui.symbolSummary.modules[0], "core.identity_quote@1.0.0");
  assert.deepEqual(traderConfig.ui.symbolDetail.tabs, ["overview", "financials", "technicals", "ownership", "dividends", "analyst", "news"]);
  assert.equal(traderConfig.providers.research, null);
  assert.ok(traderConfig.ui.symbolDetail.fundamentalGroups.some((group) => (
    group.id === "financial_health"
    && group.metrics.includes("fundamentals.piotroskiScore")
    && group.metrics.includes("fundamentals.freeFloatRatio")
  )));
  assert.deepEqual(traderConfig.ui.symbolDetail.profileMetrics, [
    "profile.exchange",
    "profile.assetType",
    "profile.sector",
    "profile.industry",
    "profile.location",
    "profile.employees",
    "profile.marketCap",
    "profile.ipoDate",
    "profile.beta",
  ]);
  assert.deepEqual(traderConfig.ui.strategyDetail.summaryMetrics, [
    "portfolio.value",
    "portfolio.unrealizedGain",
    "portfolio.totalGain",
    "portfolio.annualReturn",
    "risk.recoveryFactor",
    "risk.sharpe",
    "trades.winRate",
    "risk.maxDrawdown",
  ]);
  assert.equal(Object.isFrozen(traderConfig), true);
  assert.equal(Object.isFrozen(traderConfig.ui.symbolDetail.tabs), true);
  assert.equal(Object.isFrozen(traderConfig.ui.symbolDetail.profileMetrics), true);
});

test("rejects unknown fields, unknown IDs, duplicates, and a missing fixed identity", () => {
  expectConfigError((value) => {
    Object.assign(value.ui.symbolDetail, { remoteComponentUrl: "https://example.invalid/plugin.js" });
  }, "ui.symbolDetail.remoteComponentUrl");
  expectConfigError((value) => {
    Object.assign(value.ui.symbolDetail.tabs, { 0: "unknown-tab" });
  }, "ui.symbolDetail.tabs[0]");
  expectConfigError((value) => {
    Object.assign(value.ui.symbolDetail.technicalMetrics, { 1: value.ui.symbolDetail.technicalMetrics[0] });
  }, "ui.symbolDetail.technicalMetrics[1]");
  expectConfigError((value) => {
    Object.assign(value.ui.symbolDetail.profileMetrics, { 1: value.ui.symbolDetail.profileMetrics[0] });
  }, "ui.symbolDetail.profileMetrics[1]");
  expectConfigError((value) => {
    Object.assign(value.ui.symbolSummary, { modules: value.ui.symbolSummary.modules.slice(1) });
  }, "ui.symbolSummary.modules");
});

test("rejects secret-like values, endpoints, unknown policies, and role-incompatible providers", () => {
  expectConfigError((value) => {
    Object.assign(value.providers, { apiKey: "not-allowed" });
  }, "providers.apiKey");
  expectConfigError((value) => {
    const credentialLikeValue = ["sk", "live", "51abcdefghijk"].join("_");
    Object.assign(value.providers, { market: credentialLikeValue });
  }, "providers.market");
  expectConfigError((value) => {
    Object.assign(value.universe, { policyId: "https://example.invalid/?api_key=secret" });
  }, "universe.policyId");
  expectConfigError((value) => {
    Object.assign(value.providers, { analyst: "yahoo" });
  }, "providers.analyst");
  expectConfigError((value) => {
    Object.assign(value.providers, { research: "benzinga" });
  }, "providers.research");
  expectConfigError((value) => {
    Object.assign(value.providers, { fundamentals: "fmp" });
  }, "providers.fundamentals");
});

test("the UI consumes master arrays instead of duplicating display order", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const providerSource = await readFile(new URL("../api/index.server.ts", import.meta.url), "utf8");
  assert.match(pageSource, /traderConfig\.ui\.symbolDetail\.tabs/);
  assert.match(pageSource, /traderConfig\.ui\.symbolDetail\.profileMetrics/);
  assert.match(pageSource, /traderConfig\.ui\.symbolDetail\.fundamentalGroups/);
  assert.match(pageSource, /traderConfig\.ui\.strategyDetail\.summaryMetrics/);
  assert.match(providerSource, /traderConfig\.providers\[role\]/);
});

test("the public provider allow-list matches installed manifests and role capabilities", () => {
  const required: Readonly<Record<keyof typeof PROVIDER_IDS_BY_ROLE, readonly ProviderCapability[]>> = {
    instrument: ["instrument.search", "instrument.identity"],
    market: ["market.quote"],
    bars: ["market.bars"],
    profile: ["fundamentals.profile"],
    fundamentals: ["fundamentals.normalized"],
    earnings: ["fundamentals.earnings"],
    research: ["fundamentals.research"],
    analyst: ["analyst.consensus"],
    news: ["news.company"],
  };
  const manifests = new Map(listInstalledProviderManifests().map((manifest) => [manifest.id, manifest]));
  for (const [role, ids] of Object.entries(PROVIDER_IDS_BY_ROLE) as [keyof typeof PROVIDER_IDS_BY_ROLE, readonly string[]][]) {
    for (const id of ids) {
      const manifest = manifests.get(id);
      assert.ok(manifest, `${role} provider ${id} must be installed`);
      for (const capability of required[role]) {
        assert.ok(manifest.capabilities.includes(capability), `${id} must provide ${capability}`);
      }
      for (const envName of manifest.requiredEnv) {
        assert.ok(
          PROVIDER_ENVIRONMENT_KEYS.includes(envName as (typeof PROVIDER_ENVIRONMENT_KEYS)[number]),
          `${id} required env ${envName} must cross the Worker binding boundary`,
        );
      }
    }
  }
});

test("retired FMP credentials and provider IDs are absent from every public allow-list", () => {
  assert.equal(PROVIDER_ENVIRONMENT_KEYS.some((name) => name.startsWith("FMP_")), false);
  for (const ids of Object.values(PROVIDER_IDS_BY_ROLE)) {
    assert.equal((ids as readonly string[]).includes("fmp"), false);
  }
});

test("runtime and config tooling share environment precedence and role fallbacks", () => {
  const selection = resolveProviderSelections({
    TRADER_INSTRUMENT_PROVIDER: "yahoo",
    TRADER_MARKET_PROVIDER: "yahoo",
    TRADER_FUNDAMENTALS_PROVIDER: "tradingview",
    TRADER_RESEARCH_PROVIDER: "yahoo",
  });
  assert.deepEqual(selection.instrument, {
    id: "yahoo",
    origin: "environment TRADER_INSTRUMENT_PROVIDER",
  });
  assert.deepEqual(selection.bars, { id: "yahoo", origin: "fallback from market" });
  assert.deepEqual(selection.profile, { id: "tradingview", origin: "fallback from fundamentals" });
  assert.deepEqual(selection.earnings, { id: null, origin: "fallback from fundamentals" });
  assert.deepEqual(selection.research, { id: "yahoo", origin: "environment TRADER_RESEARCH_PROVIDER" });
  assert.equal(selection.analyst.id, null);
});

test("strategy summary formulas stay in a typed registry selected by the JSON", () => {
  const selected = strategyPackagesForLocale("en")[0];
  const result = buildStrategySummaryMetricRegistry({
    selected,
    unrealizedGain: 1200,
    translate: createStrategyTranslator("en"),
  });
  assert.deepEqual(Object.keys(result.cards), [
    "portfolio.value",
    "portfolio.unrealizedGain",
    "portfolio.totalGain",
    "portfolio.annualReturn",
    "risk.beta",
    "risk.recoveryFactor",
    "risk.sharpe",
    "risk.sortino",
    "risk.maxDrawdown",
    "trades.winRate",
  ]);
  assert.equal(result.cards["risk.recoveryFactor"].value, "9.85");
  assert.equal(result.cards["trades.winRate"].value, "64.1%");
  assert.equal(result.cards["risk.sharpe"].value, "1.00");
  assert.equal(result.cards["risk.sharpe"].note, "Recorded Sharpe ratio");
  assert.equal(result.cards["risk.maxDrawdown"].value, "-27.1%");
  assert.equal(Object.isFrozen(result.cards), true);

  const markedResult = buildStrategySummaryMetricRegistry({
    selected,
    unrealizedGain: 500,
    holdingsMarketValue: 78_000,
    translate: createStrategyTranslator("en"),
  });
  assert.equal(markedResult.portfolioValue, 211_875);
  assert.equal(markedResult.cashValue, 133_875);
  assert.equal(markedResult.cards["portfolio.value"].value, "$211,875");
  assert.equal(
    markedResult.cards["portfolio.totalGain"].value,
    result.cards["portfolio.totalGain"].value,
    "a current quote must not manufacture a new strategy return",
  );
});
