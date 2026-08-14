import {
  computeIndicatorSeries,
  computeWilderRsiSeries,
  type ComputedIndicator,
  type IndicatorSeriesKey,
} from "@/app/features/chart-indicators/indicator-calculations";
import type { MarketBar } from "@/app/platform/provider-contracts";

export type TechnicalRatingVerdict =
  | "strong_sell"
  | "sell"
  | "neutral"
  | "buy"
  | "strong_buy"
  | "unavailable";

export type TechnicalRatingSignalValue = "sell" | "neutral" | "buy" | "unavailable";
export type TechnicalRatingSignalScore = -1 | 0 | 1 | null;
export type TechnicalRatingSignalGroup = "moving_averages" | "oscillators";

export type TechnicalRatingSignalId =
  | "sma10"
  | "sma20"
  | "sma30"
  | "sma50"
  | "sma100"
  | "sma200"
  | "ema10"
  | "ema20"
  | "ema30"
  | "ema50"
  | "ema100"
  | "ema200"
  | "hma9"
  | "vwma20"
  | "ichimoku"
  | "rsi14"
  | "stochastic1433"
  | "cci20"
  | "adx1414"
  | "awesome_oscillator"
  | "momentum10"
  | "macd12269"
  | "stochastic_rsi331414"
  | "williams_r14"
  | "bull_bear_power13"
  | "ultimate_oscillator71428";

export type TechnicalRatingSignal = Readonly<{
  id: TechnicalRatingSignalId;
  label: string;
  group: TechnicalRatingSignalGroup;
  value: number | null;
  secondaryValue?: number | null;
  signal: TechnicalRatingSignalValue;
  score: TechnicalRatingSignalScore;
}>;

export type TechnicalRatingGroup = Readonly<{
  score: number | null;
  verdict: TechnicalRatingVerdict;
  buy: number;
  neutral: number;
  sell: number;
  unavailable: number;
  total: number;
  signals: readonly TechnicalRatingSignal[];
}>;

export type TechnicalRatingSummary = Readonly<{
  asOf: string | null;
  barCount: number;
  overall: TechnicalRatingGroup;
  movingAverages: TechnicalRatingGroup;
  oscillators: TechnicalRatingGroup;
}>;

const MOVING_AVERAGE_LENGTHS = [10, 20, 30, 50, 100, 200] as const;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validDailyBar(bar: MarketBar) {
  const timestamp = Date.parse(bar.time);
  return Number.isFinite(timestamp)
    && [bar.open, bar.high, bar.low, bar.close, bar.volume].every(finiteNumber)
    && bar.open > 0
    && bar.high > 0
    && bar.low > 0
    && bar.close > 0
    && bar.volume >= 0
    && bar.high >= Math.max(bar.open, bar.close, bar.low)
    && bar.low <= Math.min(bar.open, bar.close, bar.high);
}

function tradingDate(time: string) {
  const explicitDate = /^(\d{4}-\d{2}-\d{2})/.exec(time)?.[1];
  return explicitDate ?? new Date(time).toISOString().slice(0, 10);
}

/**
 * Ratings are defined on chronological daily observations. Invalid OHLCV is
 * discarded, and when an upstream repeats a trading date its latest timestamp
 * wins. No missing values are interpolated and no synthetic candle is created.
 */
export function normalizeTechnicalRatingBars(input: readonly MarketBar[]): readonly MarketBar[] {
  const byDate = new Map<string, Readonly<{ bar: MarketBar; timestamp: number; inputIndex: number }>>();
  input.forEach((bar, inputIndex) => {
    if (!validDailyBar(bar)) return;
    const timestamp = Date.parse(bar.time);
    const date = tradingDate(bar.time);
    const current = byDate.get(date);
    if (
      !current
      || timestamp > current.timestamp
      || (timestamp === current.timestamp && inputIndex > current.inputIndex)
    ) {
      byDate.set(date, { bar, timestamp, inputIndex });
    }
  });
  return [...byDate.values()]
    .sort((left, right) => left.timestamp - right.timestamp || left.inputIndex - right.inputIndex)
    .map((item) => item.bar);
}

