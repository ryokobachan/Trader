import type { LogicalRange } from "lightweight-charts";

// Separate Lightweight Charts instances align only when the plot area ends at
// the same x coordinate; reserve one shared width for every right price scale.
export const SYNCHRONIZED_PRICE_SCALE_MIN_WIDTH = 64;

export type ChartLogicalRangeListener = (range: LogicalRange | null) => void;

export type ChartTimeScaleSync = Readonly<{
  publish: (range: LogicalRange | null) => void;
  subscribe: (listener: ChartLogicalRangeListener) => () => void;
  snapshot: () => LogicalRange | null;
}>;

function normalizedRange(range: LogicalRange | null): LogicalRange | null {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from > range.to) return null;
  return Object.freeze({ from: range.from, to: range.to });
}

function equalRange(left: LogicalRange | null, right: LogicalRange | null) {
  if (left === null || right === null) return left === right;
  return left.from === right.from && left.to === right.to;
}

/**
 * Imperative time-scale channel shared by the price chart and its indicator
 * panes. It deliberately lives outside React state: drag/zoom updates can be
 * forwarded at chart-frame frequency without re-rendering the workspace.
 */
export function createChartTimeScaleSync(): ChartTimeScaleSync {
  let current: LogicalRange | null = null;
  const listeners = new Set<ChartLogicalRangeListener>();

  return {
    publish(range) {
      const next = normalizedRange(range);
      if (equalRange(current, next)) return;
      current = next;
      listeners.forEach((listener) => listener(current));
    },
    subscribe(listener) {
      listeners.add(listener);
      if (current !== null) listener(current);
      return () => listeners.delete(listener);
    },
    snapshot() {
      return current;
    },
  };
}
