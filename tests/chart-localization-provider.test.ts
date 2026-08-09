import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  chartLocaleTag,
  formatChartDate,
} from "../app/features/chart-localization";

test("maps Unicorn locale to an explicit Lightweight Charts locale", () => {
  assert.equal(chartLocaleTag("en"), "en-US");
  assert.equal(chartLocaleTag("ja"), "ja-JP");
});

test("formats chart date-only values in the selected locale without shifting the day", () => {
  assert.equal(formatChartDate("2026-08-09", "en"), "Aug 9, 2026");
  assert.equal(formatChartDate("2026-08-09", "ja"), "2026年8月9日");
  assert.equal(formatChartDate("not-a-date", "en"), "not-a-date");
});

test("every feature-owned Lightweight Charts instance receives the selected locale", async () => {
  const sources = await Promise.all([
    readFile(new URL("../app/features/stock-detail/StockDetailCharts.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/chart-indicators/SubIndicatorPanes.tsx", import.meta.url), "utf8"),
  ]);
  for (const source of sources) {
    const chartCalls = source.match(/createChart\(/g) ?? [];
    assert.ok(chartCalls.length > 0);
    assert.match(source, /localization:\s*\{\s*locale:\s*chartLocaleTag\(locale\)\s*\}/);
  }
});

test("the main price and strategy charts also receive the selected locale", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const chartCalls = source.match(/createChart\(/g) ?? [];
  const localizedCalls = source.match(/localization:\s*\{\s*locale:\s*chartLocaleTag\(locale\)\s*\}/g) ?? [];

  assert.equal(chartCalls.length, 3);
  assert.equal(localizedCalls.length, chartCalls.length);
  assert.match(source, /\[activeIndicators, chartType, fullData, indicatorSettings, locale, marketBars, priceLineColor, range\]/);
  assert.match(source, /\[locale, mode, period, seed\]/);
  assert.match(source, /\[locale, seed\]/);
});

test("English indicator readouts do not use the Japanese compact-number locale", async () => {
  const source = await readFile(
    new URL("../app/features/chart-indicators/SubIndicatorPanes.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const localeTag = chartLocaleTag\(locale\)/);
  assert.doesNotMatch(source, /Intl\.NumberFormat\("ja-JP"/);
  assert.doesNotMatch(source, /toLocaleString\("ja-JP"/);
});
