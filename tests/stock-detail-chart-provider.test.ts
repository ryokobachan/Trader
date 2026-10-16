import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AnalystTargetReadout,
  actualStockPricePointAtOrBefore,
  analystHistoryDataStartDate,
  analystRatingChangeTone,
  analystTargetPointAtOrBefore,
  analystTargetChangeTone,
  analystTargetRightOffsetPixels,
  buildAnalystTargetPoints,
  buildActualStockPricePoints,
  buildCurrentAnalystTargets,
  extendAnalystTargetPointsToActualPrice,
} from "../src/app/features/stock-detail/StockDetailCharts";
import { I18nProvider, translate } from "../src/app/platform/i18n";
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

test("starts the displayed analyst history range at the oldest returned data row", () => {
  assert.equal(analystHistoryDataStartDate([
    analystEvent({ sourceEventDate: "2026-08-12" }),
    analystEvent({ sourceEventDate: "2025-01-13" }),
    analystEvent({ sourceEventDate: "2026-02-18" }),
    analystEvent({ sourceEventDate: "not-a-date" }),
  ]), "2025-01-13");
  assert.equal(analystHistoryDataStartDate([]), undefined);
});

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

test("excludes future actual-price bars before charting or extending targets", () => {
  const points = buildActualStockPricePoints([
    bar("2026-08-12T20:00:00.000Z", 190),
    bar("2026-08-14T20:00:00.000Z", 999),
  ], "2026-08-13");

  assert.deepEqual(points, [{ date: "2026-08-12", close: 190 }]);
  assert.equal(points.at(-1)?.close, 190);
  assert.deepEqual(buildActualStockPricePoints([bar("2026-08-12", 190)], "invalid-date"), []);
});

test("resolves actual closes across non-trading dates without looking ahead", () => {
  const friday = { date: "2026-08-07", close: 190 };
  const monday = { date: "2026-08-10", close: 195 };
  const points = [friday, monday];

  assert.equal(actualStockPricePointAtOrBefore(points, "2026-08-06"), undefined);
  assert.equal(actualStockPricePointAtOrBefore(points, "2026-08-07"), friday);
  assert.equal(actualStockPricePointAtOrBefore(points, "2026-08-08"), friday);
  assert.equal(actualStockPricePointAtOrBefore(points, "2026-08-09"), friday);
  assert.equal(actualStockPricePointAtOrBefore(points, "2026-08-10"), monday);
  assert.equal(actualStockPricePointAtOrBefore(points, "not-a-date"), undefined);
});

test("rebuilds old rolling target observations while excluding future events", () => {
  const points = buildAnalystTargetPoints([
    analystEvent({
      eventId: "expired",
      analystFirm: "Old Research",
      sourceEventDate: "2025-08-12",
      eventTime: "2025-08-12T12:00:00.000Z",
      effectivePriceTarget: 120,
    }),
    analystEvent({
      eventId: "boundary",
      analystFirm: "Boundary Research",
      sourceEventDate: "2025-08-13",
      eventTime: "2025-08-13T12:00:00.000Z",
      effectivePriceTarget: 180,
    }),
    analystEvent({
      eventId: "inside",
      analystFirm: "Inside Research",
      sourceEventDate: "2025-08-14",
      eventTime: "2025-08-14T12:00:00.000Z",
      effectivePriceTarget: 190,
    }),
    analystEvent({
      eventId: "recent",
      analystFirm: "Recent Research",
      sourceEventDate: "2026-08-12",
      eventTime: "2026-08-12T12:00:00.000Z",
      effectivePriceTarget: 240,
    }),
    analystEvent({
      eventId: "future",
      analystFirm: "Future Research",
      sourceEventDate: "2026-08-14",
      eventTime: "2026-08-14T12:00:00.000Z",
      effectivePriceTarget: 999,
    }),
  ], 365, "2026-08-13");

  assert.deepEqual(points.map((point) => point.date), [
    "2025-08-12",
    "2025-08-13",
    "2025-08-14",
    "2026-08-12",
  ]);
  assert.deepEqual(points.at(-1), {
    date: "2026-08-12",
    low: 180,
    average: 203.33333333333334,
    high: 240,
    analystCount: 3,
  });
  assert.equal(points.some((point) => point.high === 999), false);
  assert.deepEqual(buildAnalystTargetPoints([], 365, "invalid-date"), []);
});

