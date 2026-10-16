import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_STRATEGY_PACKAGE_ID,
  RETIRED_SAMPLE_STRATEGY_IDS,
  STRATEGY_PACKAGE_DEFINITIONS,
  strategyPackagesForLocale,
} from "../src/app/features/strategy/catalog";

test("loads deployment strategies from direct child packages", async () => {
  const strategies = strategyPackagesForLocale("en");
  assert.deepEqual(strategies.map(({ id }) => id), [
    "portfolio-golden-cross",
    "portfolio-lightgbm-ranking",
    "portfolio-fundamental-quality-value",
  ]);
  assert.equal(DEFAULT_STRATEGY_PACKAGE_ID, strategies[0]?.id);
  assert.equal(new Set(strategies.map(({ id }) => id)).size, strategies.length);
  assert.equal(RETIRED_SAMPLE_STRATEGY_IDS.length, 10);

  const rootEntries = await readdir("strategies", { withFileTypes: true });
  assert.equal(rootEntries.every((entry) => entry.isDirectory()), true);
  assert.deepEqual(
    rootEntries.map(({ name }) => name).sort(),
    strategies.map(({ id }) => id).sort(),
  );

  for (const strategy of strategies) {
    assert.match(strategy.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.equal(strategy.family, "portfolio2");
    assert.equal(strategy.status, "research");
    assert.ok(strategy.headline.toLowerCase().includes("portfolio"));
  }

  const [goldenCross, lightgbm, fundamental] = strategies;
  assert.ok(goldenCross && lightgbm && fundamental);
  assert.equal(goldenCross.performance.provenance, "backtest_artifact");
  assert.equal(goldenCross.performance.forwardReturn, null);
  assert.equal(goldenCross.performance.trades, 1107);
  assert.equal(goldenCross.performance.symbols, 10);
  assert.ok(goldenCross.performance.netReturn !== null && goldenCross.performance.netReturn > 0);
  assert.ok(goldenCross.performance.maxDrawdown !== null && goldenCross.performance.maxDrawdown < 0);
  assert.ok(
    goldenCross.performance.recoveryFactor !== null
    && Number.isFinite(goldenCross.performance.recoveryFactor)
    && goldenCross.performance.recoveryFactor > 0,
  );
  assert.ok(
    goldenCross.performance.sharpe !== null
    && Number.isFinite(goldenCross.performance.sharpe),
  );
  assert.ok(
    goldenCross.performance.winRate !== null
    && goldenCross.performance.winRate >= 0
    && goldenCross.performance.winRate <= 100,
  );
  assert.ok(
    goldenCross.performance.cash !== null
    && goldenCross.performance.cash >= 0
    && goldenCross.performance.cash <= 100,
  );

  assert.equal(lightgbm.performance.provenance, "unavailable");
  assert.equal(
    Object.values(lightgbm.performance).slice(1).every((value) => value === null),
    true,
  );
  assert.deepEqual(fundamental.performance, {
    provenance: "backtest_artifact",
    netReturn: 368.1025793434192,
    maxDrawdown: -17.05929982739528,
    recoveryFactor: 21.57782459232522,
    sharpe: 1.3382241005530606,
    forwardReturn: null,
    winRate: 64.62585034013605,
    trades: 302,
    symbols: 14,
    cash: 79.49085385585573,
  });

  const fundamentalPackage = STRATEGY_PACKAGE_DEFINITIONS.find(
    ({ id }) => id === fundamental.id,
  );
  assert.ok(fundamentalPackage?.run && fundamentalPackage.equity);
  assert.equal(fundamentalPackage.run.runId, "run-9b313a3e7ab03e4b5e715824");
  assert.equal(fundamentalPackage.run.data.provider, "yfinance+sec-edgar-companyfacts");
  assert.equal(fundamentalPackage.run.execution.orderCount, 302);
  assert.equal(fundamentalPackage.run.execution.finalPositions.length, 1);
  assert.equal(fundamentalPackage.transactions.length, 302);
  assert.equal(fundamentalPackage.equity.initialValue, 100000);
  assert.equal(fundamentalPackage.equity.points.length, 2262);
  assert.deepEqual(fundamentalPackage.equity.points[0], {
    date: "2017-01-03",
    portfolioValue: 99950.11054828455,
    benchmarkValue: 100000,
  });
  assert.deepEqual(fundamentalPackage.equity.points.at(-1), {
    date: "2025-12-31",
    portfolioValue: 468102.57934341935,
    benchmarkValue: 303189.33503112866,
  });
});

test("localizes package copy without changing IDs or result provenance", () => {
  const english = strategyPackagesForLocale("en");
  const japanese = strategyPackagesForLocale("ja");
  assert.deepEqual(english.map(({ id }) => id), japanese.map(({ id }) => id));
  assert.deepEqual(
    english.map(({ performance }) => performance),
    japanese.map(({ performance }) => performance),
  );
  assert.equal(english[0]?.name, "Portfolio Golden Cross");
  assert.equal(japanese[0]?.name, "ポートフォリオ・ゴールデンクロス");
  english[0]?.sourceLabels.push("mutated");
  assert.equal(strategyPackagesForLocale("en")[0]?.sourceLabels.includes("mutated"), false);
});

test("applies owner presentation overrides and soft-delete tombstones", () => {
  const now = "2026-08-14T00:00:00.000Z";
  const [first, second, third] = strategyPackagesForLocale("en");
  assert.ok(first && second && third);
  const strategies = strategyPackagesForLocale("ja", [
    {
      strategyId: first.id,
      name: "My edited strategy",
      headline: "A durable custom description.",
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      strategyId: second.id,
      isDeleted: true,
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      strategyId: third.id,
      isDeleted: true,
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  assert.equal(strategies.length, 1);
  assert.equal(strategies[0]?.name, "My edited strategy");
  assert.equal(strategies[0]?.headline, "A durable custom description.");
});

test("keeps generated catalog out of the strategy package root", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(pageSource, /strategyPackagesForLocale\(locale\)/);
  assert.doesNotMatch(pageSource, /const STRATEGIES:/);
  assert.equal(STRATEGY_PACKAGE_DEFINITIONS.length, 3);
  assert.equal(STRATEGY_PACKAGE_DEFINITIONS.every(({ id }) => !id.startsWith("sample.")), true);
});
