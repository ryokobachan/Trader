export const STRATEGY_SUMMARY_METRIC_IDS = [
  "portfolio.value",
  "portfolio.unrealizedGain",
  "portfolio.totalGain",
  "portfolio.annualReturn",
  "risk.beta",
  "risk.recoveryFactor",
  "risk.sharpe",
  "risk.sortino",
  "risk.maxDrawdown",
  "trades.winRate",
] as const;

export type StrategySummaryMetricId = (typeof STRATEGY_SUMMARY_METRIC_IDS)[number];
