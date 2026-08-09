import {
  MAX_MARKET_BAR_COUNT,
  MIN_MARKET_BAR_COUNT,
} from "../../platform/provider-contracts";

export const DEFAULT_CHART_CANDLE_COUNT = 1_000 as const;

export {
  MAX_MARKET_BAR_COUNT as MAX_CHART_CANDLE_COUNT,
  MIN_MARKET_BAR_COUNT as MIN_CHART_CANDLE_COUNT,
};

/**
 * Parses a user or persisted candle-count preference at the UI boundary.
 * Invalid, fractional, and out-of-contract values are rejected so they never
 * reach the market-bars route.
 */
export function parseChartCandleCount(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;

  if (
    !Number.isSafeInteger(numeric)
    || numeric < MIN_MARKET_BAR_COUNT
    || numeric > MAX_MARKET_BAR_COUNT
  ) {
    return null;
  }
  return numeric;
}
