import type { ComponentType } from "react";

export const UI_MODULE_SCHEMA_VERSION = "unicorn.ui-module.v1" as const;

export const UI_MODULE_SURFACES = [
  "chart.symbol-summary",
  "symbol.detail",
  "strategy.table-column",
] as const;

export const UI_MODULE_DENSITIES = ["compact", "normal"] as const;

export type UiModuleSurface = (typeof UI_MODULE_SURFACES)[number];
export type UiModuleDensity = (typeof UI_MODULE_DENSITIES)[number];

export type UiModuleManifestV1 = {
  schemaVersion: typeof UI_MODULE_SCHEMA_VERSION;
  id: `${string}.${string}`;
  version: string;
  surface: UiModuleSurface;
  label: string;
  description: string;
  requiredCapabilities: readonly string[];
  defaultEnabled: boolean;
  defaultOrder: number;
  userConfigurable: boolean;
  supportedDensities?: readonly UiModuleDensity[];
};

export type UiModuleRegistration<TProps extends object> = {
  manifest: UiModuleManifestV1;
  Component: ComponentType<TProps>;
};

export type UiModuleConfigEntry =
  | string
  | {
      id: string;
      version: string;
      enabled?: boolean;
      order?: number;
      settings?: Readonly<Record<string, unknown>>;
    };

export type ResolveUiModuleOptions = {
  surface: UiModuleSurface;
  availableCapabilities: readonly string[];
  density?: UiModuleDensity;
  modules?: readonly UiModuleConfigEntry[];
};

export type ResolvedUiModule<TProps extends object> = UiModuleRegistration<TProps> & {
  order: number;
  settings: Readonly<Record<string, unknown>>;
};

export type UiModuleRegistry<TProps extends object> = {
  list(surface?: UiModuleSurface): readonly UiModuleRegistration<TProps>[];
  get(id: string, version: string): UiModuleRegistration<TProps> | undefined;
  resolveSurface(options: ResolveUiModuleOptions): readonly ResolvedUiModule<TProps>[];
};

export type UiModuleRegistryErrorCode =
  | "INVALID_REGISTRATION"
  | "UNKNOWN_SCHEMA"
  | "INVALID_ID"
  | "INVALID_VERSION"
  | "UNSUPPORTED_SURFACE"
  | "INVALID_MANIFEST"
  | "DUPLICATE_MODULE"
  | "UNKNOWN_MODULE"
  | "CONFIG_SURFACE_MISMATCH"
  | "DUPLICATE_CONFIG"
  | "FIXED_MODULE_DISABLED"
  | "FIXED_IDENTITY_MISSING"
  | "MISSING_CAPABILITY"
  | "UNSUPPORTED_DENSITY";

export class UiModuleRegistryError extends Error {
  readonly code: UiModuleRegistryErrorCode;

  constructor(code: UiModuleRegistryErrorCode, message: string) {
    super(message);
    this.name = "UiModuleRegistryError";
    this.code = code;
  }
}

const MODULE_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FIXED_IDENTITY_MODULE_ID = "core.identity_quote";
const EMPTY_SETTINGS = Object.freeze({}) as Readonly<Record<string, unknown>>;

function moduleKey(id: string, version: string) {
  return `${id}@${version}`;
}

function assertNonEmptyText(value: unknown, field: string, key: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UiModuleRegistryError("INVALID_MANIFEST", `${key}: ${field} must be a non-empty string`);
  }
}

