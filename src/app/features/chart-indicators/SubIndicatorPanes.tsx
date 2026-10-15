"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type LineWidth,
  type Time,
  type WhitespaceData,
} from "lightweight-charts";
import type { MarketBar } from "../../platform/provider-contracts";
import { useI18n } from "../../platform/i18n";
import { chartLocaleTag } from "../chart-localization";
import { indicatorText } from "../indicators/indicator-i18n";
import {
  computeIndicatorSeries,
  finiteMarketBars,
  type IndicatorCalculationSpec,
  type SubIndicatorId as CanonicalSubIndicatorId,
} from "./indicator-calculations";
import {
  SYNCHRONIZED_PRICE_SCALE_MIN_WIDTH,
  createChartTimeScaleSync,
  type ChartTimeScaleSync,
} from "../chart-sync/chart-time-scale-sync";
import {
  EMPTY_CHART_DATA_LIFECYCLE,
  planChartDataUpdate,
  type ChartDataLifecycleState,
} from "../chart-sync/chart-data-lifecycle";

export type SubIndicatorId = CanonicalSubIndicatorId;

export type SubIndicatorSpec = Readonly<{
  id: SubIndicatorId;
  label: string;
  color: string;
  length: number;
  fast: number;
  slow: number;
  signal: number;
  smoothing: number;
  lineWidth: LineWidth;
  lineStyle: "solid" | "dashed" | "dotted";
  source?: IndicatorCalculationSpec["source"];
}>;

type NumericPoint = Readonly<{ time: Time; value: number }>;
type IndicatorSeries = Readonly<{
  name: string;
  color: string;
  points: readonly NumericPoint[];
  kind?: "line" | "histogram";
}>;
type ComputedSubIndicator = Readonly<{
  series: readonly IndicatorSeries[];
  guideLines?: readonly number[];
  precision?: number;
}>;

const SECONDARY_SERIES_COLORS: Readonly<Record<SubIndicatorId, Readonly<Record<string, string>>>> = {
  rsi14: { rsi: "#b388ff" },
  macd: { macd: "#42a5f5", signal: "#ff9800", histogram: "#607d8b" },
  stochastic: { k: "#26c6da", d: "#ffb74d" },
  atr14: { atr: "#ec407a" },
  adx14: { adx: "#ab47bc" },
  obv: { obv: "#78909c" },
};

type SubIndicatorSeriesKind = "line" | "histogram";

const SUB_INDICATOR_SERIES_LAYOUT: Readonly<Record<SubIndicatorId, readonly SubIndicatorSeriesKind[]>> = {
  rsi14: ["line"],
  macd: ["line", "line", "histogram"],
  stochastic: ["line", "line"],
  atr14: ["line"],
  adx14: ["line"],
  obv: ["line"],
};

const SUB_INDICATOR_GUIDE_LINES: Readonly<Partial<Record<SubIndicatorId, readonly number[]>>> = {
  rsi14: [30, 70],
  macd: [0],
  stochastic: [20, 80],
  adx14: [20, 25],
};

type SubIndicatorRuntimeSeries =
  | Readonly<{ kind: "line"; api: ISeriesApi<"Line"> }>
  | Readonly<{ kind: "histogram"; api: ISeriesApi<"Histogram"> }>;

type SubIndicatorChartRuntime = Readonly<{
  chart: IChartApi;
  timeline: ISeriesApi<"Line">;
  series: readonly SubIndicatorRuntimeSeries[];
}>;

function chartTime(value: string): Time {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value as Time;
  return Math.floor(new Date(value).getTime() / 1000) as Time;
}

/**
 * Lightweight Charts adapter around the pure indicator contract. The pane and
 * any caller rendering a legend receive values from the same canonical result.
 */
export function computeSubIndicator(
  bars: readonly MarketBar[],
  spec: SubIndicatorSpec,
): ComputedSubIndicator {
  const computed = computeIndicatorSeries(bars, spec);
  return {
    series: computed.series.map((series, index) => ({
      name: series.name,
      color: index === 0
        ? spec.color
        : SECONDARY_SERIES_COLORS[spec.id][series.key] ?? spec.color,
      points: series.points.map((point) => ({ time: chartTime(point.time), value: point.value })),
      kind: series.kind,
    })),
    guideLines: computed.guideLines,
    precision: computed.precision,
  };
}

