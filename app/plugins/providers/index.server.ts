import type {
  AnalystProvider,
  FundamentalsProvider,
  InstrumentProvider,
  MarketDataProvider,
  NewsProvider,
  ProviderAdapter,
  ProviderCapability,
  ProviderEnvironment,
} from "../../platform/provider-contracts";
import {
  defineProviderRegistry,
  ProviderRegistryError,
} from "../../platform/provider-registry";
import { unicornConfig } from "../../unicorn.config";
import { mockProviderRegistration } from "./mock.server";
import { benzingaProviderRegistration } from "./benzinga.server";
import { fmpProviderRegistration } from "./fmp.server";
import { yahooProviderRegistration } from "./yahoo.server";
import { tradingViewWebsocketProviderRegistration } from "./tradingview-websocket.server";

const providerRegistry = defineProviderRegistry([
  mockProviderRegistration,
  yahooProviderRegistration,
  benzingaProviderRegistration,
  fmpProviderRegistration,
  tradingViewWebsocketProviderRegistration,
]);

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

type ProviderRole = "instrument" | "market" | "bars" | "profile" | "fundamentals" | "earnings" | "analyst" | "news";

const ROLE_ENV: Readonly<Record<ProviderRole, string>> = {
  instrument: "UNICORN_INSTRUMENT_PROVIDER",
  market: "UNICORN_MARKET_PROVIDER",
  bars: "UNICORN_BARS_PROVIDER",
  profile: "UNICORN_PROFILE_PROVIDER",
  fundamentals: "UNICORN_FUNDAMENTALS_PROVIDER",
  earnings: "UNICORN_EARNINGS_PROVIDER",
  analyst: "UNICORN_ANALYST_PROVIDER",
  news: "UNICORN_NEWS_PROVIDER",
};

function configuredProviderId(env: ProviderEnvironment, role: ProviderRole): string | undefined {
  const direct = env[ROLE_ENV[role]]?.trim();
  if (direct) return direct;
  if (role === "fundamentals") {
    const legacyList = env.UNICORN_FUNDAMENTALS_PROVIDERS?.split(",")[0]?.trim();
    if (legacyList && legacyList !== "none") return legacyList;
  }
  if (role === "bars" || role === "profile" || role === "earnings") return undefined;
  const configuredDefault = unicornConfig.providers[role];
  return configuredDefault ?? undefined;
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

  const instrumentId = configuredProviderId(env, "instrument");
  const marketId = configuredProviderId(env, "market");
  if (!instrumentId || !marketId) {
    throw new ProviderRegistryError("unknown_provider", "Instrument and market providers are required.");
  }

  const barsId = configuredProviderId(env, "bars") ?? marketId;
  const instrumentAdapter = resolve(instrumentId, ["instrument.search", "instrument.identity"]);
  const marketAdapter = resolve(marketId, ["market.quote"]);
  const barsAdapter = resolve(barsId, ["market.bars"]);
  if (!instrumentAdapter.instrument || !marketAdapter.market || !barsAdapter.market?.getBars) {
    throw new ProviderRegistryError("provider_initialization_failed", "Selected market providers are incomplete.");
  }

  const fundamentalsId = configuredProviderId(env, "fundamentals");
  const profileId = configuredProviderId(env, "profile") ?? fundamentalsId;
  const earningsId = configuredProviderId(env, "earnings") ?? fundamentalsId;
  const analystId = configuredProviderId(env, "analyst");
  const newsId = configuredProviderId(env, "news");
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
  const composedFundamentals = fundamentals && profile && earnings
    ? Object.freeze({
        getProfile: profile.getProfile.bind(profile),
        getFundamentals: fundamentals.getFundamentals.bind(fundamentals),
        getEarnings: earnings.getEarnings.bind(earnings),
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

export function listInstalledProviderManifests() {
  return providerRegistry.listManifests();
}
