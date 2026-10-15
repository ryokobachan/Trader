import type {
  AnalystProvider,
  FundamentalsProvider,
  InstrumentProvider,
  MarketDataProvider,
  NewsProvider,
  ProviderAdapter,
  ProviderCapability,
  ProviderEnvironment,
} from "@/app/platform/provider-contracts";
import {
  defineProviderRegistry,
  ProviderRegistryError,
} from "@/app/platform/provider-registry";
import { traderConfig } from "@/app/trader.config";
import type { ProviderRole } from "./provider-roles";
import { mockProviderRegistration } from "./mock/index.server";
import { benzingaProviderRegistration } from "./benzinga/analyst.server";
import { fmpProviderRegistration } from "./fmp/index.server";
import { yahooProviderRegistration } from "./yahoo/index.server";
import { tradingViewWebsocketProviderRegistration } from "./tradingview-websocket/index.server";

const providerEntries = Object.freeze([
  { source: "api/mock/index.server.ts", registration: mockProviderRegistration },
  { source: "api/yahoo/index.server.ts", registration: yahooProviderRegistration },
  { source: "api/benzinga/analyst.server.ts", registration: benzingaProviderRegistration },
  { source: "api/fmp/index.server.ts", registration: fmpProviderRegistration },
  {
    source: "api/tradingview-websocket/index.server.ts",
    registration: tradingViewWebsocketProviderRegistration,
  },
]);

const providerRegistry = defineProviderRegistry(
  providerEntries.map(({ registration }) => registration),
);

/** Safe developer-facing map from the JSON provider ID to its source file. */
export function listInstalledProviderSources() {
  return providerEntries.map(({ source, registration }) => Object.freeze({
    id: registration.manifest.id,
    source,
  }));
}

export type ProviderRuntime = Readonly<{
  instrument: InstrumentProvider;
  market: MarketDataProvider;
  fundamentals?: FundamentalsProvider;
  analyst?: AnalystProvider;
  news?: NewsProvider;
  selectedProviderIds: Readonly<{
    instrument: string;
    market: string;
    /** Provider used by the chart bars API; defaults to `market`. */
    bars: string;
    profile?: string;
    fundamentals?: string;
    earnings?: string;
    analyst?: string;
    news?: string;
  }>;
}>;

export type InstrumentProviderRuntime = Readonly<{
  instrument: InstrumentProvider;
  selectedProviderId: string;
}>;

const ROLE_ENV: Readonly<Record<ProviderRole, string>> = {
  instrument: "TRADER_INSTRUMENT_PROVIDER",
  market: "TRADER_MARKET_PROVIDER",
  bars: "TRADER_BARS_PROVIDER",
  profile: "TRADER_PROFILE_PROVIDER",
  fundamentals: "TRADER_FUNDAMENTALS_PROVIDER",
  earnings: "TRADER_EARNINGS_PROVIDER",
  analyst: "TRADER_ANALYST_PROVIDER",
  news: "TRADER_NEWS_PROVIDER",
};

export type ProviderRoleSelection = Readonly<{
  id: string | null;
  origin: `environment ${string}` | "api/config.json" | `fallback from ${ProviderRole}`;
}>;

function directProviderSelection(env: ProviderEnvironment, role: ProviderRole): ProviderRoleSelection {
  const direct = env[ROLE_ENV[role]]?.trim();
  if (direct) return { id: direct, origin: `environment ${ROLE_ENV[role]}` };
  const configuredDefault = traderConfig.providers[role];
  return { id: configuredDefault, origin: "api/config.json" };
}

/** One authoritative provider-precedence calculation for runtime and tooling. */
export function resolveProviderSelections(
  env: ProviderEnvironment,
): Readonly<Record<ProviderRole, ProviderRoleSelection>> {
  const direct = Object.fromEntries(
    (Object.keys(ROLE_ENV) as ProviderRole[]).map((role) => [role, directProviderSelection(env, role)]),
  ) as Record<ProviderRole, ProviderRoleSelection>;

  return Object.freeze({
    ...direct,
    bars: direct.bars.id
      ? direct.bars
      : { id: direct.market.id, origin: "fallback from market" },
    profile: direct.profile.id
      ? direct.profile
      : { id: direct.fundamentals.id, origin: "fallback from fundamentals" },
    earnings: direct.earnings.id
      ? direct.earnings
      : { id: direct.fundamentals.id, origin: "fallback from fundamentals" },
  });
}

