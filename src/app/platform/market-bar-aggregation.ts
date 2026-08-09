import type { MarketBar } from "./provider-contracts";

export type AggregatedMarketBarInterval = "4h" | "1wk" | "1mo";

function newYorkDateKey(isoTime: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(isoTime));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function utcWeekKey(isoTime: string): string {
  const date = new Date(isoTime);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function groupKey(
  bar: MarketBar,
  target: AggregatedMarketBarInterval,
  intradayIndex: number,
): string {
  if (target === "4h") return `${newYorkDateKey(bar.time)}:${Math.floor(intradayIndex / 4)}`;
  if (target === "1wk") return utcWeekKey(bar.time);
  return bar.time.slice(0, 7);
}

function aggregateGroup(group: readonly MarketBar[]): MarketBar {
  const first = group[0];
  const last = group[group.length - 1];
  return Object.freeze({
    time: first.time,
    open: first.open,
    high: Math.max(...group.map((item) => item.high)),
    low: Math.min(...group.map((item) => item.low)),
    close: last.close,
    volume: group.reduce((sum, item) => sum + item.volume, 0),
    ...(last.adjustedClose === undefined ? {} : { adjustedClose: last.adjustedClose }),
  });
}

/**
 * Rebuilds intervals that an upstream does not expose directly. Four-hour bars
 * reset at each New York trading date so overnight gaps are never merged into
 * a regular-session candle.
 */
export function aggregateMarketBars(
  input: readonly MarketBar[],
  target: AggregatedMarketBarInterval,
): readonly MarketBar[] {
  const sorted = [...input].sort((left, right) => left.time.localeCompare(right.time));
  const groups = new Map<string, MarketBar[]>();
  let currentTradingDate = "";
  let intradayIndex = 0;

  for (const bar of sorted) {
    if (target === "4h") {
      const tradingDate = newYorkDateKey(bar.time);
      if (tradingDate !== currentTradingDate) {
        currentTradingDate = tradingDate;
        intradayIndex = 0;
      }
    }
    const key = groupKey(bar, target, intradayIndex);
    const group = groups.get(key) ?? [];
    group.push(bar);
    groups.set(key, group);
    if (target === "4h") intradayIndex += 1;
  }

  return Object.freeze([...groups.values()].map(aggregateGroup));
}
