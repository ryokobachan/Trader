import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_INDICATOR_IDS,
  computeIndicatorSeries,
  latestIndicatorValue,
  latestIndicatorValues,
  type ComputedIndicator,
  type IndicatorCalculationSpec,
} from "../app/features/chart-indicators/indicator-calculations";
import type { MarketBar } from "../app/platform/provider-contracts";

const bars: readonly MarketBar[] = Array.from({ length: 120 }, (_, index) => {
  const close = 84 + index * 0.17 + Math.sin(index / 4) * 2.1;
  return {
    time: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    open: close - 0.8 + Math.cos(index / 5) * 0.3,
    high: close + 1.2 + (index % 3) * 0.08,
    low: close - 1.1 - (index % 4) * 0.06,
    close,
    volume: 700_000 + index * 3_100 + (index % 6) * 17_000,
  };
});

function values(result: ComputedIndicator, key: string) {
  return result.series.find((series) => series.key === key)?.points.map((point) => point.value) ?? [];
}

function assertNumbersClose(actual: readonly number[], expected: readonly number[], tolerance = 1e-9) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) <= tolerance,
      `index ${index}: expected ${expected[index]}, received ${value}`,
    );
  });
}

/** Mirrors the overlay math that page.tsx's generateSeries used before extraction. */
function overlayReference(
  input: readonly MarketBar[],
  settings: Readonly<{ sma: number; ema: number; bollinger: number; multiplier: number }>,
) {
  const closes: number[] = [];
  const sma: number[] = [];
  const ema: number[] = [];
  const upper: number[] = [];
  const lower: number[] = [];
  const vwap: number[] = [];
  let emaValue = 0;
  let cumulativeVolume = 0;
  let cumulativeTypicalValue = 0;

  input.forEach((bar, index) => {
    closes.push(bar.close);
    cumulativeVolume += bar.volume;
    cumulativeTypicalValue += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    vwap.push(cumulativeTypicalValue / cumulativeVolume);

    emaValue = index === 0
      ? bar.close
      : bar.close * (2 / (settings.ema + 1)) + emaValue * (1 - 2 / (settings.ema + 1));
    if (index >= settings.ema - 1) ema.push(emaValue);

    if (index >= settings.sma - 1) {
      const window = closes.slice(index - settings.sma + 1, index + 1);
      sma.push(window.reduce((sum, value) => sum + value, 0) / settings.sma);
    }

    if (index >= settings.bollinger - 1) {
      const window = closes.slice(index - settings.bollinger + 1, index + 1);
      const average = window.reduce((sum, value) => sum + value, 0) / settings.bollinger;
      const variance = window.reduce((sum, value) => sum + (value - average) ** 2, 0) / settings.bollinger;
      const deviation = Math.sqrt(variance) * settings.multiplier;
      upper.push(average + deviation);
      lower.push(average - deviation);
    }
  });

  return { sma, ema, upper, lower, vwap };
}

test("overlay defaults retain generateSeries-compatible SMA, EMA, Bollinger, and VWAP math", () => {
  const settings = { sma: 20, ema: 50, bollinger: 20, multiplier: 2 };
  const expected = overlayReference(bars, settings);

  assertNumbersClose(values(computeIndicatorSeries(bars, { id: "sma20", length: settings.sma }), "sma"), expected.sma);
  assertNumbersClose(values(computeIndicatorSeries(bars, { id: "ema50", length: settings.ema }), "ema"), expected.ema);

  const bollinger = computeIndicatorSeries(bars, {
    id: "bollinger",
    length: settings.bollinger,
    multiplier: settings.multiplier,
  });
  assertNumbersClose(values(bollinger, "upper"), expected.upper);
  assertNumbersClose(values(bollinger, "lower"), expected.lower);
  assertNumbersClose(values(computeIndicatorSeries(bars, { id: "vwap" }), "vwap"), expected.vwap);
});

