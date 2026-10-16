import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadStrategyPackages,
  newestTransactionFirst,
  StrategyPackageError,
} from "../src/tooling/strategy-package-loader";

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(
    1e-8,
    Math.max(Math.abs(left), Math.abs(right)) * 1e-9,
  );
}

function vectorbtOrderId(transactionId: string): number {
  const match = /^vbt-order-\d{4}-(\d{8})$/.exec(transactionId);
  assert.ok(match, `expected a VectorBT transaction ID, received ${transactionId}`);
  return Number.parseInt(match[1], 10);
}

async function assertVectorbtLedgerOrder(
  strategyId: string,
  displayedTransactions: readonly Readonly<{ transactionId: string }>[],
): Promise<void> {
  const artifact = JSON.parse(
    await readFile(path.join("strategies", strategyId, "transactions.json"), "utf8"),
  ) as {
    transactions: Array<{
      transactionId: string;
      date: string;
      side: "buy" | "sell" | "dividend";
    }>;
  };
  const artifactOrderIds = artifact.transactions.map(({ transactionId }) => (
    vectorbtOrderId(transactionId)
  ));
  assert.equal(
    artifactOrderIds.every((orderId, index) => index === 0 || artifactOrderIds[index - 1]! < orderId),
    true,
    `${strategyId} artifact must preserve VectorBT execution order`,
  );

  for (const transactions of Map.groupBy(
    artifact.transactions,
    ({ date }) => date,
  ).values()) {
    const lastSell = transactions.findLastIndex(({ side }) => side === "sell");
    const firstBuy = transactions.findIndex(({ side }) => side === "buy");
    if (lastSell >= 0 && firstBuy >= 0) {
      assert.ok(lastSell < firstBuy, `${strategyId} must execute same-bar sells before buys`);
    }
  }

  const displayedOrderIds = displayedTransactions.map(({ transactionId }) => (
    vectorbtOrderId(transactionId)
  ));
  assert.equal(
    displayedOrderIds.every((orderId, index) => index === 0 || displayedOrderIds[index - 1]! > orderId),
    true,
    `${strategyId} display order must be reverse execution order`,
  );
}

test("orders mixed and variable-width transaction IDs with a stable total comparator", () => {
  const row = (transactionId: string) => ({
    transactionId,
    date: "2026-08-14",
    symbol: "AAPL",
    side: "buy" as const,
    shares: 1,
    price: 100,
    fee: 0,
  });
  const rows = [
    row("vbt-order-9999-00000001"),
    row("legacy-5000-x"),
    row("vbt-order-0000-00000002"),
    row("vbt-order-10000-100000000"),
  ];
  const expected = [
    "vbt-order-10000-100000000",
    "vbt-order-0000-00000002",
    "vbt-order-9999-00000001",
    "legacy-5000-x",
  ];
  for (const input of [rows, [...rows].reverse(), [rows[1]!, rows[3]!, rows[0]!, rows[2]!]]) {
    assert.deepEqual(
      input.toSorted(newestTransactionFirst).map(({ transactionId }) => transactionId),
      expected,
    );
  }
});

