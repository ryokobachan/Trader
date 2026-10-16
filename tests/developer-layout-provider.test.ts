import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

import rawConfig from "../api/config.json" with { type: "json" };
import { listInstalledProviderSources } from "../api/index.server";

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("keeps developer-owned APIs and strategy packages at the root and Core under src", async () => {
  for (const path of [
    "api/config.json",
    "api/README.md",
    "api/yahoo/chart.ts",
    "api/yahoo/fundamentals/bs.ts",
    "api/provider-roles.ts",
    "api/environment.ts",
    "api/stock-detail/ids.ts",
    "api/stock-detail/metrics.ts",
    "strategies/portfolio-fundamental-quality-value/config.json",
    "strategies/portfolio-fundamental-quality-value/equity.json",
    "strategies/portfolio-fundamental-quality-value/main.py",
    "strategies/portfolio-fundamental-quality-value/performance.json",
    "strategies/portfolio-fundamental-quality-value/run.json",
    "strategies/portfolio-fundamental-quality-value/transactions.json",
    "strategies/portfolio-golden-cross/config.json",
    "strategies/portfolio-golden-cross/equity.json",
    "strategies/portfolio-golden-cross/main.py",
    "strategies/portfolio-golden-cross/performance.json",
    "strategies/portfolio-golden-cross/run.json",
    "strategies/portfolio-golden-cross/transactions.json",
    "strategies/portfolio-lightgbm-ranking/config.json",
    "strategies/portfolio-lightgbm-ranking/main.py",
    "strategies/portfolio-lightgbm-ranking/performance.json",
    "strategies/portfolio-lightgbm-ranking/transactions.json",
    "src/app/features/strategy/i18n.ts",
    "src/app/features/strategy/metrics.ts",
    "src/app/features/strategy/metric-ids.ts",
    "extensions/index.ts",
    "extensions/README.md",
    "src/app/page.tsx",
    "src/app/api/v1/symbols/[symbol]/workspace/route.ts",
    "src/db/schema.ts",
    "src/db/drizzle.config.ts",
    "src/db/migrations/0000_lumpy_silver_samurai.sql",
    "src/worker/index.ts",
  ]) {
    assert.equal(await exists(path), true, `${path} must exist`);
  }

  for (const obsoleteRoot of ["app", "config", "db", "drizzle", "drizzle.config.ts", "worker", "services", "scripts", ".github", "public/company-logos"]) {
    assert.equal(await exists(obsoleteRoot), false, `${obsoleteRoot}/ must stay consolidated`);
  }
  assert.equal(await exists("src/app/plugins"), false, "developer UI registrations belong in extensions/");
  const strategyEntries = await readdir("strategies", { withFileTypes: true });
  assert.equal(strategyEntries.every((entry) => entry.isDirectory()), true);
  assert.deepEqual(
    strategyEntries.map(({ name }) => name).sort(),
    [
      "portfolio-fundamental-quality-value",
      "portfolio-golden-cross",
      "portfolio-lightgbm-ranking",
    ],
  );
  for (const strategyId of ["portfolio-lightgbm-ranking"]) {
    assert.equal(
      await exists(`strategies/${strategyId}/run.json`),
      false,
      "an unexecuted strategy package must not fabricate run metadata",
    );
    assert.equal(
      await exists(`strategies/${strategyId}/equity.json`),
      false,
      "an unexecuted strategy package must not fabricate an equity curve",
    );
  }
});

test("every configured provider ID maps to a reviewed file under its matching api folder", async () => {
  const sources = new Map(listInstalledProviderSources().map(({ id, source }) => [id, source]));
  const selectedIds = new Set(
    Object.values(rawConfig.providers).filter((id): id is string => typeof id === "string"),
  );

  for (const [id, source] of sources) {
    assert.ok(source.startsWith(`api/${id}/`), `${id} must map to its matching folder`);
    await readFile(new URL(`../${source}`, import.meta.url), "utf8");
  }

  for (const id of selectedIds) assert.ok(sources.has(id), `${id} must be registered`);
});

test("package run snapshots are source-controlled while mutable history stays in D1", async () => {
  const [packageTransactions, packageRunSource, fundamentalRunSource, fundamentalEquitySource, storeSource, guide] = await Promise.all([
    readFile(new URL("../strategies/portfolio-golden-cross/transactions.json", import.meta.url), "utf8"),
    readFile(new URL("../strategies/portfolio-golden-cross/run.json", import.meta.url), "utf8"),
    readFile(new URL("../strategies/portfolio-fundamental-quality-value/run.json", import.meta.url), "utf8"),
    readFile(new URL("../strategies/portfolio-fundamental-quality-value/equity.json", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/platform/strategy-portfolio-transactions.server.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../docs/strategy-packages.md", import.meta.url), "utf8"),
  ]);

  assert.match(packageTransactions, /trader\.strategy-transactions\.v1/);
  const packageRun = JSON.parse(packageRunSource) as {
    schemaVersion: string;
    strategyId: string;
    runId: string;
    data: { symbols: string[]; sha256: string };
    execution: { orderCount: number };
  };
  assert.equal(packageRun.schemaVersion, "trader.strategy-run.v1");
  assert.equal(packageRun.strategyId, "portfolio-golden-cross");
  assert.match(packageRun.runId, /^run-[a-f0-9]{24}$/);
  assert.equal(packageRun.data.symbols.length, 10);
  assert.match(packageRun.data.sha256, /^[a-f0-9]{64}$/);
  assert.equal(packageRun.execution.orderCount, 1107);

  const fundamentalRun = JSON.parse(fundamentalRunSource) as {
    schemaVersion: string;
    strategyId: string;
    runId: string;
    data: { provider: string; symbols: string[] };
    execution: { orderCount: number; finalValue: number };
  };
  assert.equal(fundamentalRun.schemaVersion, "trader.strategy-run.v1");
  assert.equal(fundamentalRun.strategyId, "portfolio-fundamental-quality-value");
  assert.equal(fundamentalRun.runId, "run-9b313a3e7ab03e4b5e715824");
  assert.equal(fundamentalRun.data.provider, "yfinance+sec-edgar-companyfacts");
  assert.equal(fundamentalRun.data.symbols.length, 15);
  assert.equal(fundamentalRun.execution.orderCount, 302);
  assert.equal(fundamentalRun.execution.finalValue, 468102.57934341935);

  const fundamentalEquity = JSON.parse(fundamentalEquitySource) as {
    schemaVersion: string;
    strategyId: string;
    runId: string;
    frequency: string;
    initialValue: number;
    points: Array<{ date: string; portfolioValue: number; benchmarkValue: number }>;
  };
  assert.equal(fundamentalEquity.schemaVersion, "trader.strategy-equity.v1");
  assert.equal(fundamentalEquity.strategyId, fundamentalRun.strategyId);
  assert.equal(fundamentalEquity.runId, fundamentalRun.runId);
  assert.equal(fundamentalEquity.frequency, "1d");
  assert.equal(fundamentalEquity.initialValue, 100000);
  assert.equal(fundamentalEquity.points.length, 2262);
  assert.deepEqual(fundamentalEquity.points.at(-1), {
    date: "2025-12-31",
    portfolioValue: 468102.57934341935,
    benchmarkValue: 303189.33503112866,
  });
  assert.match(storeSource, /getD1\(\)/);
  assert.match(guide, /read-only/i);
  assert.match(guide, /separate ledger/i);
});
