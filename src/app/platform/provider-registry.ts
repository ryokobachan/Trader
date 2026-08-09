import {
  PROVIDER_CAPABILITIES,
  PROVIDER_SCHEMA_VERSION,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderEnvironment,
  type ProviderManifest,
  type ProviderRegistration,
} from "./provider-contracts";

export type ProviderRegistryErrorCode =
  | "invalid_registration"
  | "duplicate_provider"
  | "unknown_provider"
  | "missing_capability"
  | "missing_environment"
  | "provider_initialization_failed";

export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;

  constructor(code: ProviderRegistryErrorCode, message: string) {
    super(message);
    this.name = "ProviderRegistryError";
    this.code = code;
  }
}

const CAPABILITY_SET = new Set<string>(PROVIDER_CAPABILITIES);
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderRegistryError("invalid_registration", `${field} must be a non-empty string.`);
  }
}

function assertManifest(manifest: ProviderManifest): void {
  if (!manifest || typeof manifest !== "object") {
    throw new ProviderRegistryError("invalid_registration", "Provider manifest is required.");
  }
  if (manifest.schemaVersion !== PROVIDER_SCHEMA_VERSION) {
    throw new ProviderRegistryError("invalid_registration", "Unsupported provider schema version.");
  }
  assertNonEmptyString(manifest.id, "manifest.id");
  if (!PROVIDER_ID_PATTERN.test(manifest.id)) {
    throw new ProviderRegistryError("invalid_registration", "manifest.id has an invalid format.");
  }
  assertNonEmptyString(manifest.version, "manifest.version");
  if (!SEMVER_PATTERN.test(manifest.version)) {
    throw new ProviderRegistryError("invalid_registration", "manifest.version must be semantic versioning.");
  }
  assertNonEmptyString(manifest.displayName, "manifest.displayName");
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new ProviderRegistryError("invalid_registration", "At least one provider capability is required.");
  }

  const capabilities = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (!CAPABILITY_SET.has(capability)) {
      throw new ProviderRegistryError("invalid_registration", "Provider declares an unknown capability.");
    }
    if (capabilities.has(capability)) {
      throw new ProviderRegistryError("invalid_registration", "Provider capabilities must be unique.");
    }
    capabilities.add(capability);
  }

  if (!Array.isArray(manifest.markets) || manifest.markets.length === 0 || manifest.markets.some((market) => market !== "US")) {
    throw new ProviderRegistryError("invalid_registration", "Core Skeleton providers must explicitly support the US market.");
  }
  if (!Array.isArray(manifest.assetTypes) || manifest.assetTypes.length === 0) {
    throw new ProviderRegistryError("invalid_registration", "At least one asset type is required.");
  }
  if (manifest.assetTypes.some((assetType) => assetType !== "common_stock" && assetType !== "adr")) {
    throw new ProviderRegistryError("invalid_registration", "Provider declares an unsupported asset type.");
  }
  if (!Array.isArray(manifest.requiredEnv)) {
    throw new ProviderRegistryError("invalid_registration", "manifest.requiredEnv must be an array.");
  }
  const envNames = new Set<string>();
  for (const envName of manifest.requiredEnv) {
    if (!ENV_NAME_PATTERN.test(envName) || envNames.has(envName)) {
      throw new ProviderRegistryError("invalid_registration", "Provider environment names must be unique uppercase identifiers.");
    }
    envNames.add(envName);
  }
}