test("discovers and deterministically validates direct strategy packages", async () => {
  const packages = await loadStrategyPackages("strategies");
  assert.deepEqual(packages.map(({ id }) => id), [
    "portfolio-golden-cross",
    "portfolio-lightgbm-ranking",
    "portfolio-fundamental-quality-value",
  ]);
  const [goldenCross, lightgbm, fundamental] = packages;
  assert.equal(goldenCross.performance.provenance, "backtest_artifact");
  assert.equal(goldenCross.transactions.length, 1107);
  assert.ok(goldenCross.run);
  assert.match(goldenCross.run.runId, /^run-[0-9a-f]{24}$/);
  assert.equal(goldenCross.run.data.provider, "yfinance");
  assert.equal(goldenCross.run.data.interval, "1d");
  assert.ok(goldenCross.run.data.requestedStart < goldenCross.run.data.evaluationStart);
  assert.equal(goldenCross.run.data.requestedEndExclusive, "2026-01-01");
  assert.equal(goldenCross.run.data.evaluationStart, "2016-01-01");
  assert.equal(goldenCross.run.data.evaluationEndExclusive, "2026-01-01");
  assert.equal(goldenCross.run.execution.orderCount, goldenCross.transactions.length);
  assert.equal(
    goldenCross.run.execution.finalPositions.length,
    goldenCross.run.execution.openTradeCount,
  );
  assert.equal(
    new Set(goldenCross.run.execution.finalPositions.map(({ symbol }) => symbol)).size,
    goldenCross.run.execution.finalPositions.length,
  );
  for (const position of goldenCross.run.execution.finalPositions) {
    assert.ok(goldenCross.run.data.symbols.includes(position.symbol));
    assert.ok(approximatelyEqual(position.shares * position.markPrice, position.marketValue));
    assert.ok(approximatelyEqual(
      position.marketValue - position.shares * position.averageCost,
      position.unrealizedPnl,
    ));
    assert.ok(goldenCross.run.execution.finalValue !== null);
    assert.ok(approximatelyEqual(
      position.marketValue / goldenCross.run.execution.finalValue * 100,
      position.allocationPercent,
    ));
  }
  assert.ok(goldenCross.run.execution.finalValue !== null);
  assert.ok(goldenCross.run.execution.finalCashPercent !== null);
  assert.ok(approximatelyEqual(
    goldenCross.run.execution.finalPositions.reduce(
      (sum, position) => sum + position.marketValue,
      0,
    ),
    goldenCross.run.execution.finalValue
      * (1 - goldenCross.run.execution.finalCashPercent / 100),
  ));
  assert.equal(goldenCross.run.benchmark?.symbol, "^GSPC");
  assert.ok(goldenCross.run.warnings.length > 0);
  assert.match(goldenCross.run.reproducibility.runnerSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    Object.keys(goldenCross.run.reproducibility.runtime).sort(),
    ["lightgbm", "numba", "numpy", "pandas", "python", "scipy", "talib", "vectorbt", "yfinance"],
  );
  assert.ok(goldenCross.equity);
  assert.equal(goldenCross.equity.initialValue, 100_000);
  assert.equal(goldenCross.equity.points.length, 2_514);
  assert.equal(goldenCross.equity.points[0].date, "2016-01-04");
  assert.equal(goldenCross.equity.points.at(-1)?.date, "2025-12-31");

  assert.equal(fundamental.performance.provenance, "backtest_artifact");
  assert.equal(fundamental.transactions.length, 302);
  assert.ok(fundamental.run);
  assert.equal(fundamental.run.data.provider, "yfinance+sec-edgar-companyfacts");
  assert.equal(fundamental.run.execution.orderCount, 302);
  assert.equal(fundamental.run.execution.totalFees, 0);
  assert.ok(fundamental.equity);
  assert.equal(fundamental.equity.initialValue, 100_000);
  assert.equal(fundamental.equity.points.length, 2_262);
  assert.equal(fundamental.equity.points[0].date, "2017-01-03");
  assert.equal(fundamental.equity.points.at(-1)?.date, "2025-12-31");
  assert.ok(approximatelyEqual(
    (fundamental.equity.points.at(-1)!.portfolioValue / fundamental.equity.initialValue - 1) * 100,
    fundamental.performance.netReturn!,
  ));
  await assertVectorbtLedgerOrder(goldenCross.id, goldenCross.transactions);
  await assertVectorbtLedgerOrder(fundamental.id, fundamental.transactions);

  for (const unexecuted of [lightgbm]) {
    assert.equal(unexecuted.performance.provenance, "unavailable");
    assert.equal(unexecuted.run, null);
    assert.equal(unexecuted.equity, null);
    assert.deepEqual(unexecuted.transactions, []);
  }
});

async function temporaryPackage(strategyId = "portfolio-golden-cross") {
  const root = await mkdtemp(path.join(tmpdir(), "trader-strategy-loader-"));
  const target = path.join(root, strategyId);
  await cp(path.join("strategies", strategyId), target, { recursive: true });
  return { root, target };
}

