export const CHART_TYPE_IDS = ["candles", "heikin-ashi", "line", "area"] as const;

export type ChartTypeId = (typeof CHART_TYPE_IDS)[number];

const LEGACY_CHART_TYPES: Readonly<Record<string, ChartTypeId>> = {
  "ローソク": "candles",
  "平均足": "heikin-ashi",
  "ライン": "line",
  "エリア": "area",
};

export function resolveChartTypeId(value: unknown): ChartTypeId | null {
  if (typeof value !== "string") return null;
  if ((CHART_TYPE_IDS as readonly string[]).includes(value)) return value as ChartTypeId;
  return LEGACY_CHART_TYPES[value] ?? null;
}

export type OhlcBar = {
  open: number;
  high: number;
  low: number;
  close: number;
};

/**
 * Converts regular OHLC bars to Heikin Ashi without mutating the input bars.
 * Non-OHLC fields such as time and volume are preserved.
 */
export function toHeikinAshiBars<T extends OhlcBar>(bars: readonly T[]): T[] {
  let previousOpen: number | undefined;
  let previousClose: number | undefined;

  return bars.map((bar) => {
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const open = previousOpen === undefined || previousClose === undefined
      ? (bar.open + bar.close) / 2
      : (previousOpen + previousClose) / 2;
    const converted = {
      ...bar,
      open,
      high: Math.max(bar.high, open, close),
      low: Math.min(bar.low, open, close),
      close,
    };
    previousOpen = open;
    previousClose = close;
    return converted;
  });
}
