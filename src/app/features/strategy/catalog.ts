import type { Locale } from "@/app/platform/i18n";
import type { StrategyPreference } from "@/app/platform/strategy-preference-contracts";
import type { StrategyPerformance } from "@/app/platform/strategy-contracts";
import { GENERATED_STRATEGY_PACKAGES } from "@/app/generated/strategy-packages.generated";

export type StrategyPackageCatalogRecord = Readonly<{
  id: string;
  family: "portfolio2" | "rule" | "research";
  status: "pinned" | "research";
  candidateAt: string;
  name: string;
  category: string;
  sourceLabels: string[];
  headline: string;
  audit: {
    overfit: number | null;
    leakage: number | null;
    verdict: string;
  };
  performance: StrategyPerformance;
}>;

/** Flattened package view consumed by the strategy screen. */
export type StrategyPackageRecord = StrategyPackageCatalogRecord & Readonly<{
  netReturn: number | null;
  maxDrawdown: number | null;
  recoveryFactor: number | null;
  sharpe: number | null;
  forwardReturn: number | null;
  winRate: number | null;
  trades: number | null;
  symbols: number | null;
  cash: number | null;
}>;

export const STRATEGY_PACKAGE_DEFINITIONS = GENERATED_STRATEGY_PACKAGES;

/** Old IDs remain reserved so existing owner transaction ledgers stay addressable. */
export const RETIRED_SAMPLE_STRATEGY_IDS = Object.freeze([
  "sample.tech-leaders-equal-weight.v1",
  "sample.aapl-sma-50-200.v1",
  "sample.rsi-14-mean-reversion.v1",
  "sample.donchian-20-atr-stop.v1",
  "sample.quality-value-top-25.v1",
  "sample.low-volatility-rotation.v1",
  "sample.earnings-revision-momentum.v1",
  "sample.relative-strength-6-1.v1",
  "sample.dividend-growth.v1",
  "sample.market-neutral-pairs.v1",
] as const);

export const DEFAULT_STRATEGY_PACKAGE_ID = STRATEGY_PACKAGE_DEFINITIONS[0].id;

export function strategyPackagesForLocale(
  locale: Locale,
  preferences: readonly StrategyPreference[] = [],
): StrategyPackageRecord[] {
  const preferencesById = new Map(
    preferences.map((preference) => [preference.strategyId, preference] as const),
  );
  return STRATEGY_PACKAGE_DEFINITIONS.flatMap((definition) => {
    const preference = preferencesById.get(definition.id);
    if (preference?.isDeleted) return [];
    const localized = definition.copy[locale];
    const performance = { ...definition.performance } as StrategyPerformance;
    return [{
      id: definition.id,
      family: definition.family,
      status: definition.status,
      candidateAt: definition.candidateAt,
      name: preference?.name ?? localized.name,
      category: localized.category,
      sourceLabels: [...localized.sourceLabels],
      headline: preference?.headline ?? localized.headline,
      audit: {
        ...definition.audit,
        verdict: localized.auditVerdict,
      },
      performance,
      netReturn: performance.netReturn,
      maxDrawdown: performance.maxDrawdown,
      recoveryFactor: performance.recoveryFactor,
      sharpe: performance.sharpe,
      forwardReturn: performance.forwardReturn,
      winRate: performance.winRate,
      trades: performance.trades,
      symbols: performance.symbols,
      cash: performance.cash,
    }];
  });
}

export function isStrategyPackageId(strategyId: string): boolean {
  return STRATEGY_PACKAGE_DEFINITIONS.some(({ id }) => id === strategyId);
}

export function strategyPackageById(strategyId: string) {
  return STRATEGY_PACKAGE_DEFINITIONS.find(({ id }) => id === strategyId) ?? null;
}
