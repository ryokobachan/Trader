"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  LineSeries,
  LineStyle,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from "lightweight-charts";
import type {
  AnalystRatingEvent,
  AnalystRatingHistory,
  EarningsEvent,
  MarketBar,
} from "../../platform/provider-contracts";
import { useI18n, type Locale } from "../../platform/i18n";
import { chartLocaleTag, formatChartDate } from "../chart-localization";

const DAY_MS = 86_400_000;
const ANALYST_TARGET_VALIDITY_DAYS = 365;

export type AnalystChangeTone = "positive" | "negative" | "neutral";

export type AnalystTargetPoint = Readonly<{
  date: string;
  low: number;
  average: number;
  high: number;
  analystCount: number;
}>;

export type ActualStockPricePoint = Readonly<{
  date: string;
  close: number;
}>;

type AnalystChartReadout = Readonly<{
  date: string;
  low?: number;
  average?: number;
  high?: number;
  actualPrice?: number;
  analystCount?: number;
}>;

type AnalystCrosshairReadout = Readonly<{
  dataKey: string;
  value: AnalystChartReadout;
}>;

type AnalystTargetChartResources = Readonly<{
  chart: IChartApi;
  low: ISeriesApi<"Line">;
  average: ISeriesApi<"Line">;
  high: ISeriesApi<"Line">;
  actualPrice: ISeriesApi<"Line">;
}>;

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isoCalendarDayTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : undefined;
}

function analystTargetIsFresh(targetDate: string, actualDate: string) {
  const targetTimestamp = isoCalendarDayTimestamp(targetDate);
  const actualTimestamp = isoCalendarDayTimestamp(actualDate);
  if (targetTimestamp === undefined || actualTimestamp === undefined || actualTimestamp < targetTimestamp) {
    return false;
  }
  return actualTimestamp - targetTimestamp <= ANALYST_TARGET_VALIDITY_DAYS * DAY_MS;
}

function normalizedAnalystLabel(value: string | undefined) {
  return value?.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim() ?? "";
}

function actionChangeTone(value: string | undefined): AnalystChangeTone {
  const normalized = normalizedAnalystLabel(value);
  if (/\b(upgrade|upgrades|upgraded|raise|raises|raised|increase|increases|increased)\b/.test(normalized)) {
    return "positive";
  }
  if (/\b(downgrade|downgrades|downgraded|lower|lowers|lowered|decrease|decreases|decreased)\b/.test(normalized)) {
    return "negative";
  }
  return "neutral";
}

function ratingScore(value: string | undefined) {
  const normalized = normalizedAnalystLabel(value);
  if (!normalized) return undefined;
  if (/\bstrong sell\b/.test(normalized)) return 0;
  if (/\b(sell|bearish)\b/.test(normalized)) return 1;
  if (/\b(underperform|underweight|reduce|negative)\b/.test(normalized)) return 2;
  if (/\b(hold|neutral|market perform|sector perform|equal weight|in line|mixed)\b/.test(normalized)) return 3;
  if (/\b(outperform|overweight|accumulate|positive)\b/.test(normalized)) return 4;
  if (/\bstrong buy\b/.test(normalized)) return 5;
  if (/\bbuy\b/.test(normalized)) return 4;
  return undefined;
}

/**
 * Classify a rating revision without relying on provider-specific CSS labels.
 * Benzinga's explicit company action wins; otherwise known rating buckets are
 * compared. Unknown or initiated coverage remains neutral.
 */
export function analystRatingChangeTone(event: AnalystRatingEvent): AnalystChangeTone {
  const actionTone = actionChangeTone(event.actionCompany);
  if (actionTone !== "neutral") return actionTone;
  const current = ratingScore(event.ratingCurrent ?? event.rating);
  const previous = ratingScore(event.ratingPrior);
  if (current === undefined || previous === undefined || current === previous) return "neutral";
  return current > previous ? "positive" : "negative";
}

/** Compare normalized targets first and use Benzinga's target action as a fallback. */
export function analystTargetChangeTone(event: AnalystRatingEvent): AnalystChangeTone {
  const current = event.effectivePriceTarget ?? event.adjustedPriceTarget ?? event.priceTarget;
  const previous = event.adjustedPreviousPriceTarget ?? event.previousPriceTarget;
  if (finitePositive(current) && finitePositive(previous)) {
    if (current > previous) return "positive";
    if (current < previous) return "negative";
    return "neutral";
  }
  return actionChangeTone(event.actionPriceTarget);
}

