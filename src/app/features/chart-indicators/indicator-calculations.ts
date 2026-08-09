import type { MarketBar } from "../../platform/provider-contracts";

export const CHART_INDICATOR_IDS = [
  "sma20",
  "ema50",
  "bollinger",
  "vwap",
  "rsi14",
  "macd",
  "stochastic",
  "atr14",
  "adx14",
  "obv",
] as const;

export type ChartIndicatorId = (typeof CHART_INDICATOR_IDS)[number];
export type OverlayIndicatorId = Extract<ChartIndicatorId, "sma20" | "ema50" | "bollinger" | "vwap">;
export type SubIndicatorId = Exclude<ChartIndicatorId, OverlayIndicatorId>;
export type IndicatorPriceSource = "終値" | "始値" | "高値" | "安値" | "HL2" | "HLC3";
export type IndicatorSeriesKey =
  | "sma"
  | "ema"
  | "upper"
  | "lower"
  | "vwap"
  | "rsi"
  | "macd"
  | "signal"
  | "histogram"
  | "k"
  | "d"
  | "atr"
  | "adx"
  | "obv";

/**
 * Calculation-only settings shared by chart rendering and latest-value labels.
 * Presentation or unsupported settings such as offset, visibility, VWAP
 * anchor, color, and line style do not belong here until renderers implement
 * those behaviors.
 */
export type IndicatorCalculationSpec = Readonly<{
  id: ChartIndicatorId;
  length?: number;
  source?: IndicatorPriceSource;
  multiplier?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  smoothing?: number;
}>;

export type WilderRsiOptions = Readonly<{
  length: number;
  source?: IndicatorPriceSource;
}>;

export type IndicatorNumericPoint = Readonly<{
  time: string;
  value: number;
}>;

export type IndicatorComputedSeries = Readonly<{
  key: IndicatorSeriesKey;
  name: string;
  points: readonly IndicatorNumericPoint[];
  kind?: "line" | "histogram";
}>;

export type ComputedIndicator = Readonly<{
  id: ChartIndicatorId;
  series: readonly IndicatorComputedSeries[];
  primarySeriesKey: IndicatorSeriesKey;
  guideLines?: readonly number[];
  precision?: number;
}>;

export type IndicatorLatestValue = Readonly<{
  key: IndicatorSeriesKey;
  name: string;
  time: string;
  value: number;
}>;

function normalizedNumber(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizedPeriod(value: number | undefined, fallback: number, minimum = 2) {
  return Math.max(minimum, Math.round(normalizedNumber(value, fallback)));
}

/**
 * Keep chart panes and legend readings on the exact same validated OHLCV input.
 * The provider is responsible for chronological ordering; preserving that order
 * also means the result maps one-to-one to the candles rendered by the chart.
 */
export function finiteMarketBars(bars: readonly MarketBar[]): readonly MarketBar[] {
  return bars.filter((bar) => {
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) return false;
    return typeof bar.time === "string" && Number.isFinite(Date.parse(bar.time));
  });
}

export function indicatorSourceValue(bar: MarketBar, source: IndicatorPriceSource = "終値") {
  if (source === "始値") return bar.open;
  if (source === "高値") return bar.high;
  if (source === "安値") return bar.low;
  if (source === "HL2") return (bar.high + bar.low) / 2;
  if (source === "HLC3") return (bar.high + bar.low + bar.close) / 3;
  return bar.close;
}

function sourceValues(bars: readonly MarketBar[], source: IndicatorPriceSource) {
  return bars.map((bar) => indicatorSourceValue(bar, source));
}

function emaValues(values: readonly number[], length: number) {
  const multiplier = 2 / (length + 1);
  const output: number[] = [];
  let current = values[0] ?? 0;
  for (let index = 0; index < values.length; index += 1) {
    current = index === 0
      ? values[index]
      : values[index] * multiplier + current * (1 - multiplier);
    output.push(current);
  }
  return output;
}

function wilderValues(values: readonly number[], length: number) {
  const output = Array.from({ length: values.length }, () => Number.NaN);
  if (values.length < length) return output;
  let average = values.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  output[length - 1] = average;
  for (let index = length; index < values.length; index += 1) {
    average = (average * (length - 1) + values[index]) / length;
    output[index] = average;
  }
  return output;
}