test("uses an exact three-calendar-month window for merged analyst coverage", () => {
  const items = [
    analystEvent({
      eventId: "before-calendar-cutoff",
      canonicalFirmId: "firm:before",
      analystFirm: "Before Research",
      sourceEventDate: "2026-05-15",
      eventTime: "2026-05-15T12:00:00.000Z",
      effectivePriceTarget: 100,
    }),
    analystEvent({
      eventId: "calendar-cutoff",
      canonicalFirmId: "firm:boundary",
      analystFirm: "Boundary Research",
      sourceEventDate: "2026-05-16",
      eventTime: "2026-05-16T12:00:00.000Z",
      effectivePriceTarget: 200,
    }),
    analystEvent({
      eventId: "recent-calendar",
      canonicalFirmId: "firm:recent",
      analystFirm: "Recent Research",
      sourceEventDate: "2026-08-15",
      eventTime: "2026-08-15T12:00:00.000Z",
      effectivePriceTarget: 300,
    }),
  ];

  const current = buildCurrentAnalystTargets(items, "2026-08-16", 365, 3);
  const points = buildAnalystTargetPoints(items, 365, "2026-08-16", 3);
  assert.deepEqual(current.map((item) => item.priceTarget).sort(), [200, 300]);
  assert.deepEqual(points.map((point) => point.date), [
    "2026-05-15",
    "2026-05-16",
    "2026-08-15",
  ]);
  assert.equal(points[0]?.average, 100);
  assert.equal(points.at(-1)?.average, 200);
  assert.equal(points.at(-1)?.analystCount, 3);
});

test("anchors the one-year target cutoff to dateTo rather than the previous trading day", () => {
  const dateTo = "2026-08-13";
  const actualPrices = buildActualStockPricePoints([
    bar("2026-08-12T20:00:00.000Z", 190),
  ], dateTo);
  const targetPoints = buildAnalystTargetPoints([
    analystEvent({
      eventId: "date-to-boundary",
      analystFirm: "Boundary Research",
      sourceEventDate: "2025-08-13",
      eventTime: "2025-08-13T12:00:00.000Z",
      effectivePriceTarget: 180,
    }),
    analystEvent({
      eventId: "inside-date-to-window",
      analystFirm: "Inside Research",
      sourceEventDate: "2025-08-14",
      eventTime: "2025-08-14T12:00:00.000Z",
      effectivePriceTarget: 190,
    }),
  ], 365, dateTo);
  const currentTargets = buildCurrentAnalystTargets([
    analystEvent({
      eventId: "date-to-boundary",
      analystFirm: "Boundary Research",
      sourceEventDate: "2025-08-13",
      eventTime: "2025-08-13T12:00:00.000Z",
      effectivePriceTarget: 180,
    }),
    analystEvent({
      eventId: "inside-date-to-window",
      analystFirm: "Inside Research",
      sourceEventDate: "2025-08-14",
      eventTime: "2025-08-14T12:00:00.000Z",
      effectivePriceTarget: 190,
    }),
  ], dateTo);

  assert.equal(actualPrices.at(-1)?.date, "2026-08-12");
  assert.deepEqual(currentTargets.map((item) => item.priceTarget), [190]);
  assert.deepEqual(targetPoints.map((point) => point.date), ["2025-08-13", "2025-08-14"]);
  assert.equal(targetPoints[1]?.average, 185);
});

test("builds the current target list from each identified analyst or firm's latest fresh event", () => {
  const current = buildCurrentAnalystTargets([
    analystEvent({
      eventId: "alpha-old",
      firmId: "firm-alpha",
      analystId: "analyst-alpha",
      analystFirm: "Alpha Research",
      sourceEventDate: "2026-08-01",
      eventTime: "2026-08-01T12:00:00.000Z",
      effectivePriceTarget: 180,
    }),
    analystEvent({
      eventId: "alpha-current",
      firmId: "FIRM-ALPHA",
      analystId: "ANALYST-ALPHA",
      analystFirm: "Alpha Research",
      sourceEventDate: "2026-08-10",
      eventTime: "2026-08-10T12:00:00.000Z",
      effectivePriceTarget: 200,
    }),
    analystEvent({
      eventId: "firm-level-old",
      analystFirm: "Firm Level Research",
      sourceEventDate: "2026-08-05",
      eventTime: "2026-08-05T12:00:00.000Z",
      effectivePriceTarget: 190,
    }),
    analystEvent({
      eventId: "firm-level-current",
      analystFirm: "Firm Level Research",
      sourceEventDate: "2026-08-11",
      eventTime: "2026-08-11T12:00:00.000Z",
      effectivePriceTarget: 210,
    }),
    analystEvent({
      eventId: "withdrawn-old",
      analystFirm: "Withdrawn Research",
      sourceEventDate: "2026-08-09",
      eventTime: "2026-08-09T12:00:00.000Z",
      effectivePriceTarget: 220,
    }),
    analystEvent({
      eventId: "withdrawn-current",
      analystFirm: "Withdrawn Research",
      sourceEventDate: "2026-08-12",
      eventTime: "2026-08-12T12:00:00.000Z",
    }),
    analystEvent({
      eventId: "non-usd-old",
      analystFirm: "Currency Research",
      sourceEventDate: "2026-08-08",
      eventTime: "2026-08-08T12:00:00.000Z",
      currency: "USD",
      effectivePriceTarget: 230,
    }),
    analystEvent({
      eventId: "non-usd-current",
      analystFirm: "Currency Research",
      sourceEventDate: "2026-08-12",
      eventTime: "2026-08-12T13:00:00.000Z",
      currency: "EUR",
      effectivePriceTarget: 999,
    }),
    analystEvent({
      eventId: "analyst-only",
      analystId: "solo-analyst",
      analystName: "Solo Analyst",
      sourceEventDate: "2026-08-09",
      eventTime: "2026-08-09T12:00:00.000Z",
      adjustedPriceTarget: 205,
    }),
    analystEvent({
      eventId: "expired",
      analystFirm: "Expired Research",
      sourceEventDate: "2025-08-13",
      eventTime: "2025-08-13T12:00:00.000Z",
      effectivePriceTarget: 150,
    }),
    analystEvent({
      eventId: "future",
      analystFirm: "Future Research",
      sourceEventDate: "2026-08-14",
      eventTime: "2026-08-14T12:00:00.000Z",
      effectivePriceTarget: 300,
    }),
    analystEvent({
      eventId: "anonymous",
      sourceEventDate: "2026-08-13",
      eventTime: "2026-08-13T12:00:00.000Z",
      effectivePriceTarget: 250,
    }),
  ], "2026-08-13");

  assert.deepEqual(current.map(({ event }) => event.eventId), [
    "firm-level-current",
    "alpha-current",
    "analyst-only",
  ]);
  assert.deepEqual(current.map(({ priceTarget }) => priceTarget), [210, 200, 205]);
  assert.deepEqual(buildCurrentAnalystTargets([], "invalid-date"), []);
});

