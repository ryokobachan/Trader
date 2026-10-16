import assert from "node:assert/strict";
import test from "node:test";

import {
  strategyListMetricsForDuration,
  strategyPeriodStart,
  type StrategyPeriodArtifacts,
} from "../src/app/features/strategy/period-performance";
import { strategyPackageById } from "../src/app/features/strategy/catalog";
import type { StrategyPerformance } from "../src/app/platform/strategy-contracts";

const RECORDED_PERFORMANCE: StrategyPerformance = {
  provenance: "backtest_artifact",
  netReturn: 20,
  maxDrawdown: -18,
  recoveryFactor: 20 / 18,
  sharpe: 1.25,
  forwardReturn: null,
  winRate: 75,
  trades: 4,
  symbols: 2,
  cash: 10,
};

const ARTIFACTS: StrategyPeriodArtifacts = {
  equity: {
    initialValue: 100,
    points: [
      { date: "2025-09-30", portfolioValue: 100 },
      { date: "2025-10-31", portfolioValue: 110 },
      { date: "2025-11-28", portfolioValue: 90 },
      { date: "2025-12-31", portfolioValue: 120 },
    ],
  },
  run: {
    reproducibility: {
      annualizationDays: 252,
      periodicRiskFreeRate: 0,
    },
  },
  // Deliberately newest-first, matching the generated package catalog.
  transactions: [
    { transactionId: "vbt-order-0001-00000003", date: "2025-12-10", symbol: "MSFT", side: "sell", shares: 1, price: 90, fee: 0 },
    { transactionId: "vbt-order-0001-00000002", date: "2025-11-03", symbol: "MSFT", side: "buy", shares: 1, price: 100, fee: 0 },
    { transactionId: "vbt-order-0000-00000001", date: "2025-10-15", symbol: "AAPL", side: "sell", shares: 1, price: 110, fee: 0 },
    { transactionId: "vbt-order-0000-00000000", date: "2025-01-02", symbol: "AAPL", side: "buy", shares: 1, price: 100, fee: 0 },
  ],
};

function closeTo(actual: number | null, expected: number, tolerance = 1e-10) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) <= tolerance, `${actual} != ${expected}`);
}

test("strategy period boundaries clamp month ends and leap years", () => {
  assert.equal(strategyPeriodStart("2025-12-31", "1M"), "2025-11-30");
  assert.equal(strategyPeriodStart("2024-03-31", "1M"), "2024-02-29");
  assert.equal(strategyPeriodStart("2025-02-28", "1Y"), "2024-02-28");
  assert.equal(strategyPeriodStart("2025-12-31", "YTD"), "2025-01-01");
  assert.equal(strategyPeriodStart("2025-12-31", "ALL"), null);
});

test("measured period metrics use the last close before the boundary", () => {
  const threeMonths = strategyListMetricsForDuration(
    RECORDED_PERFORMANCE,
    "3M",
    ARTIFACTS,
  );
  closeTo(threeMonths.profit, 20);
  closeTo(threeMonths.maxDrawdown, (90 / 110 - 1) * 100);
  closeTo(threeMonths.recoveryFactor, 1.1);
  closeTo(threeMonths.winRate, 50);
  assert.notEqual(threeMonths.sharpe, RECORDED_PERFORMANCE.sharpe);

  const oneMonth = strategyListMetricsForDuration(
    RECORDED_PERFORMANCE,
    "1M",
    ARTIFACTS,
  );
  closeTo(oneMonth.profit, (120 / 90 - 1) * 100);
  assert.equal(oneMonth.maxDrawdown, 0);
  assert.equal(oneMonth.recoveryFactor, null);
  assert.equal(oneMonth.sharpe, null);
  assert.equal(oneMonth.winRate, 0);
});

test("all-time uses the validated snapshot and scoped metrics require artifacts", () => {
  assert.deepEqual(
    strategyListMetricsForDuration(RECORDED_PERFORMANCE, "全期間", ARTIFACTS),
    {
      profit: 20,
      maxDrawdown: -18,
      recoveryFactor: 20 / 18,
      sharpe: 1.25,
      winRate: 75,
    },
  );
  assert.deepEqual(
    strategyListMetricsForDuration(RECORDED_PERFORMANCE, "1M"),
    {
      profit: null,
      maxDrawdown: null,
      recoveryFactor: null,
      sharpe: null,
      winRate: null,
    },
  );
});

test("current package metrics change with the selected duration", () => {
  const goldenCross = strategyPackageById("portfolio-golden-cross");
  assert.ok(goldenCross?.equity && goldenCross.run);
  const allTime = strategyListMetricsForDuration(
    goldenCross.performance,
    "全期間",
    goldenCross,
  );
  const oneMonth = strategyListMetricsForDuration(
    goldenCross.performance,
    "1M",
    goldenCross,
  );
  assert.equal(allTime.profit, goldenCross.performance.netReturn);
  assert.notEqual(oneMonth.profit, allTime.profit);
  assert.notEqual(oneMonth.maxDrawdown, allTime.maxDrawdown);
  assert.notEqual(oneMonth.sharpe, allTime.sharpe);
});
