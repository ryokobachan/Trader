import assert from "node:assert/strict";
import test from "node:test";

import { CORE_SYMBOL_SUMMARY_MODULES } from "../src/app/features/symbol-summary/core-modules";
import {
  DEFAULT_SYMBOL_SUMMARY_MODULES,
  EXAMPLE_MARKET_CONTEXT_MODULE,
  UNICORN_UI_MODULE_REGISTRY,
} from "../extensions";
import type { SymbolSummaryModuleProps } from "../src/app/platform/symbol-summary";
import {
  defineUiModuleRegistry,
  UI_MODULE_SCHEMA_VERSION,
  UiModuleRegistryError,
  type UiModuleManifestV1,
  type UiModuleRegistration,
  type UiModuleRegistryErrorCode,
} from "../src/app/platform/ui-module-registry";

type TestModuleProps = { readonly value?: string };

const TestComponent = () => null;

const BASE_MANIFEST = {
  schemaVersion: UI_MODULE_SCHEMA_VERSION,
  id: "test.summary",
  version: "1.0.0",
  surface: "chart.symbol-summary",
  label: "Test summary",
  description: "Test module",
  requiredCapabilities: ["market.quote"],
  defaultEnabled: true,
  defaultOrder: 10,
  userConfigurable: true,
  supportedDensities: ["compact", "normal"],
} as const satisfies UiModuleManifestV1;

function makeRegistration(
  overrides: Record<string, unknown> = {},
): UiModuleRegistration<TestModuleProps> {
  return {
    manifest: {
      ...BASE_MANIFEST,
      ...overrides,
    } as unknown as UiModuleManifestV1,
    Component: TestComponent,
  };
}

function makeIdentityRegistration(
  overrides: Record<string, unknown> = {},
): UiModuleRegistration<TestModuleProps> {
  return makeRegistration({
    id: "core.identity_quote",
    label: "Identity",
    description: "Fixed identity",
    requiredCapabilities: ["instrument.identity", "market.quote"],
    defaultOrder: 0,
    userConfigurable: false,
    ...overrides,
  });
}

function expectRegistryError(action: () => unknown, code: UiModuleRegistryErrorCode) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof UiModuleRegistryError);
    assert.equal(error.code, code);
    return true;
  });
}

test("registers and resolves valid UI modules", () => {
  const identity = makeIdentityRegistration();
  const summary = makeRegistration();
  const registry = defineUiModuleRegistry([identity, summary]);

  assert.equal(UI_MODULE_SCHEMA_VERSION, "unicorn.ui-module.v1");
  assert.equal(registry.get("test.summary", "1.0.0")?.Component, TestComponent);
  assert.deepEqual(
    registry.list("chart.symbol-summary").map((registration) => registration.manifest.id),
    ["core.identity_quote", "test.summary"],
  );

  const resolved = registry.resolveSurface({
    surface: "chart.symbol-summary",
    availableCapabilities: ["instrument.identity", "market.quote"],
    density: "compact",
  });
  assert.deepEqual(
    resolved.map((registration) => registration.manifest.id),
    ["core.identity_quote", "test.summary"],
  );
  assert.equal(resolved.every((registration) => typeof registration.Component === "function"), true);
});

test("rejects a duplicate module id and version", () => {
  const duplicate = makeRegistration();
  expectRegistryError(
    () => defineUiModuleRegistry([
      makeIdentityRegistration(),
      duplicate,
      { ...duplicate, manifest: { ...duplicate.manifest } },
    ]),
    "DUPLICATE_MODULE",
  );
});

test("rejects an unknown manifest schema", () => {
  expectRegistryError(
    () => defineUiModuleRegistry([
      makeRegistration({ schemaVersion: "unicorn.ui-module.v999" }),
    ]),
    "UNKNOWN_SCHEMA",
  );
});

test("rejects invalid module IDs, semantic versions, and surfaces", () => {
  expectRegistryError(
    () => defineUiModuleRegistry([makeRegistration({ id: "Invalid Module" })]),
    "INVALID_ID",
  );
  expectRegistryError(
    () => defineUiModuleRegistry([makeRegistration({ version: "v1" })]),
    "INVALID_VERSION",
  );
  expectRegistryError(
    () => defineUiModuleRegistry([makeRegistration({ surface: "remote.arbitrary-ui" })]),
    "UNSUPPORTED_SURFACE",
  );
});

test("fails closed when configuration references an unknown module", () => {
  const registry = defineUiModuleRegistry([
    makeIdentityRegistration(),
    makeRegistration(),
  ]);
  expectRegistryError(
    () => registry.resolveSurface({
      surface: "chart.symbol-summary",
      availableCapabilities: ["instrument.identity", "market.quote"],
      modules: ["test.not_installed@1.0.0"],
    }),
    "UNKNOWN_MODULE",
  );
});

