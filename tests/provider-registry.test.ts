import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_SCHEMA_VERSION,
  type ProviderRegistration,
} from "../src/app/platform/provider-contracts";
import {
  defineProviderRegistry,
  ProviderRegistryError,
  type ProviderRegistryErrorCode,
} from "../src/app/platform/provider-registry";
import { mockProviderRegistration } from "../api/mock/index.server";
import { createProviderRuntime, listInstalledProviderManifests } from "../api/index.server";

function expectRegistryError(
  action: () => unknown,
  code: ProviderRegistryErrorCode,
  forbiddenText: readonly string[] = [],
) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProviderRegistryError);
    assert.equal(error.code, code);
    for (const text of forbiddenText) {
      assert.equal(error.message.includes(text), false);
    }
    return true;
  });
}

const instrumentOnlyManifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "instrument-only",
  version: "1.0.0",
  displayName: "Instrument-only test provider",
  capabilities: ["instrument.search", "instrument.identity"],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: [],
} as const;

const instrumentOnlyRegistration = {
  manifest: instrumentOnlyManifest,
  create: () => ({
    manifest: instrumentOnlyManifest,
    instrument: {
      searchUSStocks: () => Promise.resolve([]),
      getUSStockBySymbol: () => Promise.resolve(null),
    },
  }),
} as const satisfies ProviderRegistration;

test("registers and resolves a valid provider", () => {
  const registry = defineProviderRegistry([mockProviderRegistration]);
  const adapter = registry.resolve(
    "mock",
    ["instrument.search", "instrument.identity", "market.quote"],
    {},
  );

  assert.equal(adapter.manifest.schemaVersion, "trader.provider.v1");
  assert.equal(adapter.manifest.id, "mock");
  assert.ok(adapter.instrument);
  assert.ok(adapter.market);
  assert.deepEqual(registry.listManifests().map((manifest) => manifest.id), ["mock"]);
});

test("composes Market data provider financials, Google Finance earnings and Yahoo profile/research independently", () => {
  const runtime = createProviderRuntime({
    TRADER_INSTRUMENT_PROVIDER: "mock",
    TRADER_MARKET_PROVIDER: "mock",
    TRADER_FUNDAMENTALS_PROVIDER: "tradingview",
    TRADER_PROFILE_PROVIDER: "yahoo",
    TRADER_EARNINGS_PROVIDER: "google-finance-earnings",
    TRADER_RESEARCH_PROVIDER: "yahoo",
    TRADER_USAGE_MODE: "personal",
    TRADER_ENABLE_YAHOO_COMPAT: "true",
  });

  assert.equal(runtime.selectedProviderIds.fundamentals, "tradingview");
  assert.equal(runtime.selectedProviderIds.profile, "yahoo");
  assert.equal(runtime.selectedProviderIds.earnings, "google-finance-earnings");
  assert.equal(runtime.selectedProviderIds.research, "yahoo");
  assert.ok(runtime.fundamentals);
  assert.equal(typeof runtime.fundamentals.getResearch, "function");
});

test("retired FMP is not registered and cannot be re-enabled with a credential", () => {
  assert.equal(listInstalledProviderManifests().some((manifest) => manifest.id === "fmp"), false);
  expectRegistryError(() => createProviderRuntime({
    TRADER_INSTRUMENT_PROVIDER: "mock", TRADER_MARKET_PROVIDER: "mock",
    TRADER_FUNDAMENTALS_PROVIDER: "fmp", FMP_API_KEY: "retired-secret",
  }), "unknown_provider", ["retired-secret"]);
});

test("Market data provider financials do not imply an unsupported dated-earnings role", async () => {
  const runtime = createProviderRuntime({
    TRADER_INSTRUMENT_PROVIDER: "mock", TRADER_MARKET_PROVIDER: "mock",
    TRADER_FUNDAMENTALS_PROVIDER: "tradingview",
  });
  assert.equal(runtime.selectedProviderIds.profile, "tradingview");
  assert.equal(runtime.selectedProviderIds.earnings, undefined);
  const instrument = await runtime.instrument.getUSStockBySymbol("AAPL", { requestId: "test" });
  assert.ok(instrument);
  assert.deepEqual(await runtime.fundamentals!.getEarnings(instrument, { requestId: "test" }), []);
});

test("Market data provider research and dated earnings can be selected independently", () => {
  const runtime = createProviderRuntime({
    TRADER_INSTRUMENT_PROVIDER: "mock", TRADER_MARKET_PROVIDER: "mock",
    TRADER_RESEARCH_PROVIDER: "tradingview", TRADER_EARNINGS_PROVIDER: "tradingview",
  });
  assert.equal(runtime.selectedProviderIds.research, "tradingview");
  assert.equal(runtime.selectedProviderIds.earnings, "tradingview");
});