function movingAverage(values: readonly number[], length: number) {
  const output = Array.from({ length: values.length }, () => Number.NaN);
  let sum = 0;
  let finiteCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) {
      sum += value;
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

function weightedMovingAverage(values: readonly number[], length: number) {
  const output = Array.from({ length: values.length }, () => Number.NaN);
  const denominator = length * (length + 1) / 2;
  for (let index = length - 1; index < values.length; index += 1) {
    let weighted = 0;
    let complete = true;
    for (let offset = 0; offset < length; offset += 1) {
      const value = values[index - length + 1 + offset];
      if (!Number.isFinite(value)) {
        complete = false;
        break;
      }
      weighted += value * (offset + 1);
    }
    if (complete) output[index] = weighted / denominator;
  }
  return output;
}

function volumeWeightedMovingAverage(bars: readonly MarketBar[], length: number) {
  const output = Array.from({ length: bars.length }, () => Number.NaN);
  let weightedPrice = 0;
  let volume = 0;
  for (let index = 0; index < bars.length; index += 1) {
    weightedPrice += bars[index].close * bars[index].volume;
    volume += bars[index].volume;
    if (index >= length) {
      weightedPrice -= bars[index - length].close * bars[index - length].volume;
      volume -= bars[index - length].volume;
    }
    if (index >= length - 1 && volume > 0) output[index] = weightedPrice / volume;
  }
  return output;
}

function rangeMidpointSeries(bars: readonly MarketBar[], length: number) {
  const output = Array.from({ length: bars.length }, () => Number.NaN);
  for (let index = length - 1; index < bars.length; index += 1) {
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let cursor = index - length + 1; cursor <= index; cursor += 1) {
      high = Math.max(high, bars[cursor].high);
      low = Math.min(low, bars[cursor].low);
    }
    output[index] = (high + low) / 2;
  }
  return output;
}

function latestSeriesValue(
  computed: ComputedIndicator,
  key: IndicatorSeriesKey,
  offset = 0,
) {
  return computed.series.find((series) => series.key === key)?.points.at(-1 - offset)?.value;
}

function assessedSignal(input: Readonly<{
  id: TechnicalRatingSignalId;
  label: string;
  group: TechnicalRatingSignalGroup;
  value: number | undefined;
  secondaryValue?: number | undefined;
  available?: boolean;
  buy: boolean;
  sell: boolean;
}>): TechnicalRatingSignal {
  const available = input.available !== false
    && finiteNumber(input.value)
    && (input.secondaryValue === undefined || finiteNumber(input.secondaryValue));
  if (!available) {
    return {
      id: input.id,
      label: input.label,
      group: input.group,
      value: null,
      ...(input.secondaryValue === undefined ? {} : { secondaryValue: null }),
      signal: "unavailable",
      score: null,
    };
  }
  const signal = input.buy ? "buy" : input.sell ? "sell" : "neutral";
  const score = signal === "buy" ? 1 : signal === "sell" ? -1 : 0;
  return {
    id: input.id,
    label: input.label,
    group: input.group,
    value: input.value!,
    ...(input.secondaryValue === undefined ? {} : { secondaryValue: input.secondaryValue! }),
    signal,
    score,
  };
}

function unavailableSignal(
  id: TechnicalRatingSignalId,
  label: string,
  group: TechnicalRatingSignalGroup,
): TechnicalRatingSignal {
  return { id, label, group, value: null, signal: "unavailable", score: null };
}

export function technicalRatingVerdict(score: number | null): TechnicalRatingVerdict {
  if (score === null || !Number.isFinite(score)) return "unavailable";
  if (score < -0.5) return "strong_sell";
  if (score < -0.1) return "sell";
  if (score <= 0.1) return "neutral";
  if (score <= 0.5) return "buy";
  return "strong_buy";
}

function summarizeSignals(
  signals: readonly TechnicalRatingSignal[],
  scoreOverride?: number | null,
): TechnicalRatingGroup {
  const availableScores = signals.flatMap((signal) => signal.score === null ? [] : [signal.score]);
  const score = scoreOverride === undefined
    ? availableScores.length === 0
      ? null
      : availableScores.reduce<number>((sum, value) => sum + value, 0) / availableScores.length
    : scoreOverride;
  return {
    score,
    verdict: technicalRatingVerdict(score),
    buy: signals.filter((signal) => signal.signal === "buy").length,
    neutral: signals.filter((signal) => signal.signal === "neutral").length,
    sell: signals.filter((signal) => signal.signal === "sell").length,
    unavailable: signals.filter((signal) => signal.signal === "unavailable").length,
    total: signals.length,
    signals,
  };
}

