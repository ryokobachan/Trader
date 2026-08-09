import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  computeSubIndicator,
  SubIndicatorPanes,
  type SubIndicatorId,
  type SubIndicatorSpec,
} from "../src/app/features/chart-indicators/SubIndicatorPanes";
import { I18nProvider, type Locale } from "../src/app/platform/i18n";
import {
  computeWilderRsiSeries,
  latestWilderRsiValue,
} from "../src/app/features/chart-indicators/indicator-calculations";
import type { MarketBar } from "../src/app/platform/provider-contracts";

const marketBars: readonly MarketBar[] = Array.from({ length: 180 }, (_, index) => {
  const close = 100 + index * 0.12 + Math.sin(index / 3) * 2.4 + Math.cos(index / 11);
  return {
    time: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    open: close - Math.sin(index) * 0.3,
    high: close + 1.4,
    low: close - 1.2,
    close,
    volume: 1_000_000 + index * 2_500 + (index % 7) * 10_000,
  };
});

function indicatorSpec(id: SubIndicatorId): SubIndicatorSpec {
  return {
    id,
    label: id,
    color: "#b388ff",
    length: 14,
    fast: 12,
    slow: 26,
    signal: 9,
    smoothing: 3,
    lineWidth: 2,
    lineStyle: "solid",
    source: "終値",
  };
}

function renderEmptyPane(locale: Locale) {
  return renderToStaticMarkup(createElement(
    I18nProvider,
    { initialLocale: locale },
    createElement(SubIndicatorPanes, {
      bars: [],
      indicators: [{ ...indicatorSpec("rsi14"), label: "RSI 14" }],
    }),
  ));
}

test("subindicator pane copy and accessible names follow the active locale", () => {
  const english = renderEmptyPane("en");
  assert.match(english, /aria-label="Separate-pane indicators"/);
  assert.match(english, /aria-label="RSI 14 chart"/);
  assert.match(english, /Not enough price history to calculate this indicator\./);
  assert.doesNotMatch(english, /価格履歴|チャート/);

  const japanese = renderEmptyPane("ja");
  assert.match(japanese, /aria-label="サブパネルインジケーター"/);
  assert.match(japanese, /aria-label="RSI 14チャート"/);
  assert.match(japanese, /計算に必要な価格履歴が不足しています/);
});

test("every supported subindicator produces non-empty finite series", () => {
  const ids: readonly SubIndicatorId[] = [
    "rsi14",
    "macd",
    "stochastic",
    "atr14",
    "adx14",
    "obv",
  ];

  for (const id of ids) {
    const computed = computeSubIndicator(marketBars, indicatorSpec(id));
    assert.ok(computed.series.length > 0, `${id} must expose at least one series`);
    for (const series of computed.series) {
      assert.ok(series.points.length > 0, `${id}/${series.name} must contain points`);
      assert.ok(
        series.points.every((point) => Number.isFinite(point.value)),
        `${id}/${series.name} contains a non-finite value`,
      );
      assert.ok(
        Number.isFinite(series.points.at(-1)?.value),
        `${id}/${series.name} must have a finite latest value`,
      );
    }
    assert.ok(
      (computed.guideLines ?? []).every(Number.isFinite),
      `${id} contains a non-finite guide line`,
    );
  }
});

test("RSI stays bounded and MACD exposes finite line, signal, and histogram series", () => {
  const rsi = computeSubIndicator(marketBars, indicatorSpec("rsi14"));
  assert.ok(rsi.series[0].points.every((point) => point.value >= 0 && point.value <= 100));

  const macd = computeSubIndicator(marketBars, indicatorSpec("macd"));
  assert.deepEqual(macd.series.map((series) => series.name), ["MACD", "Signal", "Histogram"]);
  assert.ok(macd.series.every((series) => series.points.every((point) => Number.isFinite(point.value))));
});

test("RSI pane and legend helper share the exact Wilder RSI series", () => {
  const settings = { length: 21, source: "HLC3" as const };
  const pane = computeSubIndicator(marketBars, { ...indicatorSpec("rsi14"), ...settings });
  const canonical = computeWilderRsiSeries(marketBars, settings);

  assert.deepEqual(pane.series[0].points.map((point) => point.value), canonical.map((point) => point.value));
  assert.equal(pane.series[0].points.at(-1)?.value, latestWilderRsiValue(marketBars, settings));
});

test("all subindicators stay finite with 10,000 candles", () => {
  const longHistory: readonly MarketBar[] = Array.from({ length: 10_000 }, (_, index) => {
    const close = 80 + index * 0.002 + Math.sin(index / 9) * 2 + Math.cos(index / 31);
    return {
      time: new Date(Date.UTC(1998, 0, index + 1)).toISOString(),
      open: close - Math.sin(index / 5) * 0.2,
      high: close + 0.9,
      low: close - 0.8,
      close,
      volume: 500_000 + (index % 30) * 12_000,
    };
  });
  const startedAt = performance.now();

  for (const id of ["rsi14", "macd", "stochastic", "atr14", "adx14", "obv"] as const) {
    const computed = computeSubIndicator(longHistory, indicatorSpec(id));
    assert.ok(computed.series.every((series) => series.points.every((point) => Number.isFinite(point.value))));
    assert.ok(computed.series.every((series) => Number.isFinite(series.points.at(-1)?.value)));
  }

  assert.ok(performance.now() - startedAt < 1_000, "10,000-candle indicators should stay interactive");
});