test("keeps a single configured company-data role available without requiring the other two", () => {
  const common = {
    TRADER_INSTRUMENT_PROVIDER: "mock",
    TRADER_MARKET_PROVIDER: "mock",
    TRADER_USAGE_MODE: "personal",
    TRADER_ENABLE_YAHOO_COMPAT: "true",
  } as const;
  const profileOnly = createProviderRuntime({
    ...common,
    TRADER_PROFILE_PROVIDER: "yahoo",
  });
  assert.equal(profileOnly.selectedProviderIds.profile, "yahoo");
  assert.equal(profileOnly.selectedProviderIds.fundamentals, undefined);
  assert.equal(profileOnly.selectedProviderIds.earnings, undefined);
  assert.ok(profileOnly.fundamentals);

  const earningsOnly = createProviderRuntime({
    ...common,
    TRADER_EARNINGS_PROVIDER: "yahoo",
  });
  assert.equal(earningsOnly.selectedProviderIds.profile, undefined);
  assert.equal(earningsOnly.selectedProviderIds.fundamentals, undefined);
  assert.equal(earningsOnly.selectedProviderIds.earnings, "yahoo");
  assert.ok(earningsOnly.fundamentals);
});

test("rejects duplicate provider IDs", () => {
  expectRegistryError(
    () => defineProviderRegistry([mockProviderRegistration, mockProviderRegistration]),
    "duplicate_provider",
  );
});

test("fails closed for an unknown provider", () => {
  const registry = defineProviderRegistry([mockProviderRegistration]);
  expectRegistryError(
    () => registry.resolve("not-installed", ["instrument.identity"], {}),
    "unknown_provider",
  );
});

test("fails closed when the selected provider lacks a capability", () => {
  const registry = defineProviderRegistry([instrumentOnlyRegistration]);
  expectRegistryError(
    () => registry.resolve("instrument-only", ["market.quote"], {}),
    "missing_capability",
  );
});

test("rejects a missing server credential without exposing its name or another secret", () => {
  const credentialManifest = {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: "credential-provider",
    version: "1.0.0",
    displayName: "Credential test provider",
    capabilities: ["market.quote"],
    markets: ["US"],
    assetTypes: ["common_stock"],
    requiredEnv: ["SECRET_PROVIDER_KEY"],
  } as const;
  const registration = {
    manifest: credentialManifest,
    create: () => ({
      manifest: credentialManifest,
      market: { getQuote: () => Promise.resolve(null) },
    }),
  } as const satisfies ProviderRegistration;
  const registry = defineProviderRegistry([registration]);

  expectRegistryError(
    () => registry.resolve(
      "credential-provider",
      ["market.quote"],
      { UNRELATED_SECRET: "sk-should-never-appear" },
    ),
    "missing_environment",
    ["SECRET_PROVIDER_KEY", "sk-should-never-appear"],
  );
});

test("sanitizes provider initialization failures so credentials cannot escape", () => {
  const secret = "provider-secret-placeholder";
  const credentialManifest = {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: "throwing-provider",
    version: "1.0.0",
    displayName: "Throwing test provider",
    capabilities: ["market.quote"],
    markets: ["US"],
    assetTypes: ["common_stock"],
    requiredEnv: ["SECRET_PROVIDER_KEY"],
  } as const;
  const registration = {
    manifest: credentialManifest,
    create: (env) => {
      throw new Error(env.SECRET_PROVIDER_KEY);
    },
  } as const satisfies ProviderRegistration;
  const registry = defineProviderRegistry([registration]);

  expectRegistryError(
    () => registry.resolve(
      "throwing-provider",
      ["market.quote"],
      { SECRET_PROVIDER_KEY: secret },
    ),
    "provider_initialization_failed",
    ["SECRET_PROVIDER_KEY", secret],
  );
});

test("mock provider searches deterministic US fixtures without fetch", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("The deterministic mock provider must not call fetch.");
  });
  const adapter = defineProviderRegistry([mockProviderRegistration]).resolve(
    "mock",
    ["instrument.search", "instrument.identity", "market.quote"],
    {},
  );
  assert.ok(adapter.instrument);

  const context = { requestId: "provider-test" } as const;
  const first = await adapter.instrument.searchUSStocks({ query: "apple", limit: 10 }, context);
  const second = await adapter.instrument.searchUSStocks({ query: "apple", limit: 10 }, context);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.symbol, "AAPL");
  assert.equal(first[0]?.listingCountry, "US");
  assert.equal(first[0]?.active, true);
  assert.ok(first[0]?.assetType === "common_stock" || first[0]?.assetType === "adr");
  assert.equal(await adapter.instrument.getUSStockBySymbol("AAPL", context), first[0]);
  assert.deepEqual(await adapter.instrument.searchUSStocks({ query: "TSE" }, context), []);
  assert.deepEqual(await adapter.instrument.searchUSStocks({ query: "7203" }, context), []);
  assert.equal(await adapter.instrument.getUSStockBySymbol("7203", context), null);
  assert.equal(fetchMock.mock.callCount(), 0);
});
