import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_SAMPLE_STRATEGY_ID,
  SAMPLE_STRATEGY_DEFINITIONS,
  sampleStrategiesForLocale,
} from "../strategies/catalog";

test("ships a clear, conservative built-in strategy sample catalog", () => {
  const strategies = sampleStrategiesForLocale("en");
  assert.equal(strategies.length, 10);
  assert.equal(DEFAULT_SAMPLE_STRATEGY_ID, strategies[0].id);
  assert.equal(new Set(strategies.map(({ id }) => id)).size, strategies.length);

  for (const strategy of strategies) {
    assert.match(strategy.id, /^sample\.[a-z0-9.-]+\.v1$/);
    assert.ok(strategy.name.length > 3);
    assert.ok(strategy.headline.length > 12);
    assert.ok(strategy.netReturn >= -25 && strategy.netReturn <= 30);
    assert.ok(strategy.maxDrawdown < 0 && strategy.maxDrawdown >= -35);
    assert.ok(strategy.sharpe === null || Math.abs(strategy.sharpe) <= 1.5);
    assert.ok(Math.abs(strategy.forwardReturn) <= 10);
    assert.equal(strategy.audit.overfit, null);
    assert.equal(strategy.audit.leakage, null);
  }
});

test("localizes sample strategy copy without changing stable identifiers or metrics", () => {
  const english = sampleStrategiesForLocale("en");
  const japanese = sampleStrategiesForLocale("ja");

  assert.deepEqual(english.map(({ id }) => id), japanese.map(({ id }) => id));
  assert.deepEqual(english.map(({ netReturn }) => netReturn), japanese.map(({ netReturn }) => netReturn));
  assert.equal(english[0].name, "Tech Leaders Equal Weight");
  assert.equal(japanese[0].name, "米国テック4銘柄・等加重");
  assert.equal(english[1].category, "Trend following");
  assert.equal(japanese[1].category, "トレンドフォロー");

  english[0].sourceLabels.push("mutated");
  assert.equal(sampleStrategiesForLocale("en")[0].sourceLabels.includes("mutated"), false);
});

test("applies durable presentation overrides and soft-delete tombstones", () => {
  const now = "2026-08-09T12:00:00.000Z";
  const [first, second] = sampleStrategiesForLocale("en");
  const strategies = sampleStrategiesForLocale("ja", [
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
  ]);

  assert.equal(strategies[0].name, "My edited strategy");
  assert.equal(strategies[0].headline, "A durable custom description.");
  assert.equal(strategies.some(({ id }) => id === second.id), false);
  assert.equal(strategies[0].category, "ポートフォリオ");
});

test("keeps sample strategy definitions outside the page composition root", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const fixtureSource = await readFile(
    new URL("../strategies/catalog.ts", import.meta.url),
    "utf8",
  );

  assert.match(pageSource, /sampleStrategiesForLocale\(locale\)/);
  assert.match(pageSource, /DEFAULT_SAMPLE_STRATEGY_ID/);
  assert.doesNotMatch(pageSource, /const STRATEGIES:/);
  assert.doesNotMatch(fixtureSource, /Portfolio2|TradingAgents|13Fユニーク|X品質/);
  assert.equal(SAMPLE_STRATEGY_DEFINITIONS.every(({ id }) => id.startsWith("sample.")), true);
});