function validateManifest(manifest: UiModuleManifestV1) {
  if (!manifest || typeof manifest !== "object") {
    throw new UiModuleRegistryError("INVALID_MANIFEST", "UI module manifest must be an object");
  }
  if (manifest.schemaVersion !== UI_MODULE_SCHEMA_VERSION) {
    throw new UiModuleRegistryError(
      "UNKNOWN_SCHEMA",
      `Unsupported UI module schema: ${String(manifest.schemaVersion)}`,
    );
  }
  if (typeof manifest.id !== "string" || !MODULE_ID_PATTERN.test(manifest.id)) {
    throw new UiModuleRegistryError("INVALID_ID", `Invalid UI module id: ${String(manifest.id)}`);
  }
  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    throw new UiModuleRegistryError(
      "INVALID_VERSION",
      `${manifest.id}: version must be valid semantic versioning`,
    );
  }
  const key = moduleKey(manifest.id, manifest.version);
  if (!UI_MODULE_SURFACES.includes(manifest.surface)) {
    throw new UiModuleRegistryError(
      "UNSUPPORTED_SURFACE",
      `${key}: unsupported surface ${String(manifest.surface)}`,
    );
  }
  assertNonEmptyText(manifest.label, "label", key);
  assertNonEmptyText(manifest.description, "description", key);
  if (!Array.isArray(manifest.requiredCapabilities)) {
    throw new UiModuleRegistryError("INVALID_MANIFEST", `${key}: requiredCapabilities must be an array`);
  }
  const seenCapabilities = new Set<string>();
  for (const capability of manifest.requiredCapabilities) {
    if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
      throw new UiModuleRegistryError(
        "INVALID_MANIFEST",
        `${key}: invalid capability ${String(capability)}`,
      );
    }
    if (seenCapabilities.has(capability)) {
      throw new UiModuleRegistryError(
        "INVALID_MANIFEST",
        `${key}: duplicate capability ${capability}`,
      );
    }
    seenCapabilities.add(capability);
  }
  if (typeof manifest.defaultEnabled !== "boolean" || typeof manifest.userConfigurable !== "boolean") {
    throw new UiModuleRegistryError(
      "INVALID_MANIFEST",
      `${key}: defaultEnabled and userConfigurable must be boolean`,
    );
  }
  if (!Number.isSafeInteger(manifest.defaultOrder) || manifest.defaultOrder < 0) {
    throw new UiModuleRegistryError(
      "INVALID_MANIFEST",
      `${key}: defaultOrder must be a non-negative safe integer`,
    );
  }
  if (manifest.supportedDensities !== undefined) {
    if (!Array.isArray(manifest.supportedDensities) || manifest.supportedDensities.length === 0) {
      throw new UiModuleRegistryError(
        "INVALID_MANIFEST",
        `${key}: supportedDensities must contain at least one density`,
      );
    }
    const densities = new Set<UiModuleDensity>();
    for (const density of manifest.supportedDensities) {
      if (!UI_MODULE_DENSITIES.includes(density)) {
        throw new UiModuleRegistryError(
          "INVALID_MANIFEST",
          `${key}: unsupported density ${String(density)}`,
        );
      }
      if (densities.has(density)) {
        throw new UiModuleRegistryError(
          "INVALID_MANIFEST",
          `${key}: duplicate density ${density}`,
        );
      }
      densities.add(density);
    }
  }
  if (!manifest.userConfigurable && !manifest.defaultEnabled) {
    throw new UiModuleRegistryError(
      "INVALID_MANIFEST",
      `${key}: a fixed module must be enabled by default`,
    );
  }
  if (manifest.id === FIXED_IDENTITY_MODULE_ID) {
    if (
      manifest.surface !== "chart.symbol-summary"
      || manifest.userConfigurable
      || !manifest.defaultEnabled
    ) {
      throw new UiModuleRegistryError(
        "INVALID_MANIFEST",
        `${key}: the symbol identity module is fixed, enabled, and limited to chart.symbol-summary`,
      );
    }
  }
}

