import {
  PROVIDER_IDS_BY_ROLE,
  PROVIDER_ROLES,
  type ProviderRole,
} from "@api/provider-roles";
import {
  FUNDAMENTAL_GROUP_IDS,
  STOCK_DETAIL_METRIC_IDS,
  SYMBOL_DETAIL_TAB_IDS,
  type AnalystMetricId,
  type FundamentalGroupId,
  type FundamentalMetricId,
  type MarketMetricId,
  type ProfileMetricId,
  type SymbolDetailTabId,
  type TechnicalMetricId,
} from "@api/stock-detail/ids";
import {
  STRATEGY_SUMMARY_METRIC_IDS,
  type StrategySummaryMetricId,
} from "@strategies/metric-ids";

export { PROVIDER_IDS_BY_ROLE, PROVIDER_ROLES, type ProviderRole } from "@api/provider-roles";
export {
  FUNDAMENTAL_GROUP_IDS,
  STOCK_DETAIL_METRIC_IDS,
  SYMBOL_DETAIL_TAB_IDS,
  type AnalystMetricId,
  type FundamentalGroupId,
  type FundamentalMetricId,
  type MarketMetricId,
  type ProfileMetricId,
  type StockDetailMetricId,
  type SymbolDetailTabId,
  type TechnicalMetricId,
} from "@api/stock-detail/ids";
export {
  STRATEGY_SUMMARY_METRIC_IDS,
  type StrategySummaryMetricId,
} from "@strategies/metric-ids";

export const TRADER_CONFIG_SCHEMA_VERSION = "trader.config.v1" as const;

export const UNIVERSE_POLICY_IDS = Object.freeze(["us_equity_v1"] as const);

export type TraderConfig = Readonly<{
  schemaVersion: typeof TRADER_CONFIG_SCHEMA_VERSION;
  universe: Readonly<{ policyId: string }>;
  providers: Readonly<Record<ProviderRole, string | null>>;
  ui: Readonly<{
    symbolSummary: Readonly<{
      density: "compact" | "normal";
      modules: readonly string[];
    }>;
    symbolDetail: Readonly<{
      tabs: readonly SymbolDetailTabId[];
      profileMetrics: readonly ProfileMetricId[];
      fundamentalGroups: readonly Readonly<{
        id: FundamentalGroupId;
        metrics: readonly FundamentalMetricId[];
      }>[];
      marketMetrics: readonly MarketMetricId[];
      analystMetrics: readonly AnalystMetricId[];
      technicalMetrics: readonly TechnicalMetricId[];
    }>;
    strategyDetail: Readonly<{
      summaryMetrics: readonly StrategySummaryMetricId[];
    }>;
  }>;
}>;

export class TraderConfigError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "TraderConfigError";
  }
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MODULE_REFERENCE_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TraderConfigError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TraderConfigError(`${path}.${key}`, "unknown field");
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new TraderConfigError(`${path}.${key}`, "field is required");
  }
}

function text(value: unknown, path: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TraderConfigError(path, "must be a non-empty string");
  }
  return value.trim();
}

function orderedIds<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  allowEmpty = true,
): readonly T[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TraderConfigError(path, allowEmpty ? "must be an array" : "must contain at least one item");
  }
  if (value.length > allowed.length) {
    throw new TraderConfigError(path, `contains too many items (maximum ${allowed.length})`);
  }
  const allowedSet = new Set<string>(allowed);
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    if (typeof item !== "string" || !allowedSet.has(item)) {
      throw new TraderConfigError(`${path}[${index}]`, `unsupported id ${String(item)}`);
    }
    if (seen.has(item)) throw new TraderConfigError(`${path}[${index}]`, `duplicate id ${item}`);
    seen.add(item);
    return item as T;
  }));
}

function modules(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TraderConfigError("ui.symbolSummary.modules", "must contain at least one module");
  }
  if (value.length > 64) throw new TraderConfigError("ui.symbolSummary.modules", "contains too many modules");
  const seen = new Set<string>();
  const parsed = value.map((item, index) => {
    if (typeof item !== "string" || !MODULE_REFERENCE_PATTERN.test(item)) {
      throw new TraderConfigError(`ui.symbolSummary.modules[${index}]`, "must use id@semver");
    }
    if (seen.has(item)) throw new TraderConfigError(`ui.symbolSummary.modules[${index}]`, `duplicate module ${item}`);
    seen.add(item);
    return item;
  });
  if (!parsed.some((item) => item.startsWith("core.identity_quote@"))) {
    throw new TraderConfigError("ui.symbolSummary.modules", "must include core.identity_quote");
  }
  return Object.freeze(parsed);
}

