import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { unicornConfig } from "../src/app/unicorn.config";
import {
  defineUnicornConfig,
  PROVIDER_IDS_BY_ROLE,
  UnicornConfigError,
} from "../src/app/platform/unicorn-config";
import type { ProviderCapability } from "../src/app/platform/provider-contracts";
import { PROVIDER_ENVIRONMENT_KEYS } from "../api/environment";
import {
  listInstalledProviderManifests,
  resolveProviderSelections,
} from "../api/index.server";
import { sampleStrategiesForLocale } from "../strategies/catalog";
import { createStrategyTranslator } from "../strategies/i18n";
import { buildStrategySummaryMetricRegistry } from "../strategies/metrics";

function editableConfig() {
  return structuredClone(unicornConfig);
}

function expectConfigError(mutator: (value: ReturnType<typeof editableConfig>) => void, path: string) {
  const value = editableConfig();
  mutator(value);
  assert.throws(
    () => defineUnicornConfig(value),
    (error: unknown) => {
      assert.ok(error instanceof UnicornConfigError);
      assert.equal(error.path, path);
      return true;
    },
  );
}

test("loads one validated non-secret master configuration", () => {
  assert.equal(unicornConfig.schemaVersion, "unicorn.config.v1");
  assert.equal(unicornConfig.providers.instrument, "mock");
  assert.equal(unicornConfig.providers.market, "mock");
  assert.equal(unicornConfig.ui.symbolSummary.modules[0], "core.identity_quote@1.0.0");
  assert.deepEqual(unicornConfig.ui.symbolDetail.tabs, ["financials", "analyst", "technicals"]);
  assert.deepEqual(unicornConfig.ui.strategyDetail.summaryMetrics, [
    "portfolio.value",
    "portfolio.unrealizedGain",
    "portfolio.totalGain",
    "portfolio.annualReturn",
    "risk.beta",
    "risk.sharpe",
    "risk.sortino",
    "risk.maxDrawdown",
  ]);
  assert.equal(Object.isFrozen(unicornConfig), true);
  assert.equal(Object.isFrozen(unicornConfig.ui.symbolDetail.tabs), true);
});

test("rejects unknown fields, unknown IDs, duplicates, and a missing fixed identity", () => {
  expectConfigError((value) => {
    Object.assign(value.ui.symbolDetail, { remoteComponentUrl: "https://example.invalid/plugin.js" });
  }, "ui.symbolDetail.remoteComponentUrl");
  expectConfigError((value) => {
    Object.assign(value.ui.symbolDetail.tabs, { 0: "overview" });
  }, "ui.symbolDetail.tabs[0]");
  expectConfigError((value) => {
    Object.assign(value.ui.symbolDetail.technicalMetrics, { 1: value.ui.symbolDetail.technicalMetrics[0] });
  }, "ui.symbolDetail.technicalMetrics[1]");
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
});

test("the UI consumes master arrays instead of duplicating display order", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const providerSource = await readFile(new URL("../api/index.server.ts", import.meta.url), "utf8");
  assert.match(pageSource, /unicornConfig\.ui\.symbolDetail\.tabs/);
  assert.match(pageSource, /unicornConfig\.ui\.symbolDetail\.fundamentalGroups/);
  assert.match(pageSource, /unicornConfig\.ui\.strategyDetail\.summaryMetrics/);
  assert.match(providerSource, /unicornConfig\.providers\[role\]/);
});

test("the public provider allow-list matches installed manifests and role capabilities", () => {
  const required: Readonly<Record<keyof typeof PROVIDER_IDS_BY_ROLE, readonly ProviderCapability[]>> = {
    instrument: ["instrument.search", "instrument.identity"],
    market: ["market.quote"],
    bars: ["market.bars"],
    profile: ["fundamentals.profile"],
    fundamentals: ["fundamentals.normalized"],
    earnings: ["fundamentals.earnings"],
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

test("runtime and config tooling share environment precedence and role fallbacks", () => {
  const selection = resolveProviderSelections({
    UNICORN_INSTRUMENT_PROVIDER: "yahoo",
    UNICORN_MARKET_PROVIDER: "yahoo",
    UNICORN_FUNDAMENTALS_PROVIDER: "fmp",
  });
  assert.deepEqual(selection.instrument, {
    id: "yahoo",
    origin: "environment UNICORN_INSTRUMENT_PROVIDER",
  });
  assert.deepEqual(selection.bars, { id: "yahoo", origin: "fallback from market" });
  assert.deepEqual(selection.profile, { id: "fmp", origin: "fallback from fundamentals" });
  assert.deepEqual(selection.earnings, { id: "fmp", origin: "fallback from fundamentals" });
  assert.equal(selection.analyst.id, null);
});

test("strategy summary formulas stay in a typed registry selected by the JSON", () => {
  const selected = sampleStrategiesForLocale("en")[0];
  const result = buildStrategySummaryMetricRegistry({
    selected,
    selectedCatalogIndex: 0,
    unrealizedGain: 1200,
    translate: createStrategyTranslator("en"),
  });
  assert.deepEqual(Object.keys(result.cards), [
    "portfolio.value",
    "portfolio.unrealizedGain",
    "portfolio.totalGain",
    "portfolio.annualReturn",
    "risk.beta",
    "risk.sharpe",
    "risk.sortino",
    "risk.maxDrawdown",
  ]);
  assert.equal(result.cards["risk.sharpe"].value, selected.sharpe?.toFixed(2));
  assert.equal(result.cards["risk.maxDrawdown"].value, `${selected.maxDrawdown.toFixed(1)}%`);
  assert.equal(Object.isFrozen(result.cards), true);
});
