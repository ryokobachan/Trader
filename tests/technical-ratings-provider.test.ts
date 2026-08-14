import assert from "node:assert/strict";
import test from "node:test";

import { latestIndicatorValue, computeIndicatorSeries } from "../src/app/features/chart-indicators/indicator-calculations";
import type { MarketBar } from "../src/app/platform/provider-contracts";
import {
  buildStockDetailTechnicalRatings,
  normalizeTechnicalRatingBars,
  technicalRatingVerdict,
} from "../api/stock-detail/technical-ratings";
import { buildStockDetailTechnicalMetrics } from "../api/stock-detail/metrics";

function dailyBars(length = 300, direction: 1 | -1 = 1): readonly MarketBar[] {
  return Array.from({ length }, (_, index) => {
    const close = 200 + direction * index * 0.5;
    return {
      time: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
      open: close - 0.2,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000 + index * 1_000,
    };
  });
}

function oscillatingBars(length = 260): readonly MarketBar[] {
  return Array.from({ length }, (_, index) => {
    const close = 120
      + index * 0.07
      + Math.sin(index / 3.7) * 4
      + Math.cos(index / 11.2) * 2;
    return {
      time: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
      open: close - 0.3 + Math.sin(index / 5) * 0.4,
      high: close + 1 + (index % 5) * 0.13,
      low: close - 0.9 - (index % 7) * 0.11,
      close,
      volume: 700_000 + index * 2_100 + (index % 9) * 17_000,
    };
  });
}

