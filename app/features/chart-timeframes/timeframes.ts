import type {
  MarketBarInterval,
  MarketBarRange,
} from "../../platform/provider-contracts";

export type ChartIntervalOption = Readonly<{
  interval: MarketBarInterval;
  label: string;
  maxRange: MarketBarRange;
}>;

export type ChartRangeOption = Readonly<{
  range: MarketBarRange;
  label: string;
}>;

/**
 * Core-owned chart controls. Providers receive canonical interval/range IDs;
 * Japanese labels never leak into provider adapters.
 */
export const CHART_INTERVAL_OPTIONS: readonly ChartIntervalOption[] = Object.freeze([
  { interval: "1m", label: "1分", maxRange: "1d" },
  { interval: "5m", label: "5分", maxRange: "5d" },
  { interval: "15m", label: "15分", maxRange: "1mo" },
  { interval: "1h", label: "1時間", maxRange: "3mo" },
  { interval: "4h", label: "4時間", maxRange: "1y" },
  { interval: "1d", label: "日", maxRange: "5y" },
  { interval: "1wk", label: "週", maxRange: "5y" },
  { interval: "1mo", label: "月", maxRange: "5y" },
]);

export const CHART_RANGE_OPTIONS: readonly ChartRangeOption[] = Object.freeze([
  { range: "1d", label: "1日" },
  { range: "5d", label: "5日" },
  { range: "1mo", label: "1月" },
  { range: "3mo", label: "3月" },
  { range: "6mo", label: "6月" },
  { range: "1y", label: "1年" },
]);

const RANGE_ORDER: readonly MarketBarRange[] = Object.freeze([
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "5y",
]);

function optionForInterval(interval: MarketBarInterval): ChartIntervalOption {
  const option = CHART_INTERVAL_OPTIONS.find((item) => item.interval === interval);
  if (!option) throw new Error(`Unsupported chart interval: ${interval}`);
  return option;
}

export function isChartRangeSupported(
  interval: MarketBarInterval,
  range: MarketBarRange,
): boolean {
  return RANGE_ORDER.indexOf(range) <= RANGE_ORDER.indexOf(optionForInterval(interval).maxRange);
}

export function clampChartRange(
  interval: MarketBarInterval,
  requestedRange: MarketBarRange,
): MarketBarRange {
  return isChartRangeSupported(interval, requestedRange)
    ? requestedRange
    : optionForInterval(interval).maxRange;
}

export function chartIntervalLabel(interval: MarketBarInterval): string {
  return optionForInterval(interval).label;
}

export function chartRangeLabel(range: MarketBarRange): string {
  return CHART_RANGE_OPTIONS.find((item) => item.range === range)?.label ?? range;
}