function trueRanges(bars: readonly MarketBar[]) {
  return bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - bars[index - 1].close),
      Math.abs(bar.low - bars[index - 1].close),
    ));
}

function finitePoints(
  bars: readonly MarketBar[],
  values: readonly number[],
  startIndex = 0,
): readonly IndicatorNumericPoint[] {
  const points: IndicatorNumericPoint[] = [];
  for (let index = Math.max(0, startIndex); index < bars.length; index += 1) {
    if (Number.isFinite(values[index])) points.push({ time: bars[index].time, value: values[index] });
  }
  return points;
}

function computeSma(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const length = normalizedPeriod(spec.length, 20);
  const values = sourceValues(bars, spec.source ?? "終値");
  const averages = Array.from({ length: values.length }, () => Number.NaN);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= length) sum -= values[index - length];
    if (index >= length - 1) averages[index] = sum / length;
  }
  return {
    id: spec.id,
    primarySeriesKey: "sma",
    series: [{ key: "sma", name: "SMA", points: finitePoints(bars, averages, length - 1) }],
  };
}

function computeEma(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const length = normalizedPeriod(spec.length, 50);
  const values = emaValues(sourceValues(bars, spec.source ?? "終値"), length);
  return {
    id: spec.id,
    primarySeriesKey: "ema",
    series: [{ key: "ema", name: "EMA", points: finitePoints(bars, values, length - 1) }],
  };
}

function computeBollinger(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const length = normalizedPeriod(spec.length, 20);
  const multiplier = Math.max(0.1, normalizedNumber(spec.multiplier, 2));
  const values = sourceValues(bars, spec.source ?? "終値");
  const upper = Array.from({ length: values.length }, () => Number.NaN);
  const lower = Array.from({ length: values.length }, () => Number.NaN);
  let sum = 0;
  let squaredSum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    sum += value;
    squaredSum += value * value;
    if (index >= length) {
      const removed = values[index - length];
      sum -= removed;
      squaredSum -= removed * removed;
    }
    if (index >= length - 1) {
      const average = sum / length;
      const variance = Math.max(0, squaredSum / length - average * average);
      const deviation = Math.sqrt(variance) * multiplier;
      upper[index] = average + deviation;
      lower[index] = average - deviation;
    }
  }
  return {
    id: spec.id,
    primarySeriesKey: "upper",
    series: [
      { key: "upper", name: "Upper", points: finitePoints(bars, upper, length - 1) },
      { key: "lower", name: "Lower", points: finitePoints(bars, lower, length - 1) },
    ],
  };
}

function computeVwap(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const source = spec.source ?? "HLC3";
  const points: IndicatorNumericPoint[] = [];
  let cumulativeVolume = 0;
  let cumulativeValue = 0;
  for (const bar of bars) {
    cumulativeVolume += bar.volume;
    cumulativeValue += indicatorSourceValue(bar, source) * bar.volume;
    const value = cumulativeValue / cumulativeVolume;
    if (Number.isFinite(value)) points.push({ time: bar.time, value });
  }
  return {
    id: spec.id,
    primarySeriesKey: "vwap",
    series: [{ key: "vwap", name: "VWAP", points }],
  };
}

/**
 * TradingView-style RSI: SMA seeds the first average gain/loss, then Wilder's
 * recursive moving average (RMA) updates every subsequent point.
 */
export function computeWilderRsiSeries(
  bars: readonly MarketBar[],
  options: WilderRsiOptions,
): readonly IndicatorNumericPoint[] {
  const sourceBars = finiteMarketBars(bars);
  const period = normalizedPeriod(options.length, 14);
  if (sourceBars.length <= period) return [];

  const values = sourceValues(sourceBars, options.source ?? "終値");
  let gain = 0;
  let loss = 0;

  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gain += Math.max(delta, 0);
    loss += Math.max(-delta, 0);
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;
  const points: IndicatorNumericPoint[] = [];
  const append = (index: number) => {
    const value = averageLoss === 0
      ? averageGain === 0 ? 50 : 100
      : averageGain === 0 ? 0 : 100 - 100 / (1 + averageGain / averageLoss);
    if (Number.isFinite(value)) points.push({ time: sourceBars[index].time, value });
  };

  append(period);
  for (let index = period + 1; index < sourceBars.length; index += 1) {
    const delta = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
    append(index);
  }

  return points;
}

