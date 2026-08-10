import type { MarketBar } from "../../platform/provider-contracts";
import { latestWilderRsiValue } from "../chart-indicators/indicator-calculations";

export type SummaryDailyPerformance = Readonly<{
  week: number | null;
  month: number | null;
  threeMonths: number | null;
  yearToDate: number | null;
  year: number | null;
}>;

export type SummaryDailyMarketMetrics = Readonly<{
  asOf: string | null;
  range52Week: Readonly<{ low: number; high: number }> | null;
  averageVolume30: number | null;
  performance: SummaryDailyPerformance;
  rsi14: number | null;
}>;

type DatedMarketBar = Readonly<{
  date: string;
  timestamp: number;
  bar: MarketBar;
}>;

const EMPTY_PERFORMANCE: SummaryDailyPerformance = Object.freeze({
  week: null,
  month: null,
  threeMonths: null,
  yearToDate: null,
  year: null,
});

const EMPTY_METRICS: SummaryDailyMarketMetrics = Object.freeze({
  asOf: null,
  range52Week: null,
  averageVolume30: null,
  performance: EMPTY_PERFORMANCE,
  rsi14: null,
});

function validDailyBar(bar: MarketBar): DatedMarketBar | null {
  const timestamp = Date.parse(bar.time);
  if (
    !Number.isFinite(timestamp)
    || ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
    || bar.open <= 0
    || bar.high <= 0
    || bar.low <= 0
    || bar.close <= 0
    || bar.high < bar.low
    || bar.volume < 0
  ) {
    return null;
  }
  return {
    date: new Date(timestamp).toISOString().slice(0, 10),
    timestamp,
    bar,
  };
}

/**
 * Normalize canonical 1d observations without mutating the provider payload.
 * If a provider repeats a trading date, its latest observation wins.
 */
function orderedDailyBars(bars: readonly MarketBar[]): readonly DatedMarketBar[] {
  const byDate = new Map<string, DatedMarketBar>();
  for (const bar of bars) {
    const candidate = validDailyBar(bar);
    if (!candidate) continue;
    const current = byDate.get(candidate.date);
    if (!current || candidate.timestamp >= current.timestamp) {
      byDate.set(candidate.date, candidate);
    }
  }
  return [...byDate.values()].sort((left, right) => (
    left.date.localeCompare(right.date) || left.timestamp - right.timestamp
  ));
}

function calendarDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function subtractCalendarMonths(date: string, months: number) {
  const source = new Date(`${date}T00:00:00.000Z`);
  const targetMonthStart = new Date(Date.UTC(
    source.getUTCFullYear(),
    source.getUTCMonth() - months,
    1,
  ));
  const lastDay = new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  return calendarDate(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth(),
    Math.min(source.getUTCDate(), lastDay),
  );
}

function subtractCalendarDays(date: string, days: number) {
  const source = new Date(`${date}T00:00:00.000Z`);
  source.setUTCDate(source.getUTCDate() - days);
  return source.toISOString().slice(0, 10);
}

function closeOnOrBefore(bars: readonly DatedMarketBar[], targetDate: string) {
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    if (bars[index].date <= targetDate) return bars[index].bar.close;
  }
  return null;
}

function returnFromReference(latestClose: number, referenceClose: number | null) {
  return referenceClose === null || referenceClose <= 0
    ? null
    : latestClose / referenceClose - 1;
}

/**
 * Calculate overview metrics from canonical daily bars using calendar targets.
 * Callers should pass a history that extends beyond one year; every metric
 * returns null independently when its required observation window is missing.
 */
export function buildSummaryDailyMarketMetrics(
  inputBars: readonly MarketBar[],
): SummaryDailyMarketMetrics {
  const bars = orderedDailyBars(inputBars);
  const latest = bars.at(-1);
  if (!latest) return EMPTY_METRICS;

  const latestDate = latest.date;
  const latestClose = latest.bar.close;
  const weekTarget = subtractCalendarDays(latestDate, 7);
  const monthTarget = subtractCalendarMonths(latestDate, 1);
  const threeMonthsTarget = subtractCalendarMonths(latestDate, 3);
  const yearTarget = subtractCalendarMonths(latestDate, 12);
  const latestYear = Number(latestDate.slice(0, 4));
  const previousYearEnd = calendarDate(latestYear - 1, 11, 31);

  const yearReference = closeOnOrBefore(bars, yearTarget);
  const rangeBars = yearReference === null
    ? []
    : bars.filter((item) => item.date >= yearTarget && item.date <= latestDate);
  const lastThirty = bars.slice(-30);
  const rsi14 = latestWilderRsiValue(
    bars.map((item) => item.bar),
    { length: 14, source: "終値" },
  );

  return Object.freeze({
    asOf: latestDate,
    range52Week: rangeBars.length === 0
      ? null
      : Object.freeze({
        low: Math.min(...rangeBars.map((item) => item.bar.low)),
        high: Math.max(...rangeBars.map((item) => item.bar.high)),
      }),
    averageVolume30: lastThirty.length < 30
      ? null
      : lastThirty.reduce((sum, item) => sum + item.bar.volume, 0) / 30,
    performance: Object.freeze({
      week: returnFromReference(latestClose, closeOnOrBefore(bars, weekTarget)),
      month: returnFromReference(latestClose, closeOnOrBefore(bars, monthTarget)),
      threeMonths: returnFromReference(latestClose, closeOnOrBefore(bars, threeMonthsTarget)),
      yearToDate: returnFromReference(latestClose, closeOnOrBefore(bars, previousYearEnd)),
      year: returnFromReference(latestClose, yearReference),
    }),
    rsi14: rsi14 === undefined ? null : rsi14,
  });
}
