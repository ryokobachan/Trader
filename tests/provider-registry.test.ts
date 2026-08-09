import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_SCHEMA_VERSION,
  type ProviderRegistration,
} from "../app/platform/provider-contracts";
import {
  defineProviderRegistry,
  ProviderRegistryError,
  type ProviderRegistryErrorCode,
} from "../app/platform/provider-registry";
import { mockProviderRegistration } from "../app/plugins/providers/mock.server";
import { createProviderRuntime } from "../app/plugins/providers/index.server";

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

  assert.equal(adapter.manifest.schemaVersion, "unicorn.provider.v1");
  assert.equal(adapter.manifest.id, "mock");
  assert.ok(adapter.instrument);
  assert.ok(adapter.market);
  assert.deepEqual(registry.listManifests().map((manifest) => manifest.id), ["mock"]);
});

test("selects profile and earnings providers independently from normalized fundamentals", () => {
  const runtime = createProviderRuntime({
    UNICORN_INSTRUMENT_PROVIDER: "mock",
    UNICORN_MARKET_PROVIDER: "mock",
    UNICORN_FUNDAMENTALS_PROVIDER: "yahoo",
    UNICORN_PROFILE_PROVIDER: "fmp",
    UNICORN_EARNINGS_PROVIDER: "fmp",
    UNICORN_USAGE_MODE: "personal",
    UNICORN_ENABLE_YAHOO_COMPAT: "true",
    FMP_API_KEY: "test-only-key",
  });

  assert.equal(runtime.selectedProviderIds.fundamentals, "yahoo");
  assert.equal(runtime.selectedProviderIds.profile, "fmp");
  assert.equal(runtime.selectedProviderIds.earnings, "fmp");
  assert.ok(runtime.fundamentals);
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