/** Keep future/readability space visually stable across responsive chart widths. */
export function analystTargetRightOffsetPixels(width: number) {
  const finiteWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  return Math.round(Math.min(128, Math.max(56, finiteWidth * 0.14)));
}

function eventIdentity(event: AnalystRatingEvent) {
  const firm = event.firmId || event.analystFirm || "unknown-firm";
  const analyst = event.analystId || event.analystName || event.eventId;
  return `${firm}\u0000${analyst}`;
}

/**
 * Rebuild a trailing consensus from Midas-normalized Benzinga events.
 * Each point keeps the latest event per analyst/firm observed in the prior year.
 */
export function buildAnalystTargetPoints(
  items: readonly AnalystRatingEvent[],
  trailingDays = 365,
): readonly AnalystTargetPoint[] {
  const events = [...items]
    .filter((event) => /^\d{4}-\d{2}-\d{2}$/.test(event.sourceEventDate))
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  const byDate = new Map<string, AnalystRatingEvent[]>();
  for (const event of events) {
    const current = byDate.get(event.sourceEventDate) ?? [];
    current.push(event);
    byDate.set(event.sourceEventDate, current);
  }

  const active = new Map<string, Readonly<{ target: number; eventTime: number }>>();
  const points: AnalystTargetPoint[] = [];
  for (const [date, dateEvents] of [...byDate].sort(([left], [right]) => left.localeCompare(right))) {
    for (const event of dateEvents) {
      const identity = eventIdentity(event);
      if (finitePositive(event.effectivePriceTarget) && (!event.currency || event.currency === "USD")) {
        active.set(identity, {
          target: event.effectivePriceTarget,
          eventTime: Date.parse(event.eventTime),
        });
      } else {
        active.delete(identity);
      }
    }

    const dateMilliseconds = Date.parse(`${date}T23:59:59Z`);
    const oldestAllowed = dateMilliseconds - trailingDays * DAY_MS;
    for (const [identity, value] of active) {
      if (!Number.isFinite(value.eventTime) || value.eventTime < oldestAllowed) active.delete(identity);
    }
    const targets = [...active.values()].map((value) => value.target);
    if (targets.length === 0) continue;
    points.push(Object.freeze({
      date,
      low: Math.min(...targets),
      average: targets.reduce((sum, value) => sum + value, 0) / targets.length,
      high: Math.max(...targets),
      analystCount: targets.length,
    }));
  }
  return Object.freeze(points);
}

/**
 * Resolve the last observed consensus on or before an ISO calendar date.
 * `points` is the ascending, de-duplicated output of buildAnalystTargetPoints.
 * Dates before the first observation deliberately return no value.
 */
export function analystTargetPointAtOrBefore(
  points: readonly AnalystTargetPoint[],
  date: string,
): AnalystTargetPoint | undefined {
  if (isoCalendarDayTimestamp(date) === undefined || points.length === 0) return undefined;
  let left = 0;
  let right = points.length - 1;
  let match: AnalystTargetPoint | undefined;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const point = points[middle];
    if (point.date <= date) {
      match = point;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return match && analystTargetIsFresh(match.date, date) ? match : undefined;
}

export function extendAnalystTargetPointsToActualPrice(
  points: readonly AnalystTargetPoint[],
  actualPrices: readonly ActualStockPricePoint[],
): readonly AnalystTargetPoint[] {
  const latestTarget = points.at(-1);
  const latestActual = actualPrices.at(-1);
  if (
    !latestTarget
    || !latestActual
    || latestActual.date <= latestTarget.date
    || !analystTargetIsFresh(latestTarget.date, latestActual.date)
  ) return points;
  return Object.freeze([
    ...points,
    Object.freeze({ ...latestTarget, date: latestActual.date }),
  ]);
}

function marketBarDate(time: string) {
  const timestamp = Date.parse(time);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp).toISOString().slice(0, 10);
  return { date, timestamp };
}

/**
 * Normalize mixed intraday/daily bars to one observed close per UTC day.
 * When more than one bar exists for a day, the chronologically last bar wins.
 * Missing days are intentionally left missing rather than interpolated.
 */
