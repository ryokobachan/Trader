import type { LogicalRange } from "lightweight-charts";

export type ChartDataLifecycleState = Readonly<{
  identity: string | null;
  pointCount: number;
}>;

export type ChartDataUpdatePlan = Readonly<{
  nextState: ChartDataLifecycleState;
  fitContent: boolean;
  visibleLogicalRange: LogicalRange | null;
}>;

export const EMPTY_CHART_DATA_LIFECYCLE: ChartDataLifecycleState = Object.freeze({
  identity: null,
  pointCount: 0,
});

function validLogicalRange(range: LogicalRange | null): range is LogicalRange {
  return Boolean(
    range
    && Number.isFinite(range.from)
    && Number.isFinite(range.to)
    && range.from <= range.to,
  );
}

/**
 * Plans how a persistent chart should handle a new data snapshot.
 *
 * A new symbol/timeframe gets a fresh fitted viewport. Polling updates keep the
 * user's viewport. When that viewport is already following the right edge, an
 * appended candle advances it by the same number of logical indexes so the new
 * live candle remains visible.
 */
export function planChartDataUpdate({
  previous,
  identity,
  pointCount,
  visibleLogicalRange,
}: {
  previous: ChartDataLifecycleState;
  identity: string;
  pointCount: number;
  visibleLogicalRange: LogicalRange | null;
}): ChartDataUpdatePlan {
  const nextPointCount = Number.isFinite(pointCount) ? Math.max(0, Math.floor(pointCount)) : 0;
  const nextState = Object.freeze({ identity, pointCount: nextPointCount });
  const isFirstPopulatedSnapshot = previous.pointCount === 0 && nextPointCount > 0;
  const identityChanged = previous.identity !== null && previous.identity !== identity;

  if (isFirstPopulatedSnapshot || identityChanged) {
    return { nextState, fitContent: nextPointCount > 0, visibleLogicalRange: null };
  }

  if (!validLogicalRange(visibleLogicalRange) || nextPointCount === 0) {
    return { nextState, fitContent: false, visibleLogicalRange: null };
  }

  const appendedPointCount = nextPointCount - previous.pointCount;
  const previousRightEdge = Math.max(0, previous.pointCount - 1);
  const isFollowingRightEdge = previous.pointCount > 0
    && visibleLogicalRange.to >= previousRightEdge - 0.5;
  const shift = isFollowingRightEdge && appendedPointCount > 0 ? appendedPointCount : 0;

  return {
    nextState,
    fitContent: false,
    visibleLogicalRange: Object.freeze({
      from: visibleLogicalRange.from + shift,
      to: visibleLogicalRange.to + shift,
    }) as LogicalRange,
  };
}