export function defineTraderConfig(value: unknown): TraderConfig {
  const root = record(value, "config");
  exactKeys(root, ["schemaVersion", "universe", "providers", "ui"], "config");
  if (root.schemaVersion !== TRADER_CONFIG_SCHEMA_VERSION) {
    throw new TraderConfigError("schemaVersion", `expected ${TRADER_CONFIG_SCHEMA_VERSION}`);
  }
  const universe = record(root.universe, "universe");
  exactKeys(universe, ["policyId"], "universe");
  const policyId = text(universe.policyId, "universe.policyId");
  if (!UNIVERSE_POLICY_IDS.includes(policyId as (typeof UNIVERSE_POLICY_IDS)[number])) {
    throw new TraderConfigError("universe.policyId", `unsupported id ${policyId}`);
  }
  const rawProviders = record(root.providers, "providers");
  exactKeys(rawProviders, PROVIDER_ROLES, "providers");
  const providers = Object.fromEntries(PROVIDER_ROLES.map((role) => {
    const raw = rawProviders[role];
    if (raw === null) return [role, null];
    const id = text(raw, `providers.${role}`);
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw new TraderConfigError(`providers.${role}`, "must be a lowercase provider id");
    }
    if (!new Set<string>(PROVIDER_IDS_BY_ROLE[role]).has(id)) {
      throw new TraderConfigError(`providers.${role}`, `provider ${id} is not registered for this role`);
    }
    return [role, id];
  })) as Record<ProviderRole, string | null>;
  if (!providers.instrument || !providers.market) {
    throw new TraderConfigError("providers", "instrument and market providers are required");
  }

  const ui = record(root.ui, "ui");
  exactKeys(ui, ["symbolSummary", "symbolDetail", "strategyDetail"], "ui");
  const rawSummary = record(ui.symbolSummary, "ui.symbolSummary");
  exactKeys(rawSummary, ["density", "modules"], "ui.symbolSummary");
  if (rawSummary.density !== "compact" && rawSummary.density !== "normal") {
    throw new TraderConfigError("ui.symbolSummary.density", "must be compact or normal");
  }
  const rawDetail = record(ui.symbolDetail, "ui.symbolDetail");
  exactKeys(rawDetail, ["tabs", "profileMetrics", "fundamentalGroups", "marketMetrics", "analystMetrics", "technicalMetrics"], "ui.symbolDetail");
  const rawGroups = rawDetail.fundamentalGroups;
  if (!Array.isArray(rawGroups)) {
    throw new TraderConfigError("ui.symbolDetail.fundamentalGroups", "must be an array");
  }
  const seenGroups = new Set<string>();
  const seenFundamentals = new Set<string>();
  const fundamentalIds = STOCK_DETAIL_METRIC_IDS.filter((id): id is FundamentalMetricId => id.startsWith("fundamentals."));
  const fundamentalGroups = Object.freeze(rawGroups.map((item, index) => {
    const group = record(item, `ui.symbolDetail.fundamentalGroups[${index}]`);
    exactKeys(group, ["id", "metrics"], `ui.symbolDetail.fundamentalGroups[${index}]`);
    const id = orderedIds([group.id], FUNDAMENTAL_GROUP_IDS, `ui.symbolDetail.fundamentalGroups[${index}].id`, false)[0];
    if (seenGroups.has(id)) throw new TraderConfigError(`ui.symbolDetail.fundamentalGroups[${index}].id`, `duplicate group ${id}`);
    seenGroups.add(id);
    const groupMetrics = orderedIds(group.metrics, fundamentalIds, `ui.symbolDetail.fundamentalGroups[${index}].metrics`);
    for (const metric of groupMetrics) {
      if (seenFundamentals.has(metric)) {
        throw new TraderConfigError(`ui.symbolDetail.fundamentalGroups[${index}].metrics`, `metric ${metric} is already assigned`);
      }
      seenFundamentals.add(metric);
    }
    return Object.freeze({ id, metrics: groupMetrics });
  }));

  const profileIds = STOCK_DETAIL_METRIC_IDS.filter((id): id is ProfileMetricId => id.startsWith("profile."));
  const marketIds = STOCK_DETAIL_METRIC_IDS.filter((id): id is MarketMetricId => id.startsWith("market."));
  const analystIds = STOCK_DETAIL_METRIC_IDS.filter((id): id is AnalystMetricId => id.startsWith("analyst."));
  const technicalIds = STOCK_DETAIL_METRIC_IDS.filter((id): id is TechnicalMetricId => id.startsWith("technical."));

  const rawStrategyDetail = record(ui.strategyDetail, "ui.strategyDetail");
  exactKeys(rawStrategyDetail, ["summaryMetrics"], "ui.strategyDetail");

  return Object.freeze({
    schemaVersion: TRADER_CONFIG_SCHEMA_VERSION,
    universe: Object.freeze({ policyId }),
    providers: Object.freeze(providers),
    ui: Object.freeze({
      symbolSummary: Object.freeze({
        density: rawSummary.density,
        modules: modules(rawSummary.modules),
      }),
      symbolDetail: Object.freeze({
        tabs: orderedIds(rawDetail.tabs, SYMBOL_DETAIL_TAB_IDS, "ui.symbolDetail.tabs", false),
        profileMetrics: orderedIds(rawDetail.profileMetrics, profileIds, "ui.symbolDetail.profileMetrics"),
        fundamentalGroups,
        marketMetrics: orderedIds(rawDetail.marketMetrics, marketIds, "ui.symbolDetail.marketMetrics"),
        analystMetrics: orderedIds(rawDetail.analystMetrics, analystIds, "ui.symbolDetail.analystMetrics"),
        technicalMetrics: orderedIds(rawDetail.technicalMetrics, technicalIds, "ui.symbolDetail.technicalMetrics"),
      }),
      strategyDetail: Object.freeze({
        summaryMetrics: orderedIds(
          rawStrategyDetail.summaryMetrics,
          STRATEGY_SUMMARY_METRIC_IDS,
          "ui.strategyDetail.summaryMetrics",
          false,
        ),
      }),
    }),
  });
}