export function buildActualStockPricePoints(
  marketBars: readonly MarketBar[],
): readonly ActualStockPricePoint[] {
  const byDate = new Map<string, Readonly<{
    close: number;
    timestamp: number;
    sourceIndex: number;
  }>>();
  marketBars.forEach((bar, sourceIndex) => {
    const normalizedTime = marketBarDate(bar.time);
    if (!normalizedTime || !finitePositive(bar.close)) return;
    const current = byDate.get(normalizedTime.date);
    if (
      !current
      || normalizedTime.timestamp > current.timestamp
      || (normalizedTime.timestamp === current.timestamp && sourceIndex > current.sourceIndex)
    ) {
      byDate.set(normalizedTime.date, {
        close: bar.close,
        timestamp: normalizedTime.timestamp,
        sourceIndex,
      });
    }
  });
  return Object.freeze(
    [...byDate]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, value]) => Object.freeze({ date, close: value.close })),
  );
}

function chartTimeDate(time: Time) {
  if (typeof time === "string") return time.slice(0, 10);
  if (typeof time === "number") return new Date(time * 1_000).toISOString().slice(0, 10);
  const month = String(time.month).padStart(2, "0");
  const day = String(time.day).padStart(2, "0");
  return `${time.year}-${month}-${day}`;
}

function lineSeriesValue(data: unknown) {
  if (!data || typeof data !== "object" || !("value" in data)) return undefined;
  const value = (data as Readonly<{ value?: unknown }>).value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function chartBase(host: HTMLDivElement, locale: Locale) {
  return createChart(host, {
    width: Math.max(1, host.clientWidth),
    height: Math.max(180, host.clientHeight),
    layout: {
      background: { type: ColorType.Solid, color: "#08090b" },
      textColor: "#a8adb7",
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
      fontSize: 12,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: "#17191e" },
      horzLines: { color: "#17191e" },
    },
    rightPriceScale: {
      borderColor: "#2a2d35",
      scaleMargins: { top: 0.12, bottom: 0.12 },
    },
    timeScale: {
      borderColor: "#2a2d35",
      timeVisible: false,
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    crosshair: {
      vertLine: { color: "#737985", labelBackgroundColor: "#252932" },
      horzLine: { color: "#737985", labelBackgroundColor: "#252932" },
    },
    localization: { locale: chartLocaleTag(locale) },
  });
}

function observeChartResize(
  host: HTMLDivElement,
  chart: ReturnType<typeof createChart>,
  onResize?: (width: number) => void,
) {
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const width = Math.max(1, Math.floor(entry.contentRect.width));
    chart.applyOptions({
      width,
      height: Math.max(180, Math.floor(entry.contentRect.height)),
    });
    onResize?.(width);
  });
  observer.observe(host);
  return observer;
}

