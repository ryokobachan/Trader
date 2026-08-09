import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analystRatingChangeTone,
  analystTargetChangeTone,
  analystTargetRightOffsetPixels,
  buildActualStockPricePoints,
} from "../src/app/features/stock-detail/StockDetailCharts";
import { translate } from "../src/app/platform/i18n";
import type { AnalystRatingEvent, MarketBar } from "../src/app/platform/provider-contracts";

function bar(time: string, close: number): MarketBar {
  return {
    time,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1_000,
  };
}

function analystEvent(overrides: Partial<AnalystRatingEvent> = {}): AnalystRatingEvent {
  return {
    eventId: "rating-1",
    instrumentId: "us:XNAS:AAPL",
    symbol: "AAPL",
    sourceEventDate: "2026-08-08",
    eventTime: "2026-08-08T12:00:00.000Z",
    ...overrides,
  };
}

test("normalizes daily and intraday bars without fabricating missing trading days", () => {
  const points = buildActualStockPricePoints([
    bar("2026-06-03T20:00:00.000Z", 103),
    bar("2026-06-01", 100),
    bar("2026-06-03T14:30:00.000Z", 101),
    bar("not-a-date", 999),
    bar("2026-06-04T20:00:00.000Z", Number.NaN),
  ]);

  assert.deepEqual(points, [
    { date: "2026-06-01", close: 100 },
    { date: "2026-06-03", close: 103 },
  ]);
  assert.equal(points.some((point) => point.date === "2026-06-02"), false);
});

test("uses the last observed bar when timestamps collide", () => {
  const points = buildActualStockPricePoints([
    bar("2026-06-03T20:00:00.000Z", 103),
    bar("2026-06-03T20:00:00.000Z", 104),
  ]);

  assert.deepEqual(points, [{ date: "2026-06-03", close: 104 }]);
});

test("renders actual closes as their own chart series and crosshair readout", async () => {
  const source = await readFile(
    new URL("../src/app/features/stock-detail/StockDetailCharts.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /marketBars:\s*readonly MarketBar\[\]/);
  assert.match(source, /title:\s*t\("detail\.chart\.target\.actualSeries"\)/);
  assert.match(source, /actualPrice\.setData\(actualPrices/);
  assert.match(source, /subscribeCrosshairMove/);
  assert.match(source, /seriesData\.get\(actualPrice\)/);
  assert.match(source, /detail\.chart\.target\.aria/);
  assert.doesNotMatch(source, /createPriceLine/);
});

test("localizes analyst and earnings chart copy in English and Japanese", async () => {
  assert.equal(translate("en", "detail.chart.target.title"), "Price target consensus over time");
  assert.equal(translate("ja", "detail.chart.target.title"), "目標価格コンセンサスの推移");
  assert.equal(translate("en", "detail.chart.earnings.title"), "Actuals vs market estimates");
  assert.equal(translate("ja", "detail.chart.earnings.title"), "実績と市場予想");
  assert.equal(
    translate("en", "detail.chart.target.actualLegend", { value: "$220.00", date: "2026-08-08" }),
    "Actual price $220.00 · 2026-08-08",
  );

  const source = await readFile(
    new URL("../src/app/features/stock-detail/StockDetailCharts.tsx", import.meta.url),
    "utf8",
  );
  assert.equal((source.match(/const \{ locale, t \} = useI18n\(\)/g) ?? []).length, 2);
  assert.match(source, /localization:\s*\{\s*locale:\s*chartLocaleTag\(locale\)\s*\}/);
  assert.match(source, /formatChartDate\(displayedReadout\.date, locale\)/);
  assert.match(source, /detail\.chart\.earnings\.metricAria/);
  assert.match(source, /detail\.chart\.earnings\.aria/);
});

test("reserves a responsive but bounded future area on the analyst chart", async () => {
  assert.equal(analystTargetRightOffsetPixels(320), 56);
  assert.equal(analystTargetRightOffsetPixels(800), 112);
  assert.equal(analystTargetRightOffsetPixels(2_000), 128);

  const source = await readFile(
    new URL("../src/app/features/stock-detail/StockDetailCharts.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /rightOffsetPixels:\s*analystTargetRightOffsetPixels/);
  assert.match(source, /fixRightEdge:\s*false/);
  assert.match(source, /fitContent\(\)/);
});

test("classifies rating and target changes for semantic list colors", () => {
  const raised = analystEvent({
    actionCompany: "Maintains",
    actionPriceTarget: "Raises",
    ratingPrior: "Neutral",
    ratingCurrent: "Outperform",
    adjustedPreviousPriceTarget: 155,
    effectivePriceTarget: 175,
  });
  assert.equal(analystRatingChangeTone(raised), "positive");
  assert.equal(analystTargetChangeTone(raised), "positive");

  const lowered = analystEvent({
    actionCompany: "Downgrades",
    actionPriceTarget: "Lowers",
    ratingPrior: "Buy",
    ratingCurrent: "Underperform",
    previousPriceTarget: 180,
    effectivePriceTarget: 140,
  });
  assert.equal(analystRatingChangeTone(lowered), "negative");
  assert.equal(analystTargetChangeTone(lowered), "negative");

  const reiterated = analystEvent({
    actionCompany: "Reiterates",
    actionPriceTarget: "Maintains",
    ratingPrior: "Buy",
    ratingCurrent: "Buy",
    previousPriceTarget: 175,
    effectivePriceTarget: 175,
  });
  assert.equal(analystRatingChangeTone(reiterated), "neutral");
  assert.equal(analystTargetChangeTone(reiterated), "neutral");
  assert.equal(analystTargetChangeTone(analystEvent({ actionPriceTarget: "Lowers" })), "negative");
});

test("wires semantic change tones into the visible analyst history table", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /analyst-change-\$\{analystRatingChangeTone\(event\)\}/);
  assert.match(pageSource, /analyst-target-cell analyst-change-\$\{analystTargetChangeTone\(event\)\}/);
});