test("prevents disabling the fixed identity and requires it on the symbol-summary surface", () => {
  const registry = defineUiModuleRegistry([
    makeIdentityRegistration(),
    makeRegistration(),
  ]);
  expectRegistryError(
    () => registry.resolveSurface({
      surface: "chart.symbol-summary",
      availableCapabilities: ["instrument.identity", "market.quote"],
      modules: [{
        id: "core.identity_quote",
        version: "1.0.0",
        enabled: false,
      }],
    }),
    "FIXED_MODULE_DISABLED",
  );

  const registryWithoutIdentity = defineUiModuleRegistry([makeRegistration()]);
  expectRegistryError(
    () => registryWithoutIdentity.resolveSurface({
      surface: "chart.symbol-summary",
      availableCapabilities: ["market.quote"],
    }),
    "FIXED_IDENTITY_MISSING",
  );
});

test("fails closed when an enabled module capability is unavailable", () => {
  const registry = defineUiModuleRegistry([
    makeIdentityRegistration(),
    makeRegistration({
      id: "test.fundamentals",
      requiredCapabilities: ["fundamentals.normalized"],
    }),
  ]);
  expectRegistryError(
    () => registry.resolveSurface({
      surface: "chart.symbol-summary",
      availableCapabilities: ["instrument.identity", "market.quote"],
    }),
    "MISSING_CAPABILITY",
  );
});

test("rejects a density unsupported by an enabled module", () => {
  const registry = defineUiModuleRegistry([
    makeIdentityRegistration(),
    makeRegistration({ supportedDensities: ["compact"] }),
  ]);
  expectRegistryError(
    () => registry.resolveSurface({
      surface: "chart.symbol-summary",
      availableCapabilities: ["instrument.identity", "market.quote"],
      density: "normal",
    }),
    "UNSUPPORTED_DENSITY",
  );
});

test("preserves configured content order while keeping the fixed identity", () => {
  const first = makeRegistration({ id: "test.first", defaultOrder: 10 });
  const second = makeRegistration({ id: "test.second", defaultOrder: 20 });
  const registry = defineUiModuleRegistry([
    makeIdentityRegistration(),
    first,
    second,
  ]);

  const resolved = registry.resolveSurface({
    surface: "chart.symbol-summary",
    availableCapabilities: ["instrument.identity", "market.quote"],
    modules: ["test.second@1.0.0", "test.first@1.0.0"],
  });

  assert.deepEqual(
    resolved.map((registration) => registration.manifest.id),
    ["core.identity_quote", "test.second", "test.first"],
  );
});

test("does not mutate registration, capability, or configuration inputs", () => {
  const identity = makeIdentityRegistration();
  const first = makeRegistration({ id: "test.first", defaultOrder: 10 });
  const second = makeRegistration({ id: "test.second", defaultOrder: 20 });
  const registrations = [identity, first, second];
  const capabilities = ["instrument.identity", "market.quote"];
  const modules = [
    {
      id: "test.second",
      version: "1.0.0",
      order: 4,
      settings: { tone: "quiet" },
    },
    {
      id: "test.first",
      version: "1.0.0",
      order: 8,
      settings: { tone: "strong" },
    },
  ];
  const registrationOrderBefore = registrations.map((item) => item.manifest.id);
  const capabilitiesBefore = [...capabilities];
  const modulesBefore = structuredClone(modules);

  const registry = defineUiModuleRegistry(registrations);
  registry.resolveSurface({
    surface: "chart.symbol-summary",
    availableCapabilities: capabilities,
    modules,
  });

  assert.deepEqual(registrations.map((item) => item.manifest.id), registrationOrderBefore);
  assert.deepEqual(capabilities, capabilitiesBefore);
  assert.deepEqual(modules, modulesBefore);
  assert.equal(Object.isFrozen(identity.manifest), false);
  assert.equal(Object.isFrozen(modules[0]), false);
});

test("Composition Root registers the disabled example through the same generic Component contract", () => {
  const typedRegistrations: readonly UiModuleRegistration<SymbolSummaryModuleProps>[] = [
    ...CORE_SYMBOL_SUMMARY_MODULES,
    EXAMPLE_MARKET_CONTEXT_MODULE,
  ];
  const catalog = UNICORN_UI_MODULE_REGISTRY.list("chart.symbol-summary");
  const example = catalog.find((registration) => registration.manifest.id === "example.market_context");
  const firstCore = catalog.find((registration) => registration.manifest.id === "core.identity_quote");

  assert.equal(typedRegistrations.length, CORE_SYMBOL_SUMMARY_MODULES.length + 1);
  assert.ok(example);
  assert.ok(firstCore);
  assert.equal(example.manifest.schemaVersion, UI_MODULE_SCHEMA_VERSION);
  assert.equal(example.manifest.defaultEnabled, false);
  assert.equal(example.manifest.userConfigurable, true);
  assert.equal(typeof example.Component, "function");
  assert.equal(typeof firstCore.Component, "function");
  assert.deepEqual(Object.keys(example).sort(), Object.keys(firstCore).sort());
  assert.equal(
    DEFAULT_SYMBOL_SUMMARY_MODULES.some(
      (registration) => registration.manifest.id === "example.market_context",
    ),
    false,
  );
  for (const registration of CORE_SYMBOL_SUMMARY_MODULES) {
    assert.equal(
      catalog.some((candidate) =>
        candidate.manifest.id === registration.manifest.id
        && candidate.manifest.version === registration.manifest.version),
      true,
    );
  }
});