function parseConfigEntry(entry: UiModuleConfigEntry, index: number) {
  if (typeof entry === "string") {
    const separator = entry.lastIndexOf("@");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new UiModuleRegistryError(
        "INVALID_VERSION",
        `UI module config entry must use id@version: ${entry}`,
      );
    }
    const id = entry.slice(0, separator);
    const version = entry.slice(separator + 1);
    if (!MODULE_ID_PATTERN.test(id)) {
      throw new UiModuleRegistryError("INVALID_ID", `Invalid UI module config id: ${id}`);
    }
    if (!SEMVER_PATTERN.test(version)) {
      throw new UiModuleRegistryError(
        "INVALID_VERSION",
        `${id}: configured version must be valid semantic versioning`,
      );
    }
    return {
      id,
      version,
      enabled: true,
      order: index,
      settings: EMPTY_SETTINGS,
    };
  }
  if (!entry || typeof entry !== "object") {
    throw new UiModuleRegistryError("INVALID_MANIFEST", "UI module config entry must be an object");
  }
  if (!MODULE_ID_PATTERN.test(entry.id)) {
    throw new UiModuleRegistryError("INVALID_ID", `Invalid UI module config id: ${String(entry.id)}`);
  }
  if (!SEMVER_PATTERN.test(entry.version)) {
    throw new UiModuleRegistryError(
      "INVALID_VERSION",
      `${entry.id}: configured version must be valid semantic versioning`,
    );
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
    throw new UiModuleRegistryError(
      "INVALID_MANIFEST",
      `${moduleKey(entry.id, entry.version)}: enabled must be boolean`,
    );
  }
  if (entry.order !== undefined && (!Number.isSafeInteger(entry.order) || entry.order < 0)) {
    throw new UiModuleRegistryError(
      "INVALID_MANIFEST",
      `${moduleKey(entry.id, entry.version)}: order must be a non-negative safe integer`,
    );
  }
  if (entry.settings !== undefined && (!entry.settings || typeof entry.settings !== "object" || Array.isArray(entry.settings))) {
    throw new UiModuleRegistryError(
      "INVALID_MANIFEST",
      `${moduleKey(entry.id, entry.version)}: settings must be an object`,
    );
  }
  return {
    id: entry.id,
    version: entry.version,
    enabled: entry.enabled ?? true,
    order: entry.order ?? index,
    settings: entry.settings ?? EMPTY_SETTINGS,
  };
}

