"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type HistogramData,
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
  timeScaleSync,
}: {
  bars: readonly MarketBar[];
  spec: SubIndicatorSpec;
  timeScaleSync: ChartTimeScaleSync;
}) {
  const { locale } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const computed = useMemo(() => computeSubIndicator(bars, spec), [bars, spec]);
  const latestValues = computed.series
    .map((series) => ({ name: series.name, color: series.color, value: series.points.at(-1)?.value }))
    .filter((item): item is { name: string; color: string; value: number } => typeof item.value === "number");

  useEffect(() => {
    const host = hostRef.current;
    if (!host || computed.series.every((series) => series.points.length === 0)) return;
    const chart = createChart(host, {
      width: Math.max(1, host.clientWidth),
      height: Math.max(96, host.clientHeight),
      autoSize: true,
      layout: {
        attributionLogo: false,
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#a6a6aa",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
        fontSize: 12,
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
        timeVisible: bars.some((item) => item.time.includes("T")),
      },
      // The price chart is the only interactive time-scale controller. Keeping
      // followers passive prevents a pane from drifting away from its candles.
      handleScroll: false,
      handleScale: false,
      localization: { locale: chartLocaleTag(locale) },
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
    timeline.setData(finiteMarketBars(bars).map((bar) => ({
      time: chartTime(bar.time),
    })) as WhitespaceData<Time>[]);

    computed.series.forEach((seriesDefinition, seriesIndex) => {
      if (seriesDefinition.kind === "histogram") {
        const histogram = chart.addSeries(HistogramSeries, {
          color: seriesDefinition.color,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        histogram.setData(seriesDefinition.points.map((point) => ({
          ...point,
          color: point.value >= 0 ? "rgba(38, 166, 154, .68)" : "rgba(239, 83, 80, .68)",
        })) as HistogramData<Time>[]);
        return;
      }
      const line = chart.addSeries(LineSeries, {
        color: seriesDefinition.color,
        lineWidth: seriesIndex === 0 ? spec.lineWidth : 1,
        lineStyle: seriesIndex === 0 ? chartLineStyle(spec.lineStyle) : LineStyle.Solid,
        priceLineVisible: false,
        // The canonical label and latest value are rendered once in the pane
        // header. A second scale badge can lag during chart reflow and look
        // inconsistent with that shared legend.
        lastValueVisible: false,
        title: "",
        priceFormat: { type: "price", precision: computed.precision ?? 2, minMove: computed.precision === 0 ? 1 : 0.01 },
      });
      line.setData(seriesDefinition.points as LineData<Time>[]);
      if (seriesIndex === 0) {
        for (const price of computed.guideLines ?? []) {
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
    });
    const timeScale = chart.timeScale();
    timeScale.fitContent();
    const unsubscribeSync = timeScaleSync.subscribe((range) => {
      if (range === null) timeScale.fitContent();
      else timeScale.setVisibleLogicalRange(range);
    });
    return () => {
      unsubscribeSync();
      chart.remove();
    };
  }, [bars, computed, locale, spec.lineStyle, spec.lineWidth, timeScaleSync]);

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
  timeScaleSync,
}: {
  bars: readonly MarketBar[];
  indicators: readonly SubIndicatorSpec[];
  timeScaleSync?: ChartTimeScaleSync;
}) {
  const { locale } = useI18n();
  const localTimeScaleSync = useMemo(() => createChartTimeScaleSync(), []);
  const resolvedTimeScaleSync = timeScaleSync ?? localTimeScaleSync;
  if (indicators.length === 0) return null;
  return (
    <div className="subindicator-panes" aria-label={indicatorText(locale, "panesAria")}>
      {indicators.map((indicator) => <SubIndicatorPane key={indicator.id} bars={bars} spec={indicator} timeScaleSync={resolvedTimeScaleSync} />)}
    </div>
  );
}
