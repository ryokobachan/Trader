import type { StrategyPerformance } from "../../platform/strategy-contracts";

export type StrategyDuration = "1M" | "3M" | "6M" | "1Y" | "3Y" | "全期間";

export type StrategyListPeriodMetrics = Readonly<{
  profit: number | null;
  maxDrawdown: number | null;
  recoveryFactor: number | null;
  sharpe: number | null;
  winRate: number | null;
}>;

type StrategyEquityPoint = Readonly<{
  date: string;
  portfolioValue: number;
}>;

type StrategyTransaction = Readonly<{
  transactionId: string;
  date: string;
  symbol: string;
  side: "buy" | "sell" | "dividend";
  shares: number;
  price: number;
  fee: number;
}>;

export type StrategyPeriodArtifacts = Readonly<{
  equity: Readonly<{
    initialValue: number;
    points: readonly StrategyEquityPoint[];
  }> | null;
  run: Readonly<{
    reproducibility: Readonly<{
      annualizationDays: number;
      periodicRiskFreeRate: number;
    }>;
  }> | null;
  transactions: readonly StrategyTransaction[];
}>;

const ILLUSTRATIVE_DURATION_FACTOR: Readonly<Record<StrategyDuration, number>> = {
  "1M": 0.12,
  "3M": 0.31,
  "6M": 0.58,
  "1Y": 1,
  "3Y": 1.68,
  "全期間": 2.14,
};

const UNAVAILABLE_PERIOD_METRICS: StrategyListPeriodMetrics = Object.freeze({
  profit: null,
  maxDrawdown: null,
  recoveryFactor: null,
  sharpe: null,
  winRate: null,
});

function recordedMetrics(performance: StrategyPerformance): StrategyListPeriodMetrics {
  return {
    profit: performance.netReturn,
    maxDrawdown: performance.maxDrawdown,
    recoveryFactor: performance.recoveryFactor,
    sharpe: performance.sharpe,
    winRate: performance.winRate,
  };
}

function daysInUtcMonth(year: number, zeroBasedMonth: number) {
  return new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).getUTCDate();
}

function subtractUtcMonths(isoDate: string, months: number) {
  const latest = new Date(`${isoDate}T00:00:00Z`);
  const latestMonth = latest.getUTCFullYear() * 12 + latest.getUTCMonth();
  const targetMonth = latestMonth - months;
  const year = Math.floor(targetMonth / 12);
  const zeroBasedMonth = targetMonth - year * 12;
  const day = Math.min(
    latest.getUTCDate(),
    daysInUtcMonth(year, zeroBasedMonth),
  );
  return new Date(Date.UTC(year, zeroBasedMonth, day)).toISOString().slice(0, 10);
}

export function strategyPeriodStart(
  latestDate: string,
  period: StrategyDuration | "YTD" | "ALL",
): string | null {
  if (period === "ALL" || period === "全期間") return null;
  if (period === "YTD") return `${latestDate.slice(0, 4)}-01-01`;
  const monthCount: Readonly<Record<Exclude<StrategyDuration, "全期間">, number>> = {
    "1M": 1,
    "3M": 3,
    "6M": 6,
    "1Y": 12,
    "3Y": 36,
  };
  return subtractUtcMonths(latestDate, monthCount[period]);
}

function illustrativeMetrics(performance: StrategyPerformance, duration: StrategyDuration) {
  const factor = ILLUSTRATIVE_DURATION_FACTOR[duration];
  const profit = performance.netReturn === null
    ? null
    : performance.netReturn * factor;
  const maxDrawdown = performance.maxDrawdown === null
    ? null
    : performance.maxDrawdown * Math.min(1.22, 0.38 + factor * 0.62);
  const recoveryFactor = profit === null || maxDrawdown === null
    ? null
    : Math.abs(maxDrawdown) > 0 ? profit / Math.abs(maxDrawdown) : 0;
  const sharpe = performance.sharpe === null
    ? null
    : performance.sharpe * (0.84 + Math.min(factor, 1.4) * 0.16);
  const winRate = performance.winRate === null
    ? null
    : 50 + (performance.winRate - 50) * (0.72 + Math.min(factor, 1.2) * 0.28);
  return { profit, maxDrawdown, recoveryFactor, sharpe, winRate };
}

function maxDrawdownPercent(values: readonly number[]) {
  let peak = values[0];
  if (peak === undefined || peak <= 0) return null;
  let maxDrawdown = 0;
  for (const value of values.slice(1)) {
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
  }
  return maxDrawdown * 100;
}

function annualizedSharpe(
  values: readonly number[],
  annualizationDays: number,
  periodicRiskFreeRate: number,
) {
  if (values.length < 3 || !Number.isFinite(annualizationDays) || annualizationDays <= 0) {
    return null;
  }
  const returns: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous <= 0) return null;
    returns.push(current / previous - 1);
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / (returns.length - 1);
  if (!Number.isFinite(variance) || variance <= 0) return null;
  const sharpe = (mean - periodicRiskFreeRate) / Math.sqrt(variance)
    * Math.sqrt(annualizationDays);
  return Number.isFinite(sharpe) ? sharpe : null;
}