export function createProviderRuntime(env: ProviderEnvironment): ProviderRuntime {
  const resolved = new Map<string, ProviderAdapter>();
  const resolve = (id: string, capabilities: readonly ProviderCapability[]) => {
    const cached = resolved.get(id);
    if (cached) {
      const declared = new Set(cached.manifest.capabilities);
      if (capabilities.some((capability) => !declared.has(capability))) {
        throw new ProviderRegistryError("missing_capability", "Configured provider does not satisfy the required capability.");
      }
      return cached;
    }
    const adapter = providerRegistry.resolve(id, capabilities, env);
    resolved.set(id, adapter);
    return adapter;
  };

  const selection = resolveProviderSelections(env);
  const instrumentId = selection.instrument.id;
  const marketId = selection.market.id;
  if (!instrumentId || !marketId) {
    throw new ProviderRegistryError("unknown_provider", "Instrument and market providers are required.");
  }

  const barsId = selection.bars.id ?? marketId;
  const instrumentAdapter = resolve(instrumentId, ["instrument.search", "instrument.identity"]);
  const marketAdapter = resolve(marketId, ["market.quote"]);
  const barsAdapter = resolve(barsId, ["market.bars"]);
  if (!instrumentAdapter.instrument || !marketAdapter.market || !barsAdapter.market?.getBars) {
    throw new ProviderRegistryError("provider_initialization_failed", "Selected market providers are incomplete.");
  }

  const fundamentalsId = selection.fundamentals.id ?? undefined;
  const profileId = selection.profile.id ?? undefined;
  const earningsId = selection.earnings.id ?? undefined;
  const analystId = selection.analyst.id ?? undefined;
  const newsId = selection.news.id ?? undefined;
  const fundamentalsAdapter = fundamentalsId
    ? resolve(fundamentalsId, ["fundamentals.normalized"])
    : undefined;
  const profileAdapter = profileId
    ? resolve(profileId, ["fundamentals.profile"])
    : undefined;
  const earningsAdapter = earningsId
    ? resolve(earningsId, ["fundamentals.earnings"])
    : undefined;
  const analystAdapter = analystId ? resolve(analystId, ["analyst.consensus"]) : undefined;
  const newsAdapter = newsId ? resolve(newsId, ["news.company"]) : undefined;
  const market = Object.freeze({
    getQuote: marketAdapter.market.getQuote.bind(marketAdapter.market),
    ...(marketAdapter.market.getQuotes
      ? { getQuotes: marketAdapter.market.getQuotes.bind(marketAdapter.market) }
      : {}),
    ...(marketAdapter.market.getQuoteStream
      ? { getQuoteStream: marketAdapter.market.getQuoteStream.bind(marketAdapter.market) }
      : {}),
    getBars: barsAdapter.market.getBars.bind(barsAdapter.market),
  });

  if (fundamentalsId && !fundamentalsAdapter?.fundamentals) {
    throw new ProviderRegistryError("provider_initialization_failed", "Selected fundamentals provider is incomplete.");
  }
  if (profileId && !profileAdapter?.fundamentals) {
    throw new ProviderRegistryError("provider_initialization_failed", "Selected profile provider is incomplete.");
  }
  if (earningsId && !earningsAdapter?.fundamentals) {
    throw new ProviderRegistryError("provider_initialization_failed", "Selected earnings provider is incomplete.");
  }
  if (analystId && !analystAdapter?.analyst) {
    throw new ProviderRegistryError("provider_initialization_failed", "Selected analyst provider is incomplete.");
  }
  if (newsId && !newsAdapter?.news) {
    throw new ProviderRegistryError("provider_initialization_failed", "Selected news provider is incomplete.");
  }

  const fundamentals = fundamentalsAdapter?.fundamentals;
  const profile = profileAdapter?.fundamentals;
  const earnings = earningsAdapter?.fundamentals;
  const composedFundamentals = fundamentals || profile || earnings
    ? Object.freeze({
        getProfile: profile
          ? profile.getProfile.bind(profile)
          : () => Promise.resolve(null),
        getFundamentals: fundamentals
          ? fundamentals.getFundamentals.bind(fundamentals)
          : () => Promise.resolve(null),
        getEarnings: earnings
          ? earnings.getEarnings.bind(earnings)
          : () => Promise.resolve([]),
      })
    : undefined;

  return Object.freeze({
    instrument: instrumentAdapter.instrument,
    market,
    fundamentals: composedFundamentals,
    analyst: analystAdapter?.analyst,
    news: newsAdapter?.news,
    selectedProviderIds: Object.freeze({
      instrument: instrumentId,
      market: marketId,
      bars: barsId,
      profile: profileId,
      fundamentals: fundamentalsId,
      earnings: earningsId,
      analyst: analystId,
      news: newsId,
    }),
  });
}

/** Resolve identity without initializing an unrelated market adapter. */
export function createInstrumentProviderRuntime(
  env: ProviderEnvironment,
): InstrumentProviderRuntime {
  const selection = resolveProviderSelections(env);
  const instrumentId = selection.instrument.id;
  if (!instrumentId) {
    throw new ProviderRegistryError("unknown_provider", "Instrument provider is required.");
  }
  const adapter = providerRegistry.resolve(
    instrumentId,
    ["instrument.search", "instrument.identity"],
    env,
  );
  if (!adapter.instrument) {
    throw new ProviderRegistryError(
      "provider_initialization_failed",
      "Selected instrument provider is incomplete.",
    );
  }
  return Object.freeze({
    instrument: adapter.instrument,
    selectedProviderId: instrumentId,
  });
}

export function listInstalledProviderManifests() {
  return providerRegistry.listManifests();
}
