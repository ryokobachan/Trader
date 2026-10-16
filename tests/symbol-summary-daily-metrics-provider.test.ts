import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { latestWilderRsiValue } from "../src/app/features/chart-indicators/indicator-calculations";
import { buildSummaryDailyMarketMetrics } from "../src/app/features/symbol-summary/daily-market-metrics";
import type { MarketBar } from "../src/app/platform/provider-contracts";

const pageSource = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");

function weekdayBars(start: string, count: number): MarketBar[] {
  const cursor = new Date(`${start}T20:00:00.000Z`);
  const bars: MarketBar[] = [];
  while (bars.length < count) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      const index = bars.length;
      const close = 100 + index * 0.18 + Math.sin(index / 5) * 2.4;
      bars.push({
        time: cursor.toISOString(),
        open: close - 0.4,
        high: close + 1.2,
        low: close - 1.1,
        close,
        volume: 1_000_000 + index * 1_000,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return bars;
}

function closeOnOrBefore(bars: readonly MarketBar[], target: string) {
  return bars.filter((bar) => bar.time.slice(0, 10) <= target).at(-1)!.close;
}

test("calculates overview windows from calendar dates instead of candle counts", () => {
  const completeHistory = weekdayBars("2024-01-02", 430);
  // Simulate a market holiday inside the latest week. A five-candle offset now
  // points at a different session than the calendar target.
  const bars = completeHistory.filter((_, index) => index !== completeHistory.length - 4);
  const metrics = buildSummaryDailyMarketMetrics(bars);
  const latest = bars.at(-1)!;
  const latestDate = latest.time.slice(0, 10);
  const latestDay = new Date(`${latestDate}T00:00:00.000Z`);
  const weekTarget = new Date(latestDay);
  weekTarget.setUTCDate(weekTarget.getUTCDate() - 7);
  const monthTarget = new Date(Date.UTC(
    latestDay.getUTCFullYear(),
    latestDay.getUTCMonth() - 1,
    latestDay.getUTCDate(),
  )).toISOString().slice(0, 10);
  const threeMonthsTarget = new Date(Date.UTC(
    latestDay.getUTCFullYear(),
    latestDay.getUTCMonth() - 3,
    latestDay.getUTCDate(),
  )).toISOString().slice(0, 10);
  const yearTarget = `${latestDay.getUTCFullYear() - 1}-${latestDate.slice(5)}`;
  const previousYearEnd = `${latestDay.getUTCFullYear() - 1}-12-31`;

  assert.equal(metrics.asOf, latestDate);
  assert.equal(
    metrics.performance.week,
    latest.close / closeOnOrBefore(bars, weekTarget.toISOString().slice(0, 10)) - 1,
  );
  assert.equal(metrics.performance.month, latest.close / closeOnOrBefore(bars, monthTarget) - 1);
  assert.equal(metrics.performance.threeMonths, latest.close / closeOnOrBefore(bars, threeMonthsTarget) - 1);
  assert.equal(metrics.performance.year, latest.close / closeOnOrBefore(bars, yearTarget) - 1);
  assert.equal(metrics.performance.yearToDate, latest.close / closeOnOrBefore(bars, previousYearEnd) - 1);
  assert.notEqual(metrics.performance.week, latest.close / bars.at(-6)!.close - 1);
});

test("uses one calendar year for the 52-week range and the latest 30 daily volumes", () => {
  const bars = weekdayBars("2024-01-02", 430);
  const metrics = buildSummaryDailyMarketMetrics(bars);
  const latestDate = bars.at(-1)!.time.slice(0, 10);
  const cutoff = `${Number(latestDate.slice(0, 4)) - 1}-${latestDate.slice(5)}`;
  const expectedRangeBars = bars.filter((bar) => {
    const date = bar.time.slice(0, 10);
    return date >= cutoff && date <= latestDate;
  });
  const lastThirty = bars.slice(-30);

  assert.deepEqual(metrics.range52Week, {
    low: Math.min(...expectedRangeBars.map((bar) => bar.low)),
    high: Math.max(...expectedRangeBars.map((bar) => bar.high)),
  });
  assert.equal(
    metrics.averageVolume30,
    lastThirty.reduce((sum, bar) => sum + bar.volume, 0) / 30,
  );
});

test("uses the shared Wilder RSI implementation", () => {
  const bars = weekdayBars("2025-01-02", 180);
  const metrics = buildSummaryDailyMarketMetrics(bars);

  assert.equal(
    metrics.rsi14,
    latestWilderRsiValue(bars, { length: 14, source: "終値" }),
  );
});

test("returns unavailable values independently when daily history is insufficient", () => {
  const bars = weekdayBars("2026-07-01", 10);
  const metrics = buildSummaryDailyMarketMetrics(bars);

  assert.equal(metrics.range52Week, null);
  assert.equal(metrics.averageVolume30, null);
  assert.deepEqual(metrics.performance, {
    week: metrics.performance.week,
    month: null,
    threeMonths: null,
    yearToDate: null,
    year: null,
  });
  assert.notEqual(metrics.performance.week, null);
  assert.equal(metrics.rsi14, null);
  assert.deepEqual(buildSummaryDailyMarketMetrics([]), {
    asOf: null,
    range52Week: null,
    averageVolume30: null,
    performance: {
      week: null,
      month: null,
      threeMonths: null,
      yearToDate: null,
      year: null,
    },
    rsi14: null,
  });
});

test("sorts daily observations and keeps the latest duplicate date without mutating input", () => {
  const bars = weekdayBars("2024-01-02", 430);
  const replacement: MarketBar = {
    ...bars.at(-1)!,
    time: bars.at(-1)!.time.replace("20:00:00", "21:00:00"),
    close: bars.at(-1)!.close + 5,
    high: bars.at(-1)!.close + 6,
  };
  const input = [replacement, ...bars.slice().reverse()];
  const snapshot = input.slice();
  const metrics = buildSummaryDailyMarketMetrics(input);

  assert.deepEqual(input, snapshot);
  assert.equal(metrics.asOf, replacement.time.slice(0, 10));
  assert.equal(
    metrics.performance.year,
    replacement.close / closeOnOrBefore(bars, `${Number(metrics.asOf!.slice(0, 4)) - 1}-${metrics.asOf!.slice(5)}`) - 1,
  );
});

test("drops malformed OHLCV before calculating summary metrics", () => {
  const valid = weekdayBars("2026-07-01", 35);
  const malformed: MarketBar[] = [
    { ...valid.at(-1)!, time: "2026-08-20T20:00:00.000Z", open: 0 },
    { ...valid.at(-1)!, time: "2026-08-21T20:00:00.000Z", high: valid.at(-1)!.close - 1 },
    { ...valid.at(-1)!, time: "2026-08-22T20:00:00.000Z", low: valid.at(-1)!.close + 1 },
    { ...valid.at(-1)!, time: "2026-08-23T20:00:00.000Z", volume: -1 },
  ];

  const metrics = buildSummaryDailyMarketMetrics([...valid, ...malformed]);
  assert.equal(metrics.asOf, valid.at(-1)!.time.slice(0, 10));
  assert.equal(metrics.averageVolume30, buildSummaryDailyMarketMetrics(valid).averageVolume30);
});

test("wires a dedicated daily series into summary, detail technicals, and analyst history", () => {
  assert.match(pageSource, /interval:\s*"1d",[\s\S]*?count:\s*String\(DEFAULT_CHART_CANDLE_COUNT\)/);
  assert.match(
    pageSource,
    /buildStockDetailViewModel\(detailWorkspace, detailDailyMarketBars, detailDailyBarsProvenance, locale\)/,
  );
  assert.match(
    pageSource,
    /getStockIntelligence\([\s\S]*?stock,[\s\S]*?detailWorkspace,[\s\S]*?dailyBarsStatus === "provider" \? detailDailyMarketBars : \[\],[\s\S]*?locale/,
  );
  assert.match(pageSource, /buildStockDetailTechnicalRatings\(bars\)/);
  assert.match(pageSource, /technicalRatings\.overall\.verdict/);
  assert.match(pageSource, /technicalRatings\.movingAverages\.verdict/);
  assert.match(pageSource, /technicalRatings\.oscillators\.verdict/);
  assert.doesNotMatch(pageSource, /\? 68 : 36|movingAverage20/);
  assert.match(pageSource, /targetPriceMarketBars=\{detailDailyMarketBars\}/);
  assert.match(pageSource, /barsStatus=\{dailyBarsStatus\}/);
  assert.match(pageSource, /dataStatus=\{researchDataStatus\}/);
  assert.match(
    pageSource,
    /dataFreshness:\s*t\(dailyBarsStatus === "loading" \? "status\.fetching" : "status\.connectionError"\)/,
  );
  assert.doesNotMatch(
    pageSource,
    /buildStockDetailViewModel\(detailWorkspace, detailMarketBars/,
  );
});