function buildMovingAverageSignals(bars: readonly MarketBar[]) {
  const group = "moving_averages" as const;
  const close = bars.at(-1)?.close;
  if (close === undefined) {
    return [
      ...MOVING_AVERAGE_LENGTHS.map((length) => unavailableSignal(`sma${length}`, `SMA ${length}`, group)),
      ...MOVING_AVERAGE_LENGTHS.map((length) => unavailableSignal(`ema${length}`, `EMA ${length}`, group)),
      unavailableSignal("hma9", "Hull MA 9", group),
      unavailableSignal("vwma20", "VWMA 20", group),
      unavailableSignal("ichimoku", "Ichimoku 9, 26, 52", group),
    ];
  }

  const signals: TechnicalRatingSignal[] = [];
  for (const length of MOVING_AVERAGE_LENGTHS) {
    const computed = computeIndicatorSeries(bars, { id: "sma20", length, source: "終値" });
    const value = latestSeriesValue(computed, "sma");
    signals.push(assessedSignal({
      id: `sma${length}`,
      label: `SMA ${length}`,
      group,
      value,
      buy: value !== undefined && close > value,
      sell: value !== undefined && close < value,
    }));
  }
  for (const length of MOVING_AVERAGE_LENGTHS) {
    const computed = computeIndicatorSeries(bars, { id: "ema50", length, source: "終値" });
    const value = latestSeriesValue(computed, "ema");
    signals.push(assessedSignal({
      id: `ema${length}`,
      label: `EMA ${length}`,
      group,
      value,
      buy: value !== undefined && close > value,
      sell: value !== undefined && close < value,
    }));
  }

  const closes = bars.map((bar) => bar.close);
  const halfHull = weightedMovingAverage(closes, 4);
  const fullHull = weightedMovingAverage(closes, 9);
  const hullInput = closes.map((_, index) => (
    Number.isFinite(halfHull[index]) && Number.isFinite(fullHull[index])
      ? 2 * halfHull[index] - fullHull[index]
      : Number.NaN
  ));
  const hull = weightedMovingAverage(hullInput, 3).at(-1);
  signals.push(assessedSignal({
    id: "hma9",
    label: "Hull MA 9",
    group,
    value: hull,
    buy: hull !== undefined && close > hull,
    sell: hull !== undefined && close < hull,
  }));

  const vwma = volumeWeightedMovingAverage(bars, 20).at(-1);
  signals.push(assessedSignal({
    id: "vwma20",
    label: "VWMA 20",
    group,
    value: vwma,
    buy: vwma !== undefined && close > vwma,
    sell: vwma !== undefined && close < vwma,
  }));

  const conversionSeries = rangeMidpointSeries(bars, 9);
  const baseSeries = rangeMidpointSeries(bars, 26);
  const spanBSeries = rangeMidpointSeries(bars, 52);
  const latestIndex = bars.length - 1;
  const displacedIndex = latestIndex - 26;
  const conversion = conversionSeries[latestIndex];
  const base = baseSeries[latestIndex];
  const leadingSpanA = displacedIndex >= 0
    && Number.isFinite(conversionSeries[displacedIndex])
    && Number.isFinite(baseSeries[displacedIndex])
    ? (conversionSeries[displacedIndex] + baseSeries[displacedIndex]) / 2
    : Number.NaN;
  const leadingSpanB = displacedIndex >= 0 ? spanBSeries[displacedIndex] : Number.NaN;
  const ichimokuAvailable = [conversion, base, leadingSpanA, leadingSpanB].every(Number.isFinite);
  signals.push(assessedSignal({
    id: "ichimoku",
    label: "Ichimoku 9, 26, 52",
    group,
    value: conversion,
    secondaryValue: base,
    available: ichimokuAvailable,
    buy: ichimokuAvailable
      && leadingSpanA > leadingSpanB
      && base > leadingSpanA
      && conversion > base
      && close > conversion,
    sell: ichimokuAvailable
      && leadingSpanA < leadingSpanB
      && base < leadingSpanA
      && conversion < base
      && close < conversion,
  }));
  return signals;
}

