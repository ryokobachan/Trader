import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CHART_INTERVAL_OPTIONS,
  chartIntervalLabel,
} from "../app/features/chart-timeframes/timeframes";
import {
  DEFAULT_CHART_CANDLE_COUNT,
  MAX_CHART_CANDLE_COUNT,
  MIN_CHART_CANDLE_COUNT,
  parseChartCandleCount,
} from "../app/features/chart-timeframes/candle-count";
import { aggregateMarketBars } from "../app/platform/market-bar-aggregation";
import type { MarketBar } from "../app/platform/provider-contracts";

test("maps every visible chart timeframe to a canonical market interval", () => {
  assert.deepEqual(
    CHART_INTERVAL_OPTIONS.map((item) => [item.label, item.interval]),
    [
      ["1分", "1m"],
      ["5分", "5m"],
      ["15分", "15m"],
      ["1時間", "1h"],
      ["4時間", "4h"],
      ["日", "1d"],
      ["週", "1wk"],
      ["月", "1mo"],
    ],
  );
  assert.equal(chartIntervalLabel("4h"), "4時間");
});

test("defaults to 1,000 candles and uses the saved preference for every bars request", async () => {
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.equal(DEFAULT_CHART_CANDLE_COUNT, 1_000);
  assert.equal(MIN_CHART_CANDLE_COUNT, 2);
  assert.equal(MAX_CHART_CANDLE_COUNT, 10_000);
  assert.match(pageSource, /useState<number>\(DEFAULT_CHART_CANDLE_COUNT\)/);
  assert.match(pageSource, /count:\s*String\(chartCandleCount\)/);
  assert.match(pageSource, /candleCount:\s*chartCandleCount/);
  assert.match(pageSource, /settings\.candles\.title/);
  assert.match(pageSource, /<select value=\{localeDraft\}/);
  assert.doesNotMatch(pageSource, /const CHART_CANDLE_COUNT = 10_000/);
  assert.doesNotMatch(pageSource, /CHART_RANGE_OPTIONS|setActiveRange|range-buttons/);
});

test("validates chart candle preferences against the market-bars contract", () => {
  assert.equal(parseChartCandleCount("1000"), 1_000);
  assert.equal(parseChartCandleCount(10_000), 10_000);
  assert.equal(parseChartCandleCount(2), 2);
  assert.equal(parseChartCandleCount(1), null);
  assert.equal(parseChartCandleCount(10_001), null);
  assert.equal(parseChartCandleCount("12.5"), null);
  assert.equal(parseChartCandleCount(""), null);
});

test("puts workspace navigation above chart controls and uses Command-F search", async () => {
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const workspaceNavigation = pageSource.indexOf('<nav className="workspace-view-tabs"');
  const chartToolbar = pageSource.indexOf('<header className="global-toolbar"');
  assert.ok(workspaceNavigation >= 0 && chartToolbar > workspaceNavigation);
  const workspaceBrand = pageSource.indexOf('className="brand-lockup workspace-brand-lockup"', workspaceNavigation);
  const chartTab = pageSource.indexOf('aria-selected={primaryView !== "strategy"}', workspaceNavigation);
  assert.ok(workspaceBrand > workspaceNavigation && chartTab > workspaceBrand && chartTab < chartToolbar);
  assert.equal(pageSource.slice(chartToolbar, pageSource.indexOf("{primaryView", chartToolbar)).includes("brand-lockup"), false);
  assert.match(pageSource, /key\.toLowerCase\(\) === "f"/);
  assert.match(pageSource, /⌘ F/);
  assert.doesNotMatch(pageSource, /PROVIDER DATA|ShareNetwork|profile-button/);
  assert.match(pageSource, /className="right-news-row" href=\{item\.url\} target="_blank"/);
  assert.doesNotMatch(pageSource, /概要は配信元の記事で確認してください。/);
});

test("rebuilds four-hour candles without crossing New York trading dates", () => {
  const bars: readonly MarketBar[] = [
    ["2026-08-07T13:30:00.000Z", 10, 12, 9, 11, 100],
    ["2026-08-07T14:30:00.000Z", 11, 13, 10, 12, 110],
    ["2026-08-07T15:30:00.000Z", 12, 14, 11, 13, 120],
    ["2026-08-07T16:30:00.000Z", 13, 15, 12, 14, 130],
    ["2026-08-07T17:30:00.000Z", 14, 16, 13, 15, 140],
    ["2026-08-10T13:30:00.000Z", 20, 22, 19, 21, 200],
  ].map(([time, open, high, low, close, volume]) => ({
    time: String(time),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }));

  const aggregated = aggregateMarketBars(bars, "4h");
  assert.equal(aggregated.length, 3);
  assert.deepEqual(aggregated[0], {
    time: "2026-08-07T13:30:00.000Z",
    open: 10,
    high: 15,
    low: 9,
    close: 14,
    volume: 460,
  });
  assert.equal(aggregated[1].open, 14);
  assert.equal(aggregated[2].open, 20);
});

test("rebuilds weekly and monthly candles from normalized daily bars", () => {
  const bars: readonly MarketBar[] = [
    { time: "2026-07-31T00:00:00.000Z", open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: "2026-08-03T00:00:00.000Z", open: 12, high: 14, low: 11, close: 13, volume: 200 },
    { time: "2026-08-04T00:00:00.000Z", open: 13, high: 16, low: 12, close: 15, volume: 300 },
  ];
  const weekly = aggregateMarketBars(bars, "1wk");
  assert.equal(weekly.length, 2);
  assert.deepEqual(weekly[1], {
    time: "2026-08-03T00:00:00.000Z",
    open: 12,
    high: 16,
    low: 11,
    close: 15,
    volume: 500,
  });
  const monthly = aggregateMarketBars(bars, "1mo");
  assert.equal(monthly.length, 2);
  assert.equal(monthly[1].close, 15);
});