function vectorbtOrderSequence(transactionId: string) {
  const match = /^vbt-order-\d+-(\d+)$/.exec(transactionId);
  return match ? Number.parseInt(match[1], 10) : null;
}

function oldestTransactionFirst(left: StrategyTransaction, right: StrategyTransaction) {
  const byDate = left.date.localeCompare(right.date);
  if (byDate !== 0) return byDate;
  const leftSequence = vectorbtOrderSequence(left.transactionId);
  const rightSequence = vectorbtOrderSequence(right.transactionId);
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  return left.transactionId.localeCompare(right.transactionId);
}

function periodWinRate(
  transactions: readonly StrategyTransaction[],
  afterDate: string | null,
  throughDate: string,
) {
  const positions = new Map<string, { shares: number; totalCost: number }>();
  let closedTrades = 0;
  let winningTrades = 0;

  for (const transaction of [...transactions].sort(oldestTransactionFirst)) {
    if (transaction.date > throughDate) break;
    if (transaction.side === "dividend") continue;
    const position = positions.get(transaction.symbol) ?? { shares: 0, totalCost: 0 };
    if (transaction.side === "buy") {
      position.shares += transaction.shares;
      position.totalCost += transaction.shares * transaction.price + transaction.fee;
      positions.set(transaction.symbol, position);
      continue;
    }

    const tolerance = Math.max(1, position.shares, transaction.shares) * 1e-9;
    if (position.shares <= 0 || position.shares + tolerance < transaction.shares) {
      return null;
    }
    const averageCost = position.totalCost / position.shares;
    const profit = transaction.shares * transaction.price
      - transaction.fee
      - averageCost * transaction.shares;
    if (afterDate === null || transaction.date > afterDate) {
      closedTrades += 1;
      if (profit > 0) winningTrades += 1;
    }
    position.shares -= transaction.shares;
    position.totalCost -= averageCost * transaction.shares;
    if (position.shares <= tolerance) {
      position.shares = 0;
      position.totalCost = 0;
    }
    positions.set(transaction.symbol, position);
  }

  return closedTrades > 0 ? winningTrades / closedTrades * 100 : null;
}

function measuredPeriodMetrics(
  duration: Exclude<StrategyDuration, "全期間">,
  artifacts: StrategyPeriodArtifacts,
): StrategyListPeriodMetrics {
  if (!artifacts.equity || !artifacts.run || artifacts.equity.points.length === 0) {
    return UNAVAILABLE_PERIOD_METRICS;
  }
  const { initialValue, points } = artifacts.equity;
  const latestDate = points[points.length - 1]?.date;
  if (!latestDate) return UNAVAILABLE_PERIOD_METRICS;
  const cutoff = strategyPeriodStart(latestDate, duration);
  if (cutoff === null) return UNAVAILABLE_PERIOD_METRICS;

  let anchorDate: string | null = null;
  let anchorValue = initialValue;
  let firstPeriodPoint = 0;
  while (firstPeriodPoint < points.length && points[firstPeriodPoint]!.date <= cutoff) {
    anchorDate = points[firstPeriodPoint]!.date;
    anchorValue = points[firstPeriodPoint]!.portfolioValue;
    firstPeriodPoint += 1;
  }
  const periodPoints = points.slice(firstPeriodPoint);
  if (periodPoints.length === 0 || anchorValue <= 0) return UNAVAILABLE_PERIOD_METRICS;

  const values = [anchorValue, ...periodPoints.map(({ portfolioValue }) => portfolioValue)];
  const profit = (values[values.length - 1]! / anchorValue - 1) * 100;
  const maxDrawdown = maxDrawdownPercent(values);
  const recoveryFactor = maxDrawdown === null || Math.abs(maxDrawdown) <= 1e-15
    ? null
    : profit / Math.abs(maxDrawdown);
  const { annualizationDays, periodicRiskFreeRate } = artifacts.run.reproducibility;
  return {
    profit,
    maxDrawdown,
    recoveryFactor,
    sharpe: annualizedSharpe(values, annualizationDays, periodicRiskFreeRate),
    winRate: periodWinRate(artifacts.transactions, anchorDate, latestDate),
  };
}

export function strategyListMetricsForDuration(
  performance: StrategyPerformance,
  duration: StrategyDuration,
  artifacts: StrategyPeriodArtifacts | null = null,
): StrategyListPeriodMetrics {
  if (performance.provenance === "illustrative_catalog") {
    return illustrativeMetrics(performance, duration);
  }
  if (duration === "全期間") return recordedMetrics(performance);
  if (performance.provenance !== "backtest_artifact" || artifacts === null) {
    return UNAVAILABLE_PERIOD_METRICS;
  }
  return measuredPeriodMetrics(duration, artifacts);
}