function computeRsi(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const points = computeWilderRsiSeries(bars, {
    length: normalizedPeriod(spec.length, 14),
    source: spec.source ?? "終値",
  });
  return {
    id: spec.id,
    primarySeriesKey: "rsi",
    series: [{ key: "rsi", name: "RSI", points }],
    guideLines: [30, 70],
    precision: 1,
  };
}

function computeMacd(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const fast = normalizedPeriod(spec.fast, 12);
  const slow = Math.max(fast + 1, normalizedPeriod(spec.slow, 26));
  const signalLength = normalizedPeriod(spec.signal, 9);
  const values = sourceValues(bars, spec.source ?? "終値");
  const fastValues = emaValues(values, fast);
  const slowValues = emaValues(values, slow);
  const macdValues = values.map((_, index) => fastValues[index] - slowValues[index]);
  const signalValues = emaValues(macdValues, signalLength);
  const histogramValues = macdValues.map((value, index) => value - signalValues[index]);
  return {
    id: spec.id,
    primarySeriesKey: "macd",
    series: [
      { key: "macd", name: "MACD", points: finitePoints(bars, macdValues, slow - 1) },
      { key: "signal", name: "Signal", points: finitePoints(bars, signalValues, slow - 1) },
      { key: "histogram", name: "Histogram", points: finitePoints(bars, histogramValues, slow - 1), kind: "histogram" },
    ],
    guideLines: [0],
    precision: 3,
  };
}

function movingAverage(values: readonly number[], length: number) {
  const output = Array.from({ length: values.length }, () => Number.NaN);
  let sum = 0;
  let finiteCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (Number.isFinite(values[index])) {
      sum += values[index];
      finiteCount += 1;
    }
    if (index >= length && Number.isFinite(values[index - length])) {
      sum -= values[index - length];
      finiteCount -= 1;
    }
    if (index >= length - 1 && finiteCount === length) output[index] = sum / length;
  }
  return output;
}

function computeStochastic(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const length = normalizedPeriod(spec.length, 14);
  const smoothing = normalizedPeriod(spec.smoothing, 3, 1);
  const signalLength = normalizedPeriod(spec.signal, 3, 1);
  const source = spec.source ?? "終値";
  const rawK = Array.from({ length: bars.length }, () => Number.NaN);
  const highDeque: number[] = [];
  const lowDeque: number[] = [];
  let highHead = 0;
  let lowHead = 0;

  for (let index = 0; index < bars.length; index += 1) {
    while (highDeque.length > highHead && bars[highDeque.at(-1)!].high <= bars[index].high) highDeque.pop();
    while (lowDeque.length > lowHead && bars[lowDeque.at(-1)!].low >= bars[index].low) lowDeque.pop();
    highDeque.push(index);
    lowDeque.push(index);
    while (highDeque[highHead] <= index - length) highHead += 1;
    while (lowDeque[lowHead] <= index - length) lowHead += 1;
    if (index < length - 1) continue;
    const high = bars[highDeque[highHead]].high;
    const low = bars[lowDeque[lowHead]].low;
    rawK[index] = high === low
      ? 50
      : ((indicatorSourceValue(bars[index], source) - low) / (high - low)) * 100;
  }

  const kValues = movingAverage(rawK, smoothing);
  const dValues = movingAverage(kValues, signalLength);
  return {
    id: spec.id,
    primarySeriesKey: "k",
    series: [
      { key: "k", name: "%K", points: finitePoints(bars, kValues) },
      { key: "d", name: "%D", points: finitePoints(bars, dValues) },
    ],
    guideLines: [20, 80],
  };
}

function computeAtr(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const length = normalizedPeriod(spec.length, 14);
  const values = wilderValues(trueRanges(bars), length);
  return {
    id: spec.id,
    primarySeriesKey: "atr",
    series: [{ key: "atr", name: "ATR", points: finitePoints(bars, values, length - 1) }],
    precision: 3,
  };
}

