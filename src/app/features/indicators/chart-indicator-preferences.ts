import { CHART_INDICATOR_IDS, type ChartIndicatorId } from "../chart-templates/chart-templates";

export const DEFAULT_ACTIVE_CHART_INDICATORS: readonly ChartIndicatorId[] = ["sma20", "rsi14", "volume", "volumeProfile"];
const knownIds = new Set<string>(CHART_INDICATOR_IDS);

/** Migrate the previously always-visible volume layers once, then respect removals. */
export function restoreActiveChartIndicators(value: unknown, volumeIndicatorsVersion: unknown): ChartIndicatorId[] {
  if (!Array.isArray(value)) return [...DEFAULT_ACTIVE_CHART_INDICATORS];
  const active = value.filter((id): id is ChartIndicatorId => typeof id === "string" && knownIds.has(id));
  if (volumeIndicatorsVersion !== 1) active.push("volume", "volumeProfile");
  return [...new Set(active)];
}