function assertAdapter(registration: ProviderRegistration, adapter: ProviderAdapter): void {
  if (!adapter || typeof adapter !== "object" || !adapter.manifest) {
    throw new ProviderRegistryError("provider_initialization_failed", "Provider factory returned an invalid adapter.");
  }
  if (
    adapter.manifest.id !== registration.manifest.id
    || adapter.manifest.version !== registration.manifest.version
    || adapter.manifest.schemaVersion !== registration.manifest.schemaVersion
  ) {
    throw new ProviderRegistryError("provider_initialization_failed", "Provider factory returned a different manifest.");
  }

  const capabilities = new Set<ProviderCapability>(adapter.manifest.capabilities);
  if (
    (capabilities.has("instrument.search") || capabilities.has("instrument.identity"))
    && (
      !adapter.instrument
      || typeof adapter.instrument.searchUSStocks !== "function"
      || typeof adapter.instrument.getUSStockBySymbol !== "function"
    )
  ) {
    throw new ProviderRegistryError("provider_initialization_failed", "Instrument capability is missing its implementation.");
  }
  if (capabilities.has("market.quote") && (!adapter.market || typeof adapter.market.getQuote !== "function")) {
    throw new ProviderRegistryError("provider_initialization_failed", "Market capability is missing its implementation.");
  }
  if (capabilities.has("market.bars") && (!adapter.market || typeof adapter.market.getBars !== "function")) {
    throw new ProviderRegistryError("provider_initialization_failed", "Market bars capability is missing its implementation.");
  }
  if (
    capabilities.has("market.synthetic_latest_close")
    && (!adapter.syntheticMarket || typeof adapter.syntheticMarket.getLatestCloses !== "function")
  ) {
    throw new ProviderRegistryError(
      "provider_initialization_failed",
      "Synthetic latest-close capability is missing its implementation.",
    );
  }
  if (
    (capabilities.has("fundamentals.profile")
      || capabilities.has("fundamentals.normalized")
      || capabilities.has("fundamentals.earnings"))
    && (
      !adapter.fundamentals
      || typeof adapter.fundamentals.getProfile !== "function"
      || typeof adapter.fundamentals.getFundamentals !== "function"
      || typeof adapter.fundamentals.getEarnings !== "function"
    )
  ) {
    throw new ProviderRegistryError("provider_initialization_failed", "Fundamentals capability is missing its implementation.");
  }
  if (capabilities.has("analyst.consensus") && (!adapter.analyst || typeof adapter.analyst.getConsensus !== "function")) {
    throw new ProviderRegistryError("provider_initialization_failed", "Analyst capability is missing its implementation.");
  }
  if (capabilities.has("analyst.ratings") && (!adapter.analyst || typeof adapter.analyst.getRatingHistory !== "function")) {
    throw new ProviderRegistryError("provider_initialization_failed", "Analyst ratings capability is missing its implementation.");
  }
  if (capabilities.has("news.company") && (!adapter.news || typeof adapter.news.getCompanyNews !== "function")) {
    throw new ProviderRegistryError("provider_initialization_failed", "News capability is missing its implementation.");
  }
}

export type ProviderRegistry = Readonly<{
  listManifests: () => readonly ProviderManifest[];
  resolve: (
    providerId: string,
    requiredCapabilities: readonly ProviderCapability[],
    env: ProviderEnvironment,
  ) => ProviderAdapter;
}>;

export function defineProviderRegistry(
  registrations: readonly ProviderRegistration[],
): ProviderRegistry {
  const byId = new Map<string, ProviderRegistration>();

  for (const registration of registrations) {
    if (!registration || typeof registration !== "object" || typeof registration.create !== "function") {
      throw new ProviderRegistryError("invalid_registration", "Provider registration requires a factory.");
    }
    assertManifest(registration.manifest);
    if (byId.has(registration.manifest.id)) {
      throw new ProviderRegistryError("duplicate_provider", "Provider IDs must be unique.");
    }
    byId.set(registration.manifest.id, registration);
  }

  return Object.freeze({
    listManifests: () => Object.freeze(Array.from(byId.values(), (registration) => registration.manifest)),
    resolve: (providerId, requiredCapabilities, env) => {
      const registration = byId.get(providerId);
      if (!registration) {
        throw new ProviderRegistryError("unknown_provider", "Configured provider is not installed.");
      }

      const declaredCapabilities = new Set<ProviderCapability>(registration.manifest.capabilities);
      for (const capability of requiredCapabilities) {
        if (!CAPABILITY_SET.has(capability) || !declaredCapabilities.has(capability)) {
          throw new ProviderRegistryError("missing_capability", "Configured provider does not satisfy the required capability.");
        }
      }

      for (const envName of registration.manifest.requiredEnv) {
        if (!env[envName]?.trim()) {
          throw new ProviderRegistryError("missing_environment", "Configured provider is missing a required server credential.");
        }
      }

      let adapter: ProviderAdapter;
      try {
        adapter = registration.create(env);
      } catch {
        throw new ProviderRegistryError("provider_initialization_failed", "Provider initialization failed.");
      }
      assertAdapter(registration, adapter);
      return adapter;
    },
  });
}