test("fails closed for corrupt, incomplete, or mismatched package artifacts", async () => {
  const mutations: Array<(target: string) => Promise<void>> = [
    async (target) => writeFile(path.join(target, "config.json"), "{", "utf8"),
    async (target) => {
      const file = path.join(target, "config.json");
      const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      config.id = "different-id";
      await writeFile(file, JSON.stringify(config), "utf8");
    },
    async (target) => unlink(path.join(target, "performance.json")),
    async (target) => {
      const file = path.join(target, "transactions.json");
      const artifact = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      artifact.transactions = [
        { transactionId: "same", date: "2026-08-14", symbol: "AAPL", side: "buy", shares: 1, price: 100, fee: 1 },
        { transactionId: "same", date: "2026-08-14", symbol: "MSFT", side: "buy", shares: 1, price: 100, fee: 1 },
      ];
      await writeFile(file, JSON.stringify(artifact), "utf8");
    },
  ];

  for (const mutate of mutations) {
    const { root, target } = await temporaryPackage();
    try {
      await mutate(target);
      await assert.rejects(() => loadStrategyPackages(root), StrategyPackageError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("requires run.json exactly for executed packages and matches its identity", async () => {
  const mutations: Array<(target: string) => Promise<void>> = [
    async (target) => unlink(path.join(target, "run.json")),
    async (target) => {
      const file = path.join(target, "run.json");
      const run = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      run.strategyId = "portfolio-lightgbm-ranking";
      await writeFile(file, JSON.stringify(run), "utf8");
    },
    async (target) => {
      const file = path.join(target, "run.json");
      const run = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      (run.data as Record<string, unknown>).unknown = true;
      await writeFile(file, JSON.stringify(run), "utf8");
    },
    async (target) => {
      const file = path.join(target, "run.json");
      const run = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      (run.reproducibility as Record<string, unknown>).runnerSha256 = "not-a-sha256";
      await writeFile(file, JSON.stringify(run), "utf8");
    },
    async (target) => {
      const file = path.join(target, "run.json");
      const run = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      (run.execution as Record<string, unknown>).orderCount = -1;
      await writeFile(file, JSON.stringify(run), "utf8");
    },
  ];

  for (const mutate of mutations) {
    const { root, target } = await temporaryPackage();
    try {
      await mutate(target);
      await assert.rejects(() => loadStrategyPackages(root), StrategyPackageError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("fails closed when final position state is incomplete or irreconcilable", async () => {
  const mutations: Array<(run: Record<string, unknown>) => void> = [
    (run) => {
      delete (run.execution as Record<string, unknown>).finalPositions;
    },
    (run) => {
      const execution = run.execution as { finalPositions: Array<Record<string, unknown>> };
      execution.finalPositions[1].symbol = execution.finalPositions[0].symbol;
    },
    (run) => {
      const execution = run.execution as { finalPositions: Array<Record<string, unknown>> };
      execution.finalPositions[0].symbol = "ZZZZZ";
    },
    (run) => {
      const execution = run.execution as { finalPositions: Array<Record<string, unknown>> };
      execution.finalPositions[0].shares = -1;
    },
    (run) => {
      const execution = run.execution as { finalPositions: Array<Record<string, unknown>> };
      execution.finalPositions[0].unrealizedPnl = (
        execution.finalPositions[0].unrealizedPnl as number
      ) + 1;
    },
    (run) => {
      const execution = run.execution as { finalPositions: Array<Record<string, unknown>> };
      execution.finalPositions.pop();
    },
    (run) => {
      const execution = run.execution as { finalPositions: Array<Record<string, unknown>> };
      execution.finalPositions[0].allocationPercent = (
        execution.finalPositions[0].allocationPercent as number
      ) + 1;
    },
  ];

  for (const mutate of mutations) {
    const { root, target } = await temporaryPackage();
    try {
      const file = path.join(target, "run.json");
      const run = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      mutate(run);
      await writeFile(file, JSON.stringify(run), "utf8");
      await assert.rejects(() => loadStrategyPackages(root), StrategyPackageError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("validates optional measured equity and fails closed on mismatched series", async () => {
  const legacy = await temporaryPackage("portfolio-fundamental-quality-value");
  try {
    await unlink(path.join(legacy.target, "equity.json"));
    const [loaded] = await loadStrategyPackages(legacy.root);
    assert.equal(loaded.equity, null);
  } finally {
    await rm(legacy.root, { recursive: true, force: true });
  }

  const mutations: Array<(equity: Record<string, unknown>) => void> = [
    (equity) => { equity.runId = "run-different"; },
    (equity) => { equity.initialValue = 0; },
    (equity) => {
      const points = equity.points as Array<Record<string, unknown>>;
      points[1].date = points[0].date;
    },
    (equity) => {
      const points = equity.points as Array<Record<string, unknown>>;
      points[points.length - 1].portfolioValue = (
        points[points.length - 1].portfolioValue as number
      ) + 1;
    },
    (equity) => {
      const points = equity.points as Array<Record<string, unknown>>;
      points[0].benchmarkValue = null;
    },
  ];

  for (const mutate of mutations) {
    const { root, target } = await temporaryPackage("portfolio-fundamental-quality-value");
    try {
      const file = path.join(target, "equity.json");
      const equity = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      mutate(equity);
      await writeFile(file, JSON.stringify(equity), "utf8");
      await assert.rejects(() => loadStrategyPackages(root), StrategyPackageError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects run metadata for unexecuted packages, symlinks, and oversized files", async () => {
  const unexecuted = await temporaryPackage("portfolio-lightgbm-ranking");
  try {
    await writeFile(path.join(unexecuted.target, "run.json"), "{}", "utf8");
    await assert.rejects(() => loadStrategyPackages(unexecuted.root), StrategyPackageError);
    await unlink(path.join(unexecuted.target, "run.json"));
    await writeFile(path.join(unexecuted.target, "equity.json"), "{}", "utf8");
    await assert.rejects(() => loadStrategyPackages(unexecuted.root), StrategyPackageError);
  } finally {
    await rm(unexecuted.root, { recursive: true, force: true });
  }

  const linked = await temporaryPackage();
  try {
    const runPath = path.join(linked.target, "run.json");
    const realRunPath = path.join(linked.target, "run-real.json");
    await rename(runPath, realRunPath);
    await symlink("run-real.json", runPath);
    await assert.rejects(() => loadStrategyPackages(linked.root), StrategyPackageError);
  } finally {
    await rm(linked.root, { recursive: true, force: true });
  }

  const oversized = await temporaryPackage();
  try {
    await writeFile(path.join(oversized.target, "run.json"), " ".repeat(1_000_001), "utf8");
    await assert.rejects(() => loadStrategyPackages(oversized.root), StrategyPackageError);
  } finally {
    await rm(oversized.root, { recursive: true, force: true });
  }
});
