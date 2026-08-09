import type { createStrategyTranslator } from "./i18n";
import type { StrategySummaryMetricId } from "./metric-ids";
import type { SampleStrategyRecord } from "./catalog";

export type StrategySummaryCard = Readonly<{
  label: string;
  value: string;
  note: string;
  tone?: "positive" | "negative-text";
}>;

type StrategyTranslator = ReturnType<typeof createStrategyTranslator>;

export type StrategySummaryMetricContext = Readonly<{
  selected: SampleStrategyRecord;
  selectedCatalogIndex: number;
  unrealizedGain: number;
  translate: StrategyTranslator;
}>;

/**
 * Typed calculation registry for the built-in sample strategy summary.
 *
 * `api/config.json` may select and order these stable IDs, while formulas,
 * units, and disclosures stay reviewed code so JSON cannot change semantics.
 */
export function buildStrategySummaryMetricRegistry({
  selected,
  selectedCatalogIndex,
  unrealizedGain,
  translate,
}: StrategySummaryMetricContext) {
  const portfolioValue = 248630 + selectedCatalogIndex * 9340;
  const totalGain = Math.round(portfolioValue * selected.netReturn / 100);
  const annualizedYield = Math.max(-4.2, selected.netReturn * 0.82);

  const cards: Readonly<Record<StrategySummaryMetricId, StrategySummaryCard>> = {
    "portfolio.value": {
      label: translate("portfolio.value"),
      value: `$${portfolioValue.toLocaleString("en-US")}`,
      note: translate("portfolio.cash", {
        value: `$${Math.round(portfolioValue * selected.cash / 100).toLocaleString("en-US")}`,
      }),
    },
    "portfolio.unrealizedGain": {
      label: translate("portfolio.unrealizedGain"),
      value: `${unrealizedGain >= 0 ? "+" : "-"}$${Math.abs(unrealizedGain).toLocaleString("en-US")}`,
      note: `${unrealizedGain >= 0 ? "+" : ""}${(unrealizedGain / portfolioValue * 100).toFixed(2)}%`,
      tone: unrealizedGain >= 0 ? "positive" : "negative-text",
    },
    "portfolio.totalGain": {
      label: translate("portfolio.totalGain"),
      value: `${totalGain >= 0 ? "+" : "-"}$${Math.abs(totalGain).toLocaleString("en-US")}`,
      note: translate("portfolio.sinceInception", {
        value: `${selected.netReturn >= 0 ? "+" : ""}${selected.netReturn.toFixed(2)}%`,
      }),
      tone: totalGain >= 0 ? "positive" : "negative-text",
    },
    "portfolio.annualReturn": {
      label: translate("portfolio.annualReturn"),
      value: `${annualizedYield >= 0 ? "+" : ""}${annualizedYield.toFixed(2)}%`,
      note: translate("portfolio.benchmarkDifference"),
      tone: annualizedYield >= 0 ? "positive" : "negative-text",
    },
    "risk.beta": {
      label: "Beta",
      value: "0.92",
      note: translate("portfolio.benchmarkComparison"),
    },
    "risk.sharpe": {
      label: "Sharpe",
      value: selected.sharpe?.toFixed(2) ?? "—",
      note: translate("portfolio.riskFreeRate"),
    },
    "risk.sortino": {
      label: "Sortino",
      value: "1.44",
      note: translate("portfolio.downsideRisk"),
    },
    "risk.maxDrawdown": {
      label: translate("portfolio.maxDrawdown"),
      value: `${selected.maxDrawdown.toFixed(1)}%`,
      note: translate("portfolio.recoveryDays", { count: 41 }),
      tone: "negative-text",
    },
  };

  return Object.freeze({
    portfolioValue,
    cards: Object.freeze(cards),
  });
}