function chartLineStyle(style: SubIndicatorSpec["lineStyle"]) {
  if (style === "dashed") return LineStyle.Dashed;
  if (style === "dotted") return LineStyle.Dotted;
  return LineStyle.Solid;
}

function compactNumber(value: number, locale: "en" | "ja", precision = 2) {
  const localeTag = chartLocaleTag(locale);
  if (Math.abs(value) >= 1_000_000) return new Intl.NumberFormat(localeTag, { notation: "compact", maximumFractionDigits: 2 }).format(value);
  return value.toLocaleString(localeTag, { maximumFractionDigits: precision });
}

function SubIndicatorPane({
  bars,
  spec,
  dataIdentity,
  timeScaleSync,
}: {
  bars: readonly MarketBar[];
  spec: SubIndicatorSpec;
  dataIdentity: string;
  timeScaleSync: ChartTimeScaleSync;
}) {
  const { locale } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRuntimeRef = useRef<SubIndicatorChartRuntime | null>(null);
  const chartDataLifecycleRef = useRef<ChartDataLifecycleState>(EMPTY_CHART_DATA_LIFECYCLE);
  const initialLocaleRef = useRef(locale);
  const computed = useMemo(() => computeSubIndicator(bars, spec), [bars, spec]);
  const latestValues = computed.series
    .map((series) => ({ name: series.name, color: series.color, value: series.points.at(-1)?.value }))
    .filter((item): item is { name: string; color: string; value: number } => typeof item.value === "number");
  const hasRenderableData = latestValues.length > 0;
  const paneDataIdentity = `${dataIdentity}:${spec.id}`;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !hasRenderableData) return;
    const chart = createChart(host, {
      width: Math.max(1, host.clientWidth),
      height: Math.max(96, host.clientHeight),
      autoSize: true,
      layout: {
        attributionLogo: false,
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#a6a6aa",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
        fontSize: 15,
      },
      grid: { vertLines: { color: "#151515" }, horzLines: { color: "#151515" } },
      rightPriceScale: {
        borderColor: "#2b2b2b",
        minimumWidth: SYNCHRONIZED_PRICE_SCALE_MIN_WIDTH,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: "#2b2b2b",
        rightOffset: 3,
        barSpacing: 7,
        minBarSpacing: 3,
        timeVisible: false,
      },
      // The price chart is the only interactive time-scale controller. Keeping
      // followers passive prevents a pane from drifting away from its candles.
      handleScroll: false,
      handleScale: false,
      localization: { locale: chartLocaleTag(initialLocaleRef.current) },
    });

    // Indicator series begin after their warm-up period. Whitespace points keep
    // every pane on the price chart's complete timeline, so logical indexes are
    // identical even before the first computable indicator value.
    const timeline = chart.addSeries(LineSeries, {
      color: "rgba(0, 0, 0, 0)",
      lineVisible: false,
      crosshairMarkerVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const series = SUB_INDICATOR_SERIES_LAYOUT[spec.id].map((kind, seriesIndex): SubIndicatorRuntimeSeries => {
      if (kind === "histogram") {
        return {
          kind,
          api: chart.addSeries(HistogramSeries, {
            color: "#607d8b",
            priceLineVisible: false,
            lastValueVisible: false,
          }),
        };
      }
      const line = chart.addSeries(LineSeries, {
        color: "#b388ff",
        lineWidth: seriesIndex === 0 ? 2 : 1,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        // The canonical label and latest value are rendered once in the pane
        // header. A second scale badge can lag during chart reflow and look
        // inconsistent with that shared legend.
        lastValueVisible: false,
        title: "",
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      });
      if (seriesIndex === 0) {
        for (const price of SUB_INDICATOR_GUIDE_LINES[spec.id] ?? []) {
          line.createPriceLine({
            price,
            color: "#55585f",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
            title: "",
          });
        }
      }
      return { kind, api: line };
    });
    chartDataLifecycleRef.current = EMPTY_CHART_DATA_LIFECYCLE;
    chartRuntimeRef.current = { chart, timeline, series };
    return () => {
      chartRuntimeRef.current = null;
      chart.remove();
    };
  }, [hasRenderableData, spec.id]);

  useEffect(() => {
    const runtime = chartRuntimeRef.current;
    if (!runtime) return;
    runtime.chart.applyOptions({
      localization: { locale: chartLocaleTag(locale) },
      timeScale: { timeVisible: bars.some((item) => item.time.includes("T")) },
    });
    runtime.series.forEach((runtimeSeries, seriesIndex) => {
      const seriesDefinition = computed.series[seriesIndex];
      if (!seriesDefinition) return;
      if (runtimeSeries.kind === "histogram") {
        runtimeSeries.api.applyOptions({
          color: seriesDefinition.color,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        return;
      }
      runtimeSeries.api.applyOptions({
        color: seriesDefinition.color,
        lineWidth: seriesIndex === 0 ? spec.lineWidth : 1,
        lineStyle: seriesIndex === 0 ? chartLineStyle(spec.lineStyle) : LineStyle.Solid,
        priceFormat: { type: "price", precision: computed.precision ?? 2, minMove: computed.precision === 0 ? 1 : 0.01 },
      });
    });
  }, [bars, computed, locale, spec.lineStyle, spec.lineWidth]);

  useEffect(() => {
    const runtime = chartRuntimeRef.current;
    if (!runtime) return;
    const finiteBars = finiteMarketBars(bars);
    const timeScale = runtime.chart.timeScale();
    const updatePlan = planChartDataUpdate({
      previous: chartDataLifecycleRef.current,
      identity: paneDataIdentity,
      pointCount: finiteBars.length,
      visibleLogicalRange: timeScale.getVisibleLogicalRange(),
    });
    runtime.timeline.setData(finiteBars.map((bar) => ({
      time: chartTime(bar.time),
    })) as WhitespaceData<Time>[]);
    runtime.series.forEach((runtimeSeries, seriesIndex) => {
      const seriesDefinition = computed.series[seriesIndex];
      if (!seriesDefinition) return;
      if (runtimeSeries.kind === "histogram") {
        runtimeSeries.api.setData(seriesDefinition.points.map((point) => ({
          ...point,
          color: point.value >= 0 ? "rgba(0, 255, 161, .68)" : "rgba(252, 63, 66, .68)",
        })) as HistogramData<Time>[]);
      } else {
        runtimeSeries.api.setData(seriesDefinition.points as LineData<Time>[]);
      }
    });
    chartDataLifecycleRef.current = updatePlan.nextState;
    const synchronizedRange = timeScaleSync.snapshot();
    if (synchronizedRange) timeScale.setVisibleLogicalRange(synchronizedRange);
    else if (updatePlan.fitContent) timeScale.fitContent();
    else if (updatePlan.visibleLogicalRange) timeScale.setVisibleLogicalRange(updatePlan.visibleLogicalRange);
  }, [bars, computed, paneDataIdentity, timeScaleSync]);

  useEffect(() => {
    const runtime = chartRuntimeRef.current;
    if (!runtime) return;
    const timeScale = runtime.chart.timeScale();
    const unsubscribeSync = timeScaleSync.subscribe((range) => {
      if (range === null) timeScale.fitContent();
      else timeScale.setVisibleLogicalRange(range);
    });
    return unsubscribeSync;
  }, [hasRenderableData, timeScaleSync]);

  return (
    <section className="subindicator-pane" aria-label={indicatorText(locale, "paneAria", { name: spec.label })}>
      <header>
        <strong>{spec.label}</strong>
        <span>{latestValues.map((item) => <b key={item.name} style={{ color: item.color }}>{item.name} {compactNumber(item.value, locale, computed.precision)}</b>)}</span>
      </header>
      {latestValues.length > 0
        ? <div className="subindicator-chart" ref={hostRef} />
        : <div className="subindicator-empty">{indicatorText(locale, "insufficientHistory")}</div>}
    </section>
  );
}

export function SubIndicatorPanes({
  bars,
  indicators,
  dataIdentity = "default",
  timeScaleSync,
}: {
  bars: readonly MarketBar[];
  indicators: readonly SubIndicatorSpec[];
  dataIdentity?: string;
  timeScaleSync?: ChartTimeScaleSync;
}) {
  const { locale } = useI18n();
  const localTimeScaleSync = useMemo(() => createChartTimeScaleSync(), []);
  const resolvedTimeScaleSync = timeScaleSync ?? localTimeScaleSync;
  if (indicators.length === 0) return null;
  return (
    <div className="subindicator-panes" aria-label={indicatorText(locale, "panesAria")}>
      {indicators.map((indicator) => <SubIndicatorPane key={indicator.id} bars={bars} spec={indicator} dataIdentity={dataIdentity} timeScaleSync={resolvedTimeScaleSync} />)}
    </div>
  );
}
