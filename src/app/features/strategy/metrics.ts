import type { createStrategyTranslator } from "./i18n";
import type { StrategySummaryMetricId } from "./metric-ids";
import type { StrategyPerformance } from "@/app/platform/strategy-contracts";

export type StrategySummaryCard = Readonly<{
  label: string;
  value: string;
  note: string;
  tone?: "positive" | "negative-text";
}>;

type StrategyTranslator = ReturnType<typeof createStrategyTranslator>;

export type StrategySummaryMetricContext = Readonly<{
  selected: Readonly<{ performance: StrategyPerformance }>;
  unrealizedGain?: number;
  holdingsMarketValue?: number;
  recordedPortfolioValue?: number;
  recordedCashPercent?: number;
  annualReturn?: number;
  benchmarkAnnualReturn?: number;
  translate: StrategyTranslator;
}>;

/**
 * Typed formatting registry for strategy result summaries.
 *
 * `api/config.json` may select and order these stable IDs, while formulas,
 * units, and disclosures stay reviewed code so JSON cannot change semantics.
 */
export function buildStrategySummaryMetricRegistry({
  selected,
  unrealizedGain,
  holdingsMarketValue,
  recordedPortfolioValue,
  recordedCashPercent,
  annualReturn,
  benchmarkAnnualReturn,
  translate,
}: StrategySummaryMetricContext) {
  const cashPercent = recordedCashPercent ?? selected.performance.cash ?? 0;
  const cashRatio = Math.max(0, Math.min(1, cashPercent / 100));
  const recordedCashValue = recordedPortfolioValue === undefined
    ? undefined
    : recordedPortfolioValue * cashRatio;
  const computedPortfolioValue = holdingsMarketValue === undefined
    ? recordedPortfolioValue ?? 0
    : recordedCashValue === undefined
      ? cashRatio >= 1 ? holdingsMarketValue : holdingsMarketValue / (1 - cashRatio)
      : holdingsMarketValue + recordedCashValue;
  const portfolioValue = Math.round(computedPortfolioValue);
  const cashValue = Math.round(recordedCashValue
    ?? (holdingsMarketValue === undefined ? 0 : Math.max(0, portfolioValue - holdingsMarketValue)));
  const netReturn = selected.performance.netReturn;
  const maxDrawdown = selected.performance.maxDrawdown;
  const recoveryFactor = selected.performance.recoveryFactor;
  const sharpe = selected.performance.sharpe;
  const winRate = selected.performance.winRate;
  const benchmarkDifference = annualReturn === undefined || benchmarkAnnualReturn === undefined
    ? undefined
    : annualReturn - benchmarkAnnualReturn;

  const cards: Readonly<Record<StrategySummaryMetricId, StrategySummaryCard>> = {
    "portfolio.value": {
      label: translate("portfolio.value"),
      value: portfolioValue > 0 ? `$${Math.round(portfolioValue).toLocaleString("en-US")}` : "—",
      note: translate("portfolio.cash", {
        value: portfolioValue > 0 ? `$${Math.round(cashValue).toLocaleString("en-US")}` : "—",
      }),
    },
    "portfolio.unrealizedGain": {
      label: translate("portfolio.unrealizedGain"),
      value: portfolioValue > 0 && unrealizedGain !== undefined
        ? `${unrealizedGain >= 0 ? "+" : "-"}$${Math.abs(Math.round(unrealizedGain)).toLocaleString("en-US")}`
        : "—",
      note: portfolioValue > 0 && unrealizedGain !== undefined
        ? `${unrealizedGain >= 0 ? "+" : ""}${(unrealizedGain / portfolioValue * 100).toFixed(2)}%`
        : "—",
      ...(unrealizedGain === undefined
        ? {}
        : { tone: unrealizedGain >= 0 ? "positive" as const : "negative-text" as const }),
    },
    "portfolio.totalGain": {
      label: translate("portfolio.totalGain"),
      value: netReturn === null ? "—" : `${netReturn >= 0 ? "+" : ""}${netReturn.toFixed(2)}%`,
      note: translate("portfolio.sinceInception", {
        value: netReturn === null ? "—" : `${netReturn >= 0 ? "+" : ""}${netReturn.toFixed(2)}%`,
      }),
      ...(netReturn === null ? {} : { tone: netReturn >= 0 ? "positive" as const : "negative-text" as const }),
    },
    "portfolio.annualReturn": {
      label: translate("portfolio.annualReturn"),
      value: annualReturn === undefined ? "—" : `${annualReturn >= 0 ? "+" : ""}${annualReturn.toFixed(2)}%`,
      note: benchmarkDifference === undefined
        ? translate("portfolio.benchmarkComparison")
        : translate("portfolio.benchmarkDifference", {
            value: `${benchmarkDifference >= 0 ? "+" : ""}${benchmarkDifference.toFixed(2)}pt`,
          }),
      ...(annualReturn === undefined
        ? {}
        : { tone: annualReturn >= 0 ? "positive" as const : "negative-text" as const }),
    },
    "risk.beta": {
      label: "Beta",
      value: "—",
      note: translate("portfolio.benchmarkComparison"),
    },
    "risk.recoveryFactor": {
      label: translate("portfolio.recoveryFactor"),
      value: recoveryFactor?.toFixed(2) ?? "—",
      note: translate("portfolio.recoveryFactorNote"),
    },
    "risk.sharpe": {
      label: "Sharpe",
      value: sharpe?.toFixed(2) ?? "—",
      note: translate("portfolio.riskFreeRate"),
    },
    "risk.sortino": {
      label: "Sortino",
      value: "—",
      note: translate("portfolio.downsideRisk"),
    },
    "risk.maxDrawdown": {
      label: translate("portfolio.maxDrawdown"),
      value: maxDrawdown === null ? "—" : `${maxDrawdown.toFixed(1)}%`,
      note: translate("portfolio.recordedBacktest"),
      tone: "negative-text",
    },
    "trades.winRate": {
      label: translate("portfolio.winRate"),
      value: winRate === null ? "—" : `${winRate.toFixed(1)}%`,
      note: translate("portfolio.closedTrades"),
    },
  };

  return Object.freeze({
    portfolioValue,
    cashValue,
    cards: Object.freeze(cards),
  });
}
