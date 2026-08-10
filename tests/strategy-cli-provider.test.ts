import assert from "node:assert/strict";
import test from "node:test";

import {
  runStrategyCli,
  type StrategyCliDependencies,
} from "../src/tooling/scripts/strategy-cli";

type CapturedRequest = { url: string; init?: RequestInit };

function harness(options: {
  response?: Response;
  files?: Readonly<Record<string, string>>;
  env?: Readonly<Record<string, string | undefined>>;
} = {}) {
  const requests: CapturedRequest[] = [];
  let stdout = "";
  let stderr = "";
  const dependencies: StrategyCliDependencies = {
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return options.response ?? Response.json({ ok: true });
    },
    readTextFile: async (path) => {
      const value = options.files?.[path];
      if (value === undefined) throw new Error(`missing fixture: ${path}`);
      return value;
    },
    readStdin: async () => options.files?.["-"] ?? "",
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    env: options.env ?? {},
  };
  return {
    dependencies,
    requests,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function strategyFixture(overrides: Record<string, unknown>) {
  return {
    id: "sample.alpha",
    origin: "built_in",
    version: 1,
    family: "rule",
    status: "research",
    candidateAt: "2026/08/09 12:00",
    name: "RSI Alpha",
    category: "Mean reversion",
    sourceLabels: ["Close", "RSI 14"],
    headline: "Research an RSI rule.",
    audit: { overfit: null, leakage: null, verdict: "Illustrative metrics" },
    performance: {
      provenance: "illustrative_catalog",
      netReturn: 12,
      maxDrawdown: -8,
      recoveryFactor: 1.5,
      sharpe: 0.8,
      forwardReturn: 1,
      winRate: 55,
      trades: 10,
      symbols: 1,
      cash: 20,
    },
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

test("strategy CLI lists through the owner-scoped API with a locale", async () => {
  const capture = harness();
  const exitCode = await runStrategyCli(["list", "--locale", "ja"], capture.dependencies);

  assert.equal(exitCode, 0);
  assert.equal(capture.requests.length, 1);
  assert.equal(capture.requests[0].url, "http://localhost:3001/api/v1/strategies?locale=ja");
  assert.equal(capture.requests[0].init?.method, "GET");
});

test("strategy CLI filters, ranks, and limits registered strategies locally", async () => {
  const capture = harness({
    response: Response.json({
      schemaVersion: "unicorn.strategies.v1",
      ownerId: "test-owner",
      strategies: [
        strategyFixture({}),
        strategyFixture({
          id: "custom.rsi-fast",
          origin: "custom",
          name: "RSI Fast",
          performance: {
            provenance: "user_supplied",
            netReturn: 10,
            sharpe: 1.2,
          },
        }),
        strategyFixture({
          id: "custom.rsi-slow",
          origin: "custom",
          name: "RSI Slow",
          performance: {
            provenance: "user_supplied",
            netReturn: 9,
            sharpe: null,
          },
        }),
        strategyFixture({
          id: "custom.value",
          origin: "custom",
          family: "research",
          name: "Value screen",
          sourceLabels: ["ROIC"],
          performance: { provenance: "user_supplied", sharpe: 1.5 },
        }),
      ],
    }),
  });
  const exitCode = await runStrategyCli([
    "list",
    "--query",
    "rsi",
    "--origin",
    "custom",
    "--family",
    "rule",
    "--provenance",
    "user_supplied",
    "--source",
    "rsi 14",
    "--sort",
    "sharpe",
    "--order",
    "desc",
    "--limit",
    "1",
  ], capture.dependencies);

  assert.equal(exitCode, 0);
  assert.equal(capture.requests.length, 1);
  assert.equal(capture.requests[0].url, "http://localhost:3001/api/v1/strategies");
  const output = JSON.parse(capture.stdout());
  assert.deepEqual(output.strategies.map((strategy: { id: string }) => strategy.id), [
    "custom.rsi-fast",
  ]);
  assert.deepEqual(output.selection, {
    totalCount: 4,
    matchedCount: 2,
    returnedCount: 1,
    filters: {
      query: "rsi",
      origin: "custom",
      family: "rule",
      provenance: "user_supplied",
      source: "rsi 14",
    },
    sort: { field: "sharpe", order: "desc" },
    limit: 1,
  });
});

test("strategy CLI emits a structured comparison without implying a backtest", async () => {
  const capture = harness({
    response: Response.json({
      schemaVersion: "unicorn.strategies.v1",
      ownerId: "test-owner",
      strategies: [
        strategyFixture({}),
        strategyFixture({
          id: "custom.beta",
          origin: "custom",
          name: "Beta",
          performance: {
            provenance: "user_supplied",
            netReturn: 5,
            sharpe: 1.1,
          },
        }),
      ],
    }),
  });
  const exitCode = await runStrategyCli([
    "compare",
    "custom.beta",
    "sample.alpha",
    "--sort",
    "netReturn",
  ], capture.dependencies);

  assert.equal(exitCode, 0);
  assert.equal(capture.requests.length, 1);
  const output = JSON.parse(capture.stdout());
  assert.equal(output.schemaVersion, "unicorn.strategy-comparison.v1");
  assert.deepEqual(output.strategies.map((strategy: { id: string }) => strategy.id), [
    "sample.alpha",
    "custom.beta",
  ]);
  assert.deepEqual(output.comparison.provenanceGroups, {
    illustrative_catalog: ["sample.alpha"],
    user_supplied: ["custom.beta"],
  });
  assert.equal(output.comparison.execution, "not_run");
  assert.match(output.comparison.disclosures.join(" "), /does not run.*backtest/i);
  assert.equal("ownerId" in output, false);
});

test("strategy CLI validates discovery options before calling the API", async () => {
  const capture = harness();
  const exitCode = await runStrategyCli([
    "list",
    "--order",
    "desc",
  ], capture.dependencies);

  assert.equal(exitCode, 2);
  assert.equal(capture.requests.length, 0);
  assert.match(capture.stderr(), /--order requires --sort/);
});

test("strategy CLI creates a custom strategy from explicit fields", async () => {
  const capture = harness();
  const exitCode = await runStrategyCli([
    "create",
    "--name",
    "AAPL research",
    "--headline",
    "Test a trend rule.",
    "--family",
    "research",
    "--sources",
    "Price, SMA 50",
  ], capture.dependencies);

  assert.equal(exitCode, 0);
  assert.equal(capture.requests[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(capture.requests[0].init?.body)), {
    name: "AAPL research",
    headline: "Test a trend rule.",
    family: "research",
    sourceLabels: ["Price", "SMA 50"],
  });
});

test("strategy CLI applies optimistic version to an edit file", async () => {
  const capture = harness({ files: { "/tmp/edit.json": "{\"headline\":\"Updated\"}" } });
  const exitCode = await runStrategyCli([
    "edit",
    "custom.demo",
    "--file",
    "/tmp/edit.json",
    "--version",
    "4",
  ], capture.dependencies);

  assert.equal(exitCode, 0);
  assert.equal(capture.requests[0].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(capture.requests[0].init?.body)), {
    headline: "Updated",
    expectedVersion: 4,
  });
});

test("strategy CLI refuses destructive commands without explicit confirmation", async () => {
  const capture = harness();
  const exitCode = await runStrategyCli(["delete", "custom.demo", "--version", "2"], capture.dependencies);

  assert.equal(exitCode, 2);
  assert.equal(capture.requests.length, 0);
  assert.match(capture.stderr(), /explicit --yes/);
});

test("strategy CLI deletes a versioned custom strategy through the API", async () => {
  const capture = harness();
  const exitCode = await runStrategyCli([
    "delete",
    "custom.demo",
    "--version",
    "2",
    "--yes",
  ], capture.dependencies);

  assert.equal(exitCode, 0);
  assert.equal(
    capture.requests[0].url,
    "http://localhost:3001/api/v1/strategies/custom.demo?expectedVersion=2",
  );
  assert.equal(capture.requests[0].init?.method, "DELETE");
});

test("strategy CLI updates one transaction with a JSON payload", async () => {
  const capture = harness({
    files: {
      "-": JSON.stringify({
        date: "2026-08-10",
        symbol: "AAPL",
        side: "buy",
        shares: 2,
        price: 313.3,
        fee: 0,
        expectedUpdatedAt: "2026-08-10T04:05:06.789Z",
      }),
    },
  });
  const exitCode = await runStrategyCli([
    "transactions",
    "edit",
    "custom.demo",
    "trade-1",
    "--file",
    "-",
  ], capture.dependencies);

  assert.equal(exitCode, 0);
  assert.equal(capture.requests[0].init?.method, "PATCH");
  assert.equal(
    capture.requests[0].url,
    "http://localhost:3001/api/v1/strategy-portfolios/custom.demo/transactions/trade-1",
  );
  assert.equal(
    JSON.parse(String(capture.requests[0].init?.body)).expectedUpdatedAt,
    "2026-08-10T04:05:06.789Z",
  );
});

test("strategy CLI refuses a transaction edit without the latest updatedAt token", async () => {
  const capture = harness({
    files: {
      "/tmp/transaction.json": JSON.stringify({
        date: "2026-08-10",
        symbol: "AAPL",
        side: "buy",
        shares: 2,
        price: 313.3,
        fee: 0,
      }),
    },
  });
  const exitCode = await runStrategyCli([
    "transactions",
    "edit",
    "custom.demo",
    "trade-1",
    "--file",
    "/tmp/transaction.json",
  ], capture.dependencies);

  assert.equal(exitCode, 2);
  assert.equal(capture.requests.length, 0);
  assert.match(capture.stderr(), /requires expectedUpdatedAt/);
});

test("strategy CLI emits stable machine-readable API errors", async () => {
  const capture = harness({
    response: Response.json(
      {
        error: { code: "version_conflict", message: "The strategy changed." },
        requestId: "request-123",
      },
      { status: 409 },
    ),
  });
  const exitCode = await runStrategyCli(["get", "custom.demo"], capture.dependencies);

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(capture.stderr()), {
    ok: false,
    status: 409,
    code: "version_conflict",
    message: "The strategy changed.",
    requestId: "request-123",
  });
});

test("strategy CLI rejects insecure non-loopback API origins", async () => {
  const capture = harness();
  const exitCode = await runStrategyCli([
    "list",
    "--base-url",
    "http://example.com",
  ], capture.dependencies);

  assert.equal(exitCode, 2);
  assert.equal(capture.requests.length, 0);
  assert.match(capture.stderr(), /must use HTTPS/);
});