function computeAdx(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const length = normalizedPeriod(spec.length, 14);
  const tr = trueRanges(bars);
  const plusDm = bars.map((bar, index) => {
    if (index === 0) return 0;
    const up = bar.high - bars[index - 1].high;
    const down = bars[index - 1].low - bar.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDm = bars.map((bar, index) => {
    if (index === 0) return 0;
    const up = bar.high - bars[index - 1].high;
    const down = bars[index - 1].low - bar.low;
    return down > up && down > 0 ? down : 0;
  });
  const atr = wilderValues(tr, length);
  const plus = wilderValues(plusDm, length);
  const minus = wilderValues(minusDm, length);
  const dx = bars.map((_, index) => {
    if (!Number.isFinite(atr[index]) || atr[index] === 0) return Number.NaN;
    const plusDi = 100 * plus[index] / atr[index];
    const minusDi = 100 * minus[index] / atr[index];
    const denominator = plusDi + minusDi;
    return denominator === 0 ? 0 : 100 * Math.abs(plusDi - minusDi) / denominator;
  });
  // Preserve the pane's established Wilder seed so migrating renderers does not
  // move the plotted line. A later formula migration can be versioned separately.
  const adx = wilderValues(dx.map((value) => Number.isFinite(value) ? value : 0), length);
  return {
    id: spec.id,
    primarySeriesKey: "adx",
    series: [{ key: "adx", name: "ADX", points: finitePoints(bars, adx, length * 2 - 2) }],
    guideLines: [20, 25],
  };
}

function computeObv(bars: readonly MarketBar[], spec: IndicatorCalculationSpec): ComputedIndicator {
  const source = spec.source ?? "終値";
  const points: IndicatorNumericPoint[] = [];
  let value = 0;
  for (let index = 0; index < bars.length; index += 1) {
    if (index > 0) {
      const current = indicatorSourceValue(bars[index], source);
      const previous = indicatorSourceValue(bars[index - 1], source);
      if (current > previous) value += bars[index].volume;
      if (current < previous) value -= bars[index].volume;
    }
    points.push({ time: bars[index].time, value });
  }
  return {
    id: spec.id,
    primarySeriesKey: "obv",
    series: [{ key: "obv", name: "OBV", points }],
    precision: 0,
  };
}

/**
 * Canonical calculation entry point. Renderers and legends should consume the
 * same returned object rather than independently recomputing the latest value.
 */
export function computeIndicatorSeries(
  inputBars: readonly MarketBar[],
  spec: IndicatorCalculationSpec,
): ComputedIndicator {
  const bars = finiteMarketBars(inputBars);
  if (spec.id === "sma20") return computeSma(bars, spec);
  if (spec.id === "ema50") return computeEma(bars, spec);
  if (spec.id === "bollinger") return computeBollinger(bars, spec);
  if (spec.id === "vwap") return computeVwap(bars, spec);
  if (spec.id === "rsi14") return computeRsi(bars, spec);
  if (spec.id === "macd") return computeMacd(bars, spec);
  if (spec.id === "stochastic") return computeStochastic(bars, spec);
  if (spec.id === "atr14") return computeAtr(bars, spec);
  if (spec.id === "adx14") return computeAdx(bars, spec);
  if (spec.id === "obv") return computeObv(bars, spec);
  const unsupported: never = spec.id;
  throw new Error(`Unsupported indicator: ${String(unsupported)}`);
}

export function latestIndicatorValues(computed: ComputedIndicator): readonly IndicatorLatestValue[] {
  return computed.series.flatMap((series) => {
    const latest = series.points.at(-1);
    return latest && Number.isFinite(latest.value)
      ? [{ key: series.key, name: series.name, time: latest.time, value: latest.value }]
      : [];
  });
}

export function latestIndicatorValue(
  computed: ComputedIndicator,
  seriesKey: IndicatorSeriesKey = computed.primarySeriesKey,
): number | undefined {
  return latestIndicatorValues(computed).find((item) => item.key === seriesKey)?.value;
}

export function latestWilderRsiValue(
  bars: readonly MarketBar[],
  options: WilderRsiOptions,
): number | undefined {
  return computeWilderRsiSeries(bars, options).at(-1)?.value;
}