test("price source is part of the shared calculation contract", () => {
  const closeSma = computeIndicatorSeries(bars, { id: "sma20", length: 7, source: "終値" });
  const openSma = computeIndicatorSeries(bars, { id: "sma20", length: 7, source: "始値" });
  assert.notEqual(latestIndicatorValue(closeSma), latestIndicatorValue(openSma));
  assertNumbersClose(
    [latestIndicatorValue(openSma)!],
    [bars.slice(-7).reduce((sum, bar) => sum + bar.open, 0) / 7],
  );

  const highVwap = computeIndicatorSeries(bars, { id: "vwap", source: "高値" });
  const expectedHighVwap = bars.reduce((sum, bar) => sum + bar.high * bar.volume, 0)
    / bars.reduce((sum, bar) => sum + bar.volume, 0);
  assertNumbersClose([latestIndicatorValue(highVwap)!], [expectedHighVwap]);

  for (const id of ["ema50", "bollinger", "rsi14", "macd", "stochastic", "obv"] as const) {
    const close = latestIndicatorValue(computeIndicatorSeries(bars, { id, length: 14, source: "終値" }));
    const open = latestIndicatorValue(computeIndicatorSeries(bars, { id, length: 14, source: "始値" }));
    assert.notEqual(close, open, `${id} must honor the selected source`);
  }
});

test("latest readings are taken from the exact series supplied to renderers", () => {
  const customSpecs: Readonly<Record<(typeof CHART_INDICATOR_IDS)[number], IndicatorCalculationSpec>> = {
    sma20: { id: "sma20", length: 31, source: "HL2" },
    ema50: { id: "ema50", length: 17, source: "始値" },
    bollinger: { id: "bollinger", length: 23, multiplier: 2.7, source: "HLC3" },
    vwap: { id: "vwap", source: "安値" },
    rsi14: { id: "rsi14", length: 19, source: "HLC3" },
    macd: { id: "macd", fast: 7, slow: 31, signal: 5, source: "HL2" },
    stochastic: { id: "stochastic", length: 18, smoothing: 5, signal: 4, source: "終値" },
    atr14: { id: "atr14", length: 21 },
    adx14: { id: "adx14", length: 11 },
    obv: { id: "obv", source: "HLC3" },
  };

  for (const id of CHART_INDICATOR_IDS) {
    const computed = computeIndicatorSeries(bars, customSpecs[id]);
    const readings = latestIndicatorValues(computed);
    assert.equal(readings.length, computed.series.length, `${id} should expose every rendered series`);
    for (const reading of readings) {
      const rendered = computed.series.find((series) => series.key === reading.key)?.points.at(-1);
      assert.deepEqual(
        { time: reading.time, value: reading.value },
        rendered,
        `${id}/${reading.key} legend and renderer values diverged`,
      );
    }
    assert.equal(
      latestIndicatorValue(computed),
      computed.series.find((series) => series.key === computed.primarySeriesKey)?.points.at(-1)?.value,
    );
  }
});

test("calculation parameters change their corresponding rendered series", () => {
  const cases: readonly [IndicatorCalculationSpec, IndicatorCalculationSpec][] = [
    [{ id: "sma20", length: 8 }, { id: "sma20", length: 34 }],
    [{ id: "ema50", length: 8 }, { id: "ema50", length: 34 }],
    [{ id: "bollinger", length: 12, multiplier: 1 }, { id: "bollinger", length: 12, multiplier: 3 }],
    [{ id: "rsi14", length: 8 }, { id: "rsi14", length: 25 }],
    [{ id: "macd", fast: 5, slow: 18, signal: 4 }, { id: "macd", fast: 14, slow: 38, signal: 11 }],
    [{ id: "stochastic", length: 8, smoothing: 2, signal: 2 }, { id: "stochastic", length: 25, smoothing: 5, signal: 7 }],
    [{ id: "atr14", length: 7 }, { id: "atr14", length: 28 }],
    [{ id: "adx14", length: 7 }, { id: "adx14", length: 24 }],
  ];

  for (const [first, second] of cases) {
    assert.notEqual(
      latestIndicatorValue(computeIndicatorSeries(bars, first)),
      latestIndicatorValue(computeIndicatorSeries(bars, second)),
      `${first.id} should use its configured parameters`,
    );
  }
});

test("all ten indicators return only finite points for 10,000 bars", () => {
  const longHistory: readonly MarketBar[] = Array.from({ length: 10_000 }, (_, index) => {
    const close = 60 + index * 0.003 + Math.sin(index / 8) * 2.5;
    return {
      time: new Date(Date.UTC(1995, 0, index + 1)).toISOString(),
      open: close + Math.cos(index / 7) * 0.2,
      high: close + 1,
      low: close - 0.9,
      close,
      volume: 400_000 + (index % 40) * 9_000,
    };
  });

  for (const id of CHART_INDICATOR_IDS) {
    const computed = computeIndicatorSeries(longHistory, { id });
    assert.ok(computed.series.length > 0);
    assert.ok(computed.series.every((series) => series.points.length > 0));
    assert.ok(computed.series.every((series) => series.points.every((point) => Number.isFinite(point.value))));
  }
});