function commodityChannelIndex(bars: readonly MarketBar[], length: number) {
  const typical = bars.map((bar) => (bar.high + bar.low + bar.close) / 3);
  const average = movingAverage(typical, length);
  return typical.map((value, index) => {
    if (!Number.isFinite(average[index]) || index < length - 1) return Number.NaN;
    let deviation = 0;
    for (let cursor = index - length + 1; cursor <= index; cursor += 1) {
      deviation += Math.abs(typical[cursor] - average[index]);
    }
    const meanDeviation = deviation / length;
    return meanDeviation === 0 ? 0 : (value - average[index]) / (0.015 * meanDeviation);
  });
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

function wilderValuesFrom(values: readonly number[], length: number, startIndex: number) {
  const output = Array.from({ length: values.length }, () => Number.NaN);
  const firstOutputIndex = startIndex + length - 1;
  if (firstOutputIndex >= values.length) return output;
  const seed = values.slice(startIndex, firstOutputIndex + 1);
  if (seed.some((value) => !Number.isFinite(value))) return output;
  let average = seed.reduce((sum, value) => sum + value, 0) / length;
  output[firstOutputIndex] = average;
  for (let index = firstOutputIndex + 1; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) continue;
    average = (average * (length - 1) + values[index]) / length;
    output[index] = average;
  }
  return output;
}

function directionalMovement(bars: readonly MarketBar[], length: number) {
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
  const atr = wilderValuesFrom(tr, length, 1);
  const plus = wilderValuesFrom(plusDm, length, 1);
  const minus = wilderValuesFrom(minusDm, length, 1);
  const plusDi = bars.map((_, index) => Number.isFinite(atr[index]) && atr[index] !== 0
    ? 100 * plus[index] / atr[index]
    : Number.NaN);
  const minusDi = bars.map((_, index) => Number.isFinite(atr[index]) && atr[index] !== 0
    ? 100 * minus[index] / atr[index]
    : Number.NaN);
  const dx = bars.map((_, index) => {
    if (!Number.isFinite(plusDi[index]) || !Number.isFinite(minusDi[index])) return Number.NaN;
    const denominator = plusDi[index] + minusDi[index];
    return denominator === 0 ? 0 : 100 * Math.abs(plusDi[index] - minusDi[index]) / denominator;
  });
  const adx = wilderValuesFrom(dx, length, length);
  return { adx, plusDi, minusDi };
}

function awesomeOscillator(bars: readonly MarketBar[]) {
  const median = bars.map((bar) => (bar.high + bar.low) / 2);
  const fast = movingAverage(median, 5);
  const slow = movingAverage(median, 34);
  return median.map((_, index) => Number.isFinite(fast[index]) && Number.isFinite(slow[index])
    ? fast[index] - slow[index]
    : Number.NaN);
}

function momentum(values: readonly number[], length: number) {
  return values.map((value, index) => index < length ? Number.NaN : value - values[index - length]);
}

function stochasticRsi(bars: readonly MarketBar[]) {
  const rsiByTime = new Map(
    computeWilderRsiSeries(bars, { length: 14, source: "終値" })
      .map((point) => [point.time, point.value] as const),
  );
  const rsi = bars.map((bar) => rsiByTime.get(bar.time) ?? Number.NaN);
  const raw = rsi.map((value, index) => {
    if (!Number.isFinite(value) || index < 13) return Number.NaN;
    const window = rsi.slice(index - 13, index + 1);
    if (window.some((item) => !Number.isFinite(item))) return Number.NaN;
    const low = Math.min(...window);
    const high = Math.max(...window);
    return high === low ? 0 : 100 * (value - low) / (high - low);
  });
  const k = movingAverage(raw, 3);
  const d = movingAverage(k, 3);
  return { k, d };
}