test("carries target consensus forward for strictly less than 365 calendar days", () => {
  const first = { date: "2024-12-20", low: 180, average: 200, high: 220, analystCount: 12 };
  const second = { date: "2025-01-01", low: 185, average: 205, high: 225, analystCount: 13 };
  const points = [first, second];

  assert.equal(analystTargetPointAtOrBefore(points, "2024-12-19"), undefined);
  assert.equal(analystTargetPointAtOrBefore(points, "2024-12-20"), first);
  assert.equal(analystTargetPointAtOrBefore(points, "2024-12-31"), first);
  assert.equal(analystTargetPointAtOrBefore(points, "2025-01-01"), second);
  assert.equal(analystTargetPointAtOrBefore(points, "2025-12-31"), second);
  assert.equal(analystTargetPointAtOrBefore(points, "2026-01-01"), undefined);
  assert.equal(analystTargetPointAtOrBefore(points, "not-a-date"), undefined);
});

test("extends the step target line only while the latest target is fresh", () => {
  const points = [
    { date: "2024-12-20", low: 180, average: 200, high: 220, analystCount: 12 },
    { date: "2025-01-01", low: 185, average: 205, high: 225, analystCount: 13 },
  ];
  const extended = extendAnalystTargetPointsToActualPrice(points, [
    { date: "2025-12-31", close: 202 },
  ]);
  assert.deepEqual(extended.at(-1), { ...points[1], date: "2025-12-31" });
  assert.equal(points.length, 2);

  const expired = extendAnalystTargetPointsToActualPrice(points, [
    { date: "2026-01-01", close: 208 },
  ]);
  assert.equal(expired, points);

  const beforeObservation = extendAnalystTargetPointsToActualPrice(points, [
    { date: "2024-12-31", close: 199 },
  ]);
  assert.equal(beforeObservation, points);
});

test("keeps all five target readout rows mounted while hover values change", () => {
  const renderReadout = (actualPrice?: number) => renderToStaticMarkup(createElement(
    I18nProvider,
    { initialLocale: "en" },
    createElement(AnalystTargetReadout, {
      readout: {
        date: "2026-08-12",
        low: 180,
        average: 200,
        high: 220,
        actualPrice,
        analystCount: 12,
      },
    }),
  ));
  const withoutActual = renderReadout();
  const withActual = renderReadout(205);
  const readoutRowCount = (html: string) => [...html.matchAll(/<(?:small|b|em)(?:\s|>)/g)].length;

  assert.equal(readoutRowCount(withoutActual), 5);
  assert.equal(readoutRowCount(withActual), 5);
  assert.match(withoutActual, /class="analyst-target-actual-readout">\u00a0<\/em>/);
  assert.match(withActual, /Actual price \$205\.00/);
});