function assertClose(actual: number | null | undefined, expected: number, tolerance = 1e-6) {
  assert.notEqual(actual, null);
  assert.notEqual(actual, undefined);
  assert.ok(Math.abs(actual! - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test("builds the complete 15-MA and 11-oscillator rating contract", () => {
  const summary = buildStockDetailTechnicalRatings(dailyBars());

  assert.equal(summary.barCount, 300);
  assert.equal(summary.movingAverages.total, 15);
  assert.equal(summary.oscillators.total, 11);
  assert.equal(summary.overall.total, 26);
  assert.deepEqual(
    summary.movingAverages.signals.map((signal) => signal.id),
    [
      "sma10", "sma20", "sma30", "sma50", "sma100", "sma200",
      "ema10", "ema20", "ema30", "ema50", "ema100", "ema200",
      "hma9", "vwma20", "ichimoku",
    ],
  );
  assert.deepEqual(
    summary.oscillators.signals.map((signal) => signal.id),
    [
      "rsi14", "stochastic1433", "cci20", "adx1414", "awesome_oscillator",
      "momentum10", "macd12269", "stochastic_rsi331414", "williams_r14",
      "bull_bear_power13", "ultimate_oscillator71428",
    ],
  );
  for (const group of [summary.overall, summary.movingAverages, summary.oscillators]) {
    assert.equal(group.buy + group.neutral + group.sell + group.unavailable, group.total);
  }
});

test("uses official aggregate verdict boundaries", () => {
  assert.equal(technicalRatingVerdict(null), "unavailable");
  assert.equal(technicalRatingVerdict(-0.500001), "strong_sell");
  assert.equal(technicalRatingVerdict(-0.5), "sell");
  assert.equal(technicalRatingVerdict(-0.1), "neutral");
  assert.equal(technicalRatingVerdict(0.1), "neutral");
  assert.equal(technicalRatingVerdict(0.100001), "buy");
  assert.equal(technicalRatingVerdict(0.5), "buy");
  assert.equal(technicalRatingVerdict(0.500001), "strong_buy");
});

test("normalizes out-of-order and duplicated daily data without fabricating bars", () => {
  const input: readonly MarketBar[] = [
    { time: "2025-01-03T21:00:00Z", open: 12, high: 14, low: 11, close: 13, volume: 300 },
    { time: "invalid", open: 12, high: 14, low: 11, close: 13, volume: 300 },
    { time: "2025-01-02T15:00:00Z", open: 9, high: 12, low: 8, close: 10, volume: 100 },
    { time: "2025-01-02T21:00:00Z", open: 10, high: 13, low: 9, close: 11, volume: 200 },
    { time: "2025-01-04T21:00:00Z", open: 15, high: 14, low: 13, close: 13.5, volume: 100 },
    { time: "2025-01-05T21:00:00Z", open: 13, high: 15, low: 12, close: 14, volume: -1 },
  ];

  const normalized = normalizeTechnicalRatingBars(input);
  assert.deepEqual(normalized.map((bar) => [bar.time, bar.close]), [
    ["2025-01-02T21:00:00Z", 11],
    ["2025-01-03T21:00:00Z", 13],
  ]);
  const summary = buildStockDetailTechnicalRatings(input);
  assert.equal(summary.barCount, 2);
  assert.equal(summary.asOf, "2025-01-03T21:00:00Z");
  assert.equal(summary.movingAverages.unavailable, 15);
  assert.equal(summary.oscillators.unavailable, 11);
  assert.equal(summary.overall.verdict, "unavailable");
});

test("excludes unavailable components from group scores", () => {
  const summary = buildStockDetailTechnicalRatings(dailyBars(20));
  const available = summary.movingAverages.signals.filter((signal) => signal.score !== null);

  assert.ok(available.length > 0);
  assert.ok(summary.movingAverages.unavailable > 0);
  assert.equal(
    summary.movingAverages.score,
    available.reduce<number>((sum, signal) => sum + signal.score!, 0) / available.length,
  );
  assert.equal(summary.movingAverages.total, 15);
  assert.equal(summary.oscillators.total, 11);
});

test("moving-average signals are derived from the canonical close series", () => {
  const rising = buildStockDetailTechnicalRatings(dailyBars());
  const falling = buildStockDetailTechnicalRatings(dailyBars(300, -1));

  for (const id of ["sma10", "sma20", "sma30", "sma50", "sma100", "sma200"] as const) {
    assert.equal(rising.movingAverages.signals.find((signal) => signal.id === id)?.signal, "buy");
    assert.equal(falling.movingAverages.signals.find((signal) => signal.id === id)?.signal, "sell");
  }
  assert.equal(rising.movingAverages.verdict, "strong_buy");
  assert.equal(falling.movingAverages.verdict, "strong_sell");
});

test("ADX sell follows the published bearish-DI and falling-ADX rule", () => {
  const bars: readonly MarketBar[] = Array.from({ length: 160 }, (_, index) => {
    const close = index < 120
      ? 300 - index * 1.1
      : 168 + Math.sin(index) * 0.05;
    return {
      time: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      open: close + 0.15,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000 + index * 1_000,
    };
  });

  const adx = buildStockDetailTechnicalRatings(bars).oscillators.signals
    .find((signal) => signal.id === "adx1414");
  assert.equal(adx?.signal, "sell");
  assert.equal(adx?.score, -1);
});

test("core oscillator readings match TA-Lib golden values", () => {
  const summary = buildStockDetailTechnicalRatings(oscillatingBars());
  const values = new Map(
    [...summary.movingAverages.signals, ...summary.oscillators.signals]
      .map((signal) => [signal.id, signal] as const),
  );

  assertClose(values.get("sma200")?.value, 131.0459756549294);
  assertClose(values.get("rsi14")?.value, 71.92788298190544);
  assertClose(values.get("stochastic1433")?.value, 86.78774405083807);
  assertClose(values.get("stochastic1433")?.secondaryValue, 84.13842791131214);
  assertClose(values.get("cci20")?.value, 149.87344890813338);
  assertClose(values.get("adx1414")?.value, 26.32914250913521);
  assertClose(values.get("adx1414")?.secondaryValue, 24.595375308621325);
  assertClose(values.get("momentum10")?.value, 8.770073388252115);
  assertClose(values.get("macd12269")?.value, 0.6622867397069854);
  assertClose(values.get("macd12269")?.secondaryValue, -0.1567797238301129);
  assertClose(values.get("williams_r14")?.value, -12.947154893696982);
  assertClose(values.get("ultimate_oscillator71428")?.value, 48.88605315339022);
});

test("stock-detail ATR is the same canonical Wilder series used by charts", () => {
  const bars: readonly MarketBar[] = Array.from({ length: 80 }, (_, index) => {
    const close = 100 + Math.sin(index / 3) * 4 + index * 0.1;
    return {
      time: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      open: close - 0.4,
      high: close + 1 + (index % 5) * 0.3,
      low: close - 0.8 - (index % 3) * 0.2,
      close,
      volume: 900_000 + index * 4_000,
    };
  });
  const metric = buildStockDetailTechnicalMetrics(bars)
    .find((item) => item.id === "technical.atr14");
  const canonical = latestIndicatorValue(
    computeIndicatorSeries(bars, { id: "atr14", length: 14 }),
    "atr",
  );

  assert.notEqual(canonical, undefined);
  assert.equal(metric?.value, `$${canonical!.toFixed(2)}`);
  assert.match(metric?.note ?? "", /Wilder/);
});

test("view-model integration exposes ratings while retaining raw technical metrics", async () => {
  const { buildStockDetailViewModel } = await import("../api/stock-detail/metrics");
  const model = buildStockDetailViewModel(null, dailyBars());

  assert.equal(model.technicalRatings.barCount, 300);
  assert.equal(model.technicalRatings.overall.total, 26);
  assert.ok(model.technicals.metrics.some((metric) => metric.id === "technical.rsi14"));
  assert.ok(model.technicals.metrics.some((metric) => metric.id === "technical.atr14"));
});