function currency(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "ja" ? "ja-JP" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function AnalystTargetHistoryChart({
  history,
  marketBars,
}: {
  history: AnalystRatingHistory | null;
  marketBars: readonly MarketBar[];
}) {
  const { locale, t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const resourcesRef = useRef<AnalystTargetChartResources | null>(null);
  const [crosshairReadout, setCrosshairReadout] = useState<AnalystCrosshairReadout | null>(null);
  const points = useMemo(
    () => buildAnalystTargetPoints(history?.items ?? []),
    [history],
  );
  const actualPrices = useMemo(() => {
    const allPrices = buildActualStockPricePoints(marketBars);
    const firstTargetDate = points[0]?.date;
    if (!firstTargetDate) return Object.freeze([]) as readonly ActualStockPricePoint[];
    return Object.freeze(
      allPrices.filter((point) => point.date >= firstTargetDate),
    );
  }, [marketBars, points]);
  const plottedTargetPoints = useMemo(
    () => extendAnalystTargetPointsToActualPrice(points, actualPrices),
    [actualPrices, points],
  );
  const latest = points.at(-1);
  const latestActualPrice = actualPrices.at(-1);
  const targetDataKey = useMemo(() => [
    history?.instrumentId ?? "",
    ...points.map((point) => [
      point.date,
      point.low,
      point.average,
      point.high,
      point.analystCount,
    ].join(":")),
  ].join("|"), [history?.instrumentId, points]);
  const activeCrosshairReadout = crosshairReadout?.dataKey === targetDataKey
    ? crosshairReadout.value
    : null;
  const displayedReadout: AnalystChartReadout | null = activeCrosshairReadout ?? (latest ? {
    date: latest.date,
    low: latest.low,
    average: latest.average,
    high: latest.high,
    analystCount: latest.analystCount,
  } : null);

  const hasPoints = points.length > 0;

  // Own the chart instance for the lifetime of this dataset surface. Data,
  // locale, and crosshair subscriptions update independently so routine live
  // refreshes do not remove and recreate the canvas.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasPoints) return;
    const chart = chartBase(host, "en");
    const low = chart.addSeries(LineSeries, {
      color: "#f0a15a",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    const high = chart.addSeries(LineSeries, {
      color: "#37c982",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    const actualPrice = chart.addSeries(LineSeries, {
      color: "#f4f5f7",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    // The average is the primary series. Add it last so equal low/high/actual
    // values cannot paint over the blue consensus line.
    const average = chart.addSeries(LineSeries, {
      color: "#4f8cff",
      lineWidth: 2,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    resourcesRef.current = { chart, low, average, high, actualPrice };

    const applyRightSideSpace = (width: number) => {
      chart.timeScale().applyOptions({
        rightOffsetPixels: analystTargetRightOffsetPixels(width),
        fixRightEdge: false,
      });
    };
    applyRightSideSpace(host.clientWidth);
    const observer = observeChartResize(host, chart, applyRightSideSpace);
    return () => {
      observer.disconnect();
      if (resourcesRef.current?.chart === chart) resourcesRef.current = null;
      chart.remove();
    };
  }, [hasPoints]);

  useEffect(() => {
    const resources = resourcesRef.current;
    if (!resources) return;
    resources.chart.applyOptions({ localization: { locale: chartLocaleTag(locale) } });
    resources.low.applyOptions({ title: t("detail.chart.target.lowSeries") });
    resources.average.applyOptions({ title: t("detail.chart.target.averageSeries") });
    resources.high.applyOptions({ title: t("detail.chart.target.highSeries") });
    resources.actualPrice.applyOptions({ title: t("detail.chart.target.actualSeries") });
  }, [hasPoints, locale, t]);

  useEffect(() => {
    const resources = resourcesRef.current;
    if (!resources) return;
    resources.low.setData(plottedTargetPoints.map((point) => ({ time: point.date as Time, value: point.low })));
    resources.average.setData(plottedTargetPoints.map((point) => ({ time: point.date as Time, value: point.average })));
    resources.high.setData(plottedTargetPoints.map((point) => ({ time: point.date as Time, value: point.high })));
    resources.actualPrice.setData(actualPrices.map((point) => ({ time: point.date as Time, value: point.close })));
    resources.chart.timeScale().fitContent();
  }, [actualPrices, hasPoints, plottedTargetPoints]);

  useEffect(() => {
    const resources = resourcesRef.current;
    if (!resources) return;
    const handleCrosshairMove: Parameters<IChartApi["subscribeCrosshairMove"]>[0] = (parameter) => {
      if (!parameter.time) {
        setCrosshairReadout(null);
        return;
      }
      const date = chartTimeDate(parameter.time);
      const targetPoint = analystTargetPointAtOrBefore(points, date);
      setCrosshairReadout({
        dataKey: targetDataKey,
        value: {
          date,
          low: targetPoint?.low,
          average: targetPoint?.average,
          high: targetPoint?.high,
          actualPrice: lineSeriesValue(parameter.seriesData.get(resources.actualPrice)),
          analystCount: targetPoint?.analystCount,
        },
      });
    };
    resources.chart.subscribeCrosshairMove(handleCrosshairMove);
    return () => {
      if (resourcesRef.current?.chart === resources.chart) {
        resources.chart.unsubscribeCrosshairMove(handleCrosshairMove);
      }
    };
  }, [hasPoints, points, targetDataKey]);

  if (!history || !hasPoints) return null;
  return (
    <section className="detail-visual-card analyst-target-visual">
      <header>
        <div><span>PRICE TARGET HISTORY</span><strong>{t("detail.chart.target.title")}</strong></div>
        {displayedReadout && (
          <div className="analyst-target-readout" role="status" aria-live="polite">
            <small>{formatChartDate(displayedReadout.date, locale)}</small>
            {displayedReadout.average !== undefined && <b>{t("detail.chart.target.averageReadout", { value: currency(displayedReadout.average, locale) })}</b>}
            {(displayedReadout.low !== undefined || displayedReadout.high !== undefined) && (
              <em>
                {displayedReadout.low !== undefined ? t("detail.chart.target.lowReadout", { value: currency(displayedReadout.low, locale) }) : ""}
                {displayedReadout.low !== undefined && displayedReadout.high !== undefined ? " · " : ""}
                {displayedReadout.high !== undefined ? t("detail.chart.target.highReadout", { value: currency(displayedReadout.high, locale) }) : ""}
              </em>
            )}
            {displayedReadout.actualPrice !== undefined && <em>{t("detail.chart.target.actualReadout", { value: currency(displayedReadout.actualPrice, locale) })}</em>}
            {displayedReadout.analystCount !== undefined && <em>{t("detail.chart.target.analystCount", { count: displayedReadout.analystCount })}</em>}
          </div>
        )}
      </header>
      <div
        ref={hostRef}
        className="detail-history-chart"
        role="img"
        aria-label={t("detail.chart.target.aria", { symbol: history.symbol })}
      />
      <footer>
        <span className="low"><i />{t("detail.chart.target.lowLegend")}</span>
        <span className="average"><i />{t("detail.chart.target.averageLegend")}</span>
        <span className="high"><i />{t("detail.chart.target.highLegend")}</span>
        {latestActualPrice && <span className="reported"><i />{t("detail.chart.target.actualLegend", { value: currency(latestActualPrice.close, locale), date: formatChartDate(latestActualPrice.date, locale) })}</span>}
        <small>{t("detail.chart.target.methodology")}</small>
      </footer>
    </section>
  );
}

type EarningsMode = "eps" | "revenue";

function earningsLineData(
  earnings: readonly EarningsEvent[],
  mode: EarningsMode,
) {
  const divisor = mode === "revenue" ? 1_000_000_000 : 1;
  const actualKey = mode === "eps" ? "epsActual" : "revenueActual";
  const estimateKey = mode === "eps" ? "epsEstimate" : "revenueEstimate";
  const sorted = [...earnings]
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.reportDate))
    .sort((left, right) => left.reportDate.localeCompare(right.reportDate));
  const actual: LineData<Time>[] = [];
  const estimate: LineData<Time>[] = [];
  for (const item of sorted) {
    const actualValue = item[actualKey];
    const estimateValue = item[estimateKey];
    if (typeof actualValue === "number" && Number.isFinite(actualValue)) {
      actual.push({ time: item.reportDate as Time, value: actualValue / divisor });
    }
    if (typeof estimateValue === "number" && Number.isFinite(estimateValue)) {
      estimate.push({ time: item.reportDate as Time, value: estimateValue / divisor });
    }
  }
  return { actual, estimate };
}

export function EarningsActualEstimateChart({ earnings }: { earnings: readonly EarningsEvent[] }) {
  const { locale, t } = useI18n();
  const [mode, setMode] = useState<EarningsMode>("eps");
  const hostRef = useRef<HTMLDivElement>(null);
  const data = useMemo(() => earningsLineData(earnings, mode), [earnings, mode]);
  const hasData = data.actual.length > 0 || data.estimate.length > 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasData) return;
    const chart = chartBase(host, locale);
    const actual = chart.addSeries(LineSeries, {
      color: "#f4f5f7",
      lineWidth: 2,
      pointMarkersVisible: true,
      pointMarkersRadius: 3,
      priceLineVisible: false,
      lastValueVisible: true,
      title: t("detail.chart.earnings.actualSeries"),
    });
    const estimate = chart.addSeries(LineSeries, {
      color: "#4f8cff",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      pointMarkersVisible: true,
      pointMarkersRadius: 3,
      priceLineVisible: false,
      lastValueVisible: true,
      title: t("detail.chart.earnings.estimateSeries"),
    });
    actual.setData(data.actual);
    estimate.setData(data.estimate);
    chart.timeScale().fitContent();
    const observer = observeChartResize(host, chart);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [data, hasData, locale, t]);

  if (!hasData) return null;
  return (
    <section className="detail-visual-card earnings-visual">
      <header>
        <div><span>EARNINGS HISTORY</span><strong>{t("detail.chart.earnings.title")}</strong></div>
        <div className="detail-visual-toggle" role="group" aria-label={t("detail.chart.earnings.metricAria")}>
          <button type="button" className={mode === "eps" ? "active" : ""} onClick={() => setMode("eps")}>EPS</button>
          <button type="button" className={mode === "revenue" ? "active" : ""} onClick={() => setMode("revenue")}>{t("detail.earnings.revenue")}</button>
        </div>
      </header>
      <div
        ref={hostRef}
        className="detail-history-chart"
        role="img"
        aria-label={t("detail.chart.earnings.aria", { metric: mode === "eps" ? "EPS" : t("detail.earnings.revenue") })}
      />
      <footer>
        <span className="reported"><i />{t("detail.earnings.actual")}</span>
        <span className="estimate"><i />{t("detail.chart.earnings.estimateSeries")}</span>
        <small>{t(mode === "revenue" ? "detail.chart.earnings.unitRevenue" : "detail.chart.earnings.unitEps")}</small>
      </footer>
    </section>
  );
}