function williamsPercentR(bars: readonly MarketBar[], length: number) {
  return bars.map((bar, index) => {
    if (index < length - 1) return Number.NaN;
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let cursor = index - length + 1; cursor <= index; cursor += 1) {
      high = Math.max(high, bars[cursor].high);
      low = Math.min(low, bars[cursor].low);
    }
    return high === low ? -50 : -100 * (high - bar.close) / (high - low);
  });
}

function ultimateOscillator(bars: readonly MarketBar[]) {
  const buyingPressure = bars.map((bar, index) => index === 0
    ? Number.NaN
    : bar.close - Math.min(bar.low, bars[index - 1].close));
  const trueRange = bars.map((bar, index) => index === 0
    ? Number.NaN
    : Math.max(bar.high, bars[index - 1].close) - Math.min(bar.low, bars[index - 1].close));
  const ratio = (index: number, length: number) => {
    if (index < length) return Number.NaN;
    let pressure = 0;
    let range = 0;
    for (let cursor = index - length + 1; cursor <= index; cursor += 1) {
      if (!Number.isFinite(buyingPressure[cursor]) || !Number.isFinite(trueRange[cursor])) return Number.NaN;
      pressure += buyingPressure[cursor];
      range += trueRange[cursor];
    }
    return range === 0 ? 0.5 : pressure / range;
  };
  return bars.map((_, index) => {
    const fast = ratio(index, 7);
    const middle = ratio(index, 14);
    const slow = ratio(index, 28);
    return [fast, middle, slow].every(Number.isFinite)
      ? 100 * (4 * fast + 2 * middle + slow) / 7
      : Number.NaN;
  });
}