test("renders actual closes as their own chart series and crosshair readout", async () => {
  const source = await readFile(
    new URL("../src/app/features/stock-detail/StockDetailCharts.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /marketBars:\s*readonly MarketBar\[\]/);
  assert.match(source, /buildActualStockPricePoints\(marketBars, history\?\.dateTo\)/);
  assert.match(source, /history\?\.consensusItems \?\? history\?\.items/);
  assert.match(source, /buildAnalystTargetPoints\([\s\S]*history\?\.consensusLookbackMonths/);
  assert.match(source, /title:\s*t\("detail\.chart\.target\.actualSeries"\)/);
  assert.match(source, /actualPrice\.setData\(actualPrices/);
  assert.match(source, /subscribeCrosshairMove/);
  assert.match(source, /actualStockPricePointAtOrBefore\(actualPrices, date\)/);
  assert.match(source, /analystTargetPointAtOrBefore\(points, date\)/);
  assert.match(source, /lineType:\s*LineType\.WithSteps/);
  assert.match(source, /extendAnalystTargetPointsToActualPrice\(points, actualPrices\)/);
  assert.match(source, /latestReadoutDate = latestActualPrice\?\.date \?\? latest\?\.date/);
  assert.match(source, /actualPrice: latestActualPrice\?\.close/);
  assert.match(source, /className="analyst-target-actual-readout"/);
  assert.match(source, /detail\.chart\.target\.aria/);
  assert.doesNotMatch(source, /createPriceLine/);
});

test("refreshes analyst history on tab activation, expiry, and visibility resume", async () => {
  const [pageSource, routeSource] = await Promise.all([
    readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/api/v1/symbols/[symbol]/analyst-ratings/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(pageSource, /activeStockDetailSection === "analyst"/);
  assert.match(pageSource, /setAnalystHistoryRefreshNonce/);
  assert.match(pageSource, /params\.set\("fresh", "1"\)/);
  assert.match(pageSource, /cache:\s*"no-store"/);
  assert.match(pageSource, /ANALYST_HISTORY_REFRESH_MS/);
  assert.match(pageSource, /history\.consensusItems \?\? history\.items/);
  assert.match(pageSource, /analystHistoryDataStartDate\(analystHistory\?\.items \?\? \[\]\)/);
  assert.doesNotMatch(pageSource, /analystHistory\?\.dateFrom/);
  assert.match(pageSource, /event\.analystStarRating\.toFixed\(1\)\} ★/);
  assert.match(pageSource, /Smart \$\{event\.smartScore\.toFixed\(1\)\}/);
  assert.match(pageSource, /addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(routeSource, /fresh === "1" \? "private, no-store"/);
  assert.match(routeSource, /fresh === "1" \? \{ fresh: true \} : \{\}/);
  assert.match(routeSource, /signal:\s*request\.signal/);
  assert.match(routeSource, /timeZone:\s*"America\/New_York"/);
  assert.match(pageSource, /const dateTo = newYorkCalendarDate\(today\)/);
});

test("localizes analyst and earnings chart copy in English and Japanese", async () => {
  assert.equal(translate("en", "detail.chart.target.title"), "Price target consensus over time");
  assert.equal(translate("ja", "detail.chart.target.title"), "目標価格コンセンサスの推移");
  assert.equal(
    translate("ja", "detail.chart.target.methodologyMonths", { count: 3 }),
    "各時点で直近3か月の利用可能な最新レーティングをanalyst／firm単位に集計",
  );
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
  assert.equal((source.match(/const \{ locale, t \} = useI18n\(\)/g) ?? []).length, 3);
  assert.match(source, /localization:\s*\{\s*locale:\s*chartLocaleTag\(locale\)\s*\}/);
  assert.match(source, /formatChartDate\(readout\.date, locale\)/);
  assert.match(source, /formatChartDate\(chartStartDate, locale\)/);
  assert.match(source, /detail\.chart\.earnings\.metricAria/);
  assert.match(source, /detail\.chart\.earnings\.aria/);
  assert.match(source, /minimumFractionDigits:\s*2/);
});

test("keeps US equity chart prices at two decimal places", async () => {
  const source = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(source, /const priceFormat = stock\.currency === "\$"/);
  assert.match(source, /runtime\.candleSeries\.applyOptions\(\{[\s\S]*priceFormat/);
  assert.match(source, /precision:\s*2,\s*minMove:\s*0\.01/);
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
  assert.match(pageSource, /detail\.analyst\.table\.ratingPrevious/);
  assert.match(pageSource, /detail\.analyst\.table\.ratingCurrent/);
  assert.match(pageSource, /analyst-rating-previous[^>]*>\{event\.ratingPrior \?\? "—"\}/);
  assert.match(pageSource, />\{ratingCurrent \?\? "—"\}<\/td>/);
  assert.match(pageSource, /const targetChangeTone = analystTargetChangeTone\(event\)/);
  assert.match(pageSource, /analyst-target-cell analyst-change-\$\{targetChangeTone\}/);
  assert.match(pageSource, /detail\.analyst\.table\.targetPrevious/);
  assert.match(pageSource, /detail\.analyst\.table\.targetCurrent/);
});