export function defineUiModuleRegistry<TProps extends object>(
  registrations: readonly UiModuleRegistration<TProps>[],
): UiModuleRegistry<TProps> {
  if (!Array.isArray(registrations)) {
    throw new UiModuleRegistryError("INVALID_REGISTRATION", "UI module registrations must be an array");
  }

  const registry = new Map<string, UiModuleRegistration<TProps>>();
  const activeVersionById = new Map<string, string>();
  const safeRegistrations = registrations.map((registration) => {
    if (!registration || typeof registration !== "object" || typeof registration.Component !== "function") {
      throw new UiModuleRegistryError(
        "INVALID_REGISTRATION",
        "Every UI module registration requires a manifest and a React component",
      );
    }
    validateManifest(registration.manifest);
    const key = moduleKey(registration.manifest.id, registration.manifest.version);
    if (registry.has(key) || activeVersionById.has(registration.manifest.id)) {
      const activeVersion = activeVersionById.get(registration.manifest.id);
      throw new UiModuleRegistryError(
        "DUPLICATE_MODULE",
        `Duplicate UI module ${registration.manifest.id}; active version is ${activeVersion ?? registration.manifest.version}`,
      );
    }
    const safeRegistration = Object.freeze({
      manifest: Object.freeze({
        ...registration.manifest,
        requiredCapabilities: Object.freeze([...registration.manifest.requiredCapabilities]),
        supportedDensities: Object.freeze([
          ...(registration.manifest.supportedDensities ?? UI_MODULE_DENSITIES),
        ]),
      }),
      Component: registration.Component,
    }) as UiModuleRegistration<TProps>;
    registry.set(key, safeRegistration);
    activeVersionById.set(registration.manifest.id, registration.manifest.version);
    return safeRegistration;
  });

  const immutableRegistrations = Object.freeze([...safeRegistrations]);

  const list = (surface?: UiModuleSurface) => Object.freeze(
    immutableRegistrations.filter((registration) => !surface || registration.manifest.surface === surface),
  );

  const get = (id: string, version: string) => registry.get(moduleKey(id, version));

  const resolveSurface = (options: ResolveUiModuleOptions) => {
    if (!UI_MODULE_SURFACES.includes(options.surface)) {
      throw new UiModuleRegistryError(
        "UNSUPPORTED_SURFACE",
        `Unsupported UI surface: ${String(options.surface)}`,
      );
    }
    const density = options.density ?? "compact";
    if (!UI_MODULE_DENSITIES.includes(density)) {
      throw new UiModuleRegistryError(
        "UNSUPPORTED_DENSITY",
        `Unsupported UI density: ${String(density)}`,
      );
    }
    const surfaceRegistrations = immutableRegistrations.filter(
      (registration) => registration.manifest.surface === options.surface,
    );
    if (
      options.surface === "chart.symbol-summary"
      && !surfaceRegistrations.some((registration) => registration.manifest.id === FIXED_IDENTITY_MODULE_ID)
    ) {
      throw new UiModuleRegistryError(
        "FIXED_IDENTITY_MISSING",
        `${FIXED_IDENTITY_MODULE_ID} must be registered for chart.symbol-summary`,
      );
    }

    const configured = options.modules?.map(parseConfigEntry);
    const selected = new Map<
      string,
      { registration: UiModuleRegistration<TProps>; order: number; settings: Readonly<Record<string, unknown>> }
    >();

    if (configured) {
      const seenConfig = new Set<string>();
      for (const entry of configured) {
        const key = moduleKey(entry.id, entry.version);
        if (seenConfig.has(key)) {
          throw new UiModuleRegistryError("DUPLICATE_CONFIG", `Duplicate UI module config: ${key}`);
        }
        seenConfig.add(key);
        const registration = registry.get(key);
        if (!registration) {
          throw new UiModuleRegistryError("UNKNOWN_MODULE", `Unknown UI module in config: ${key}`);
        }
        if (registration.manifest.surface !== options.surface) {
          throw new UiModuleRegistryError(
            "CONFIG_SURFACE_MISMATCH",
            `${key} belongs to ${registration.manifest.surface}, not ${options.surface}`,
          );
        }
        if (!registration.manifest.userConfigurable && !entry.enabled) {
          throw new UiModuleRegistryError("FIXED_MODULE_DISABLED", `${key} cannot be disabled`);
        }
        if (entry.enabled) {
          selected.set(key, { registration, order: entry.order, settings: Object.freeze({ ...entry.settings }) });
        }
      }
      for (const registration of surfaceRegistrations) {
        if (!registration.manifest.userConfigurable) {
          const key = moduleKey(registration.manifest.id, registration.manifest.version);
          if (!selected.has(key)) {
            selected.set(key, {
              registration,
              order: registration.manifest.defaultOrder,
              settings: EMPTY_SETTINGS,
            });
          }
        }
      }
    } else {
      for (const registration of surfaceRegistrations) {
        if (registration.manifest.defaultEnabled) {
          selected.set(moduleKey(registration.manifest.id, registration.manifest.version), {
            registration,
            order: registration.manifest.defaultOrder,
            settings: EMPTY_SETTINGS,
          });
        }
      }
    }

    const capabilities = new Set(options.availableCapabilities);
    const resolved = [...selected.values()].map(({ registration, order, settings }) => {
      const missingCapabilities = registration.manifest.requiredCapabilities.filter(
        (capability) => !capabilities.has(capability),
      );
      if (missingCapabilities.length > 0) {
        throw new UiModuleRegistryError(
          "MISSING_CAPABILITY",
          `${moduleKey(registration.manifest.id, registration.manifest.version)} requires: ${missingCapabilities.join(", ")}`,
        );
      }
      const supportedDensities = registration.manifest.supportedDensities ?? UI_MODULE_DENSITIES;
      if (!supportedDensities.includes(density)) {
        throw new UiModuleRegistryError(
          "UNSUPPORTED_DENSITY",
          `${moduleKey(registration.manifest.id, registration.manifest.version)} does not support ${density}`,
        );
      }
      return Object.freeze({ ...registration, order, settings });
    });

    resolved.sort((left, right) =>
      left.order - right.order
      || left.manifest.defaultOrder - right.manifest.defaultOrder
      || left.manifest.id.localeCompare(right.manifest.id));
    return Object.freeze(resolved);
  };

  return Object.freeze({ list, get, resolveSurface });
}

export function uiModuleKey(manifest: Pick<UiModuleManifestV1, "id" | "version">) {
  return moduleKey(manifest.id, manifest.version);
}