function buildOscillatorSignals(bars: readonly MarketBar[]) {
  const group = "oscillators" as const;
  if (bars.length === 0) {
    return [
      unavailableSignal("rsi14", "RSI 14", group),
      unavailableSignal("stochastic1433", "Stochastic 14, 3, 3", group),
      unavailableSignal("cci20", "CCI 20", group),
      unavailableSignal("adx1414", "ADX 14, 14", group),
      unavailableSignal("awesome_oscillator", "Awesome Oscillator", group),
      unavailableSignal("momentum10", "Momentum 10", group),
      unavailableSignal("macd12269", "MACD 12, 26, 9", group),
      unavailableSignal("stochastic_rsi331414", "Stochastic RSI 3, 3, 14, 14", group),
      unavailableSignal("williams_r14", "Williams %R 14", group),
      unavailableSignal("bull_bear_power13", "Bull Bear Power 13", group),
      unavailableSignal("ultimate_oscillator71428", "Ultimate Oscillator 7, 14, 28", group),
    ];
  }

  const signals: TechnicalRatingSignal[] = [];
  const ema13 = computeIndicatorSeries(bars, { id: "ema50", length: 13, source: "終値" });
  const ema13Current = latestSeriesValue(ema13, "ema");
  const ema13Previous = latestSeriesValue(ema13, "ema", 1);
  const rsi = computeIndicatorSeries(bars, { id: "rsi14", length: 14, source: "終値" });
  const rsiCurrent = latestSeriesValue(rsi, "rsi");
  const rsiPrevious = latestSeriesValue(rsi, "rsi", 1);
  signals.push(assessedSignal({
    id: "rsi14",
    label: "RSI 14",
    group,
    value: rsiCurrent,
    available: rsiPrevious !== undefined,
    buy: rsiCurrent !== undefined && rsiPrevious !== undefined && rsiCurrent < 30 && rsiCurrent > rsiPrevious,
    sell: rsiCurrent !== undefined && rsiPrevious !== undefined && rsiCurrent > 70 && rsiCurrent < rsiPrevious,
  }));

  const stochastic = computeIndicatorSeries(bars, {
    id: "stochastic",
    length: 14,
    smoothing: 3,
    signal: 3,
    source: "終値",
  });
  const stochasticK = latestSeriesValue(stochastic, "k");
  const stochasticD = latestSeriesValue(stochastic, "d");
  signals.push(assessedSignal({
    id: "stochastic1433",
    label: "Stochastic 14, 3, 3",
    group,
    value: stochasticK,
    secondaryValue: stochasticD,
    available: stochasticK !== undefined && stochasticD !== undefined,
    buy: stochasticK !== undefined && stochasticD !== undefined
      && stochasticK < 20 && stochasticD < 20 && stochasticK > stochasticD,
    sell: stochasticK !== undefined && stochasticD !== undefined
      && stochasticK > 80 && stochasticD > 80 && stochasticK < stochasticD,
  }));

  const cci = commodityChannelIndex(bars, 20);
  const cciCurrent = cci.at(-1);
  const cciPrevious = cci.at(-2);
  signals.push(assessedSignal({
    id: "cci20",
    label: "CCI 20",
    group,
    value: cciCurrent,
    available: finiteNumber(cciPrevious),
    buy: finiteNumber(cciCurrent) && finiteNumber(cciPrevious) && cciCurrent < -100 && cciCurrent > cciPrevious,
    sell: finiteNumber(cciCurrent) && finiteNumber(cciPrevious) && cciCurrent > 100 && cciCurrent < cciPrevious,
  }));

  const dmi = directionalMovement(bars, 14);
  const adx = dmi.adx.at(-1);
  const previousAdx = dmi.adx.at(-2);
  const plusDi = dmi.plusDi.at(-1);
  const minusDi = dmi.minusDi.at(-1);
  const dmiAvailable = [adx, previousAdx, plusDi, minusDi].every(finiteNumber);
  signals.push(assessedSignal({
    id: "adx1414",
    label: "ADX 14, 14",
    group,
    value: adx,
    secondaryValue: plusDi,
    available: dmiAvailable,
    buy: dmiAvailable && plusDi! > minusDi! && adx! > 20 && adx! > previousAdx!,
    // TradingView's published rule is intentionally asymmetric: a bearish DI
    // lead is a sell only when ADX is above 20 and falling from the prior bar.
    sell: dmiAvailable && plusDi! < minusDi! && adx! > 20 && adx! < previousAdx!,
  }));

  const awesome = awesomeOscillator(bars);
  const aoCurrent = awesome.at(-1);
  const aoPrevious = awesome.at(-2);
  const aoPrior = awesome.at(-3);
  const aoAvailable = [aoCurrent, aoPrevious, aoPrior].every(finiteNumber);
  signals.push(assessedSignal({
    id: "awesome_oscillator",
    label: "Awesome Oscillator",
    group,
    value: aoCurrent,
    available: aoAvailable,
    buy: aoAvailable && (
      (aoCurrent! > 0 && aoPrevious! <= 0)
      || (aoCurrent! > 0 && aoPrevious! > 0 && aoCurrent! > aoPrevious! && aoPrevious! < aoPrior!)
    ),
    sell: aoAvailable && (
      (aoCurrent! < 0 && aoPrevious! >= 0)
      || (aoCurrent! < 0 && aoPrevious! < 0 && aoCurrent! < aoPrevious! && aoPrevious! > aoPrior!)
    ),
  }));

  const momentumValues = momentum(bars.map((bar) => bar.close), 10);
  const momentumCurrent = momentumValues.at(-1);
  const momentumPrevious = momentumValues.at(-2);
  signals.push(assessedSignal({
    id: "momentum10",
    label: "Momentum 10",
    group,
    value: momentumCurrent,
    available: finiteNumber(momentumPrevious),
    buy: finiteNumber(momentumCurrent) && finiteNumber(momentumPrevious) && momentumCurrent > momentumPrevious,
    sell: finiteNumber(momentumCurrent) && finiteNumber(momentumPrevious) && momentumCurrent < momentumPrevious,
  }));

  const macd = computeIndicatorSeries(bars, {
    id: "macd",
    fast: 12,
    slow: 26,
    signal: 9,
    source: "終値",
  });
  const macdCurrent = latestSeriesValue(macd, "macd");
  const macdSignal = latestSeriesValue(macd, "signal");
  signals.push(assessedSignal({
    id: "macd12269",
    label: "MACD 12, 26, 9",
    group,
    value: macdCurrent,
    secondaryValue: macdSignal,
    available: macdCurrent !== undefined && macdSignal !== undefined,
    buy: macdCurrent !== undefined && macdSignal !== undefined && macdCurrent > macdSignal,
    sell: macdCurrent !== undefined && macdSignal !== undefined && macdCurrent < macdSignal,
  }));

  const stochRsi = stochasticRsi(bars);
  const stochRsiK = stochRsi.k.at(-1);
  const stochRsiD = stochRsi.d.at(-1);
  const latestClose = bars.at(-1)?.close;
  const stochRsiAvailable = [stochRsiK, stochRsiD, latestClose, ema13Current].every(finiteNumber);
  signals.push(assessedSignal({
    id: "stochastic_rsi331414",
    label: "Stochastic RSI 3, 3, 14, 14",
    group,
    value: stochRsiK,
    secondaryValue: stochRsiD,
    available: stochRsiAvailable,
    buy: stochRsiAvailable
      && latestClose! < ema13Current!
      && stochRsiK! < 20
      && stochRsiD! < 20
      && stochRsiK! > stochRsiD!,
    sell: stochRsiAvailable
      && latestClose! > ema13Current!
      && stochRsiK! > 80
      && stochRsiD! > 80
      && stochRsiK! < stochRsiD!,
  }));

  const williams = williamsPercentR(bars, 14);
  const williamsCurrent = williams.at(-1);
  const williamsPrevious = williams.at(-2);
  signals.push(assessedSignal({
    id: "williams_r14",
    label: "Williams %R 14",
    group,
    value: williamsCurrent,
    available: finiteNumber(williamsPrevious),
    buy: finiteNumber(williamsCurrent) && finiteNumber(williamsPrevious)
      && williamsCurrent < -80 && williamsCurrent > williamsPrevious,
    sell: finiteNumber(williamsCurrent) && finiteNumber(williamsPrevious)
      && williamsCurrent > -20 && williamsCurrent < williamsPrevious,
  }));

  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const bullPower = latest && ema13Current !== undefined ? latest.high - ema13Current : undefined;
  const previousBullPower = previous && ema13Previous !== undefined ? previous.high - ema13Previous : undefined;
  const bearPower = latest && ema13Current !== undefined ? latest.low - ema13Current : undefined;
  const previousBearPower = previous && ema13Previous !== undefined ? previous.low - ema13Previous : undefined;
  const powerAvailable = [
    ema13Current,
    ema13Previous,
    bullPower,
    previousBullPower,
    bearPower,
    previousBearPower,
  ].every(finiteNumber);
  signals.push(assessedSignal({
    id: "bull_bear_power13",
    label: "Bull Bear Power 13",
    group,
    value: bullPower,
    secondaryValue: bearPower,
    available: powerAvailable,
    buy: powerAvailable
      && ema13Current! > ema13Previous!
      && bearPower! < 0
      && bearPower! > previousBearPower!,
    sell: powerAvailable
      && ema13Current! < ema13Previous!
      && bullPower! > 0
      && bullPower! < previousBullPower!,
  }));

  const ultimate = ultimateOscillator(bars).at(-1);
  signals.push(assessedSignal({
    id: "ultimate_oscillator71428",
    label: "Ultimate Oscillator 7, 14, 28",
    group,
    value: ultimate,
    buy: finiteNumber(ultimate) && ultimate > 70,
    sell: finiteNumber(ultimate) && ultimate < 30,
  }));
  return signals;
}

/** Build a TradingView-style 26-component rating from real canonical OHLCV. */
export function buildStockDetailTechnicalRatings(
  inputBars: readonly MarketBar[],
): TechnicalRatingSummary {
  const bars = normalizeTechnicalRatingBars(inputBars);
  const movingAverageSignals = buildMovingAverageSignals(bars);
  const oscillatorSignals = buildOscillatorSignals(bars);
  const movingAverages = summarizeSignals(movingAverageSignals);
  const oscillators = summarizeSignals(oscillatorSignals);
  const availableGroupScores = [movingAverages.score, oscillators.score]
    .filter((score): score is number => score !== null);
  const overallScore = availableGroupScores.length === 0
    ? null
    : availableGroupScores.reduce((sum, score) => sum + score, 0) / availableGroupScores.length;
  const overall = summarizeSignals(
    [...movingAverageSignals, ...oscillatorSignals],
    overallScore,
  );
  return {
    asOf: bars.at(-1)?.time ?? null,
    barCount: bars.length,
    overall,
    movingAverages,
    oscillators,
  };
}
