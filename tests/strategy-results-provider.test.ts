import assert from "node:assert/strict";
import test from "node:test";
import { strategyResultResponse, type StrategyResultDependencies } from "../api/data/strategy-results.server";
import { strategyPackageById, STRATEGY_PACKAGE_DEFINITIONS } from "../src/app/features/strategy/catalog";
import type { StrategyRecord } from "../src/app/platform/strategy-contracts";
import type { StrategyPortfolioTransaction } from "../src/app/platform/strategy-portfolio-contracts";

const record: StrategyRecord = { id: "custom.test", origin: "custom", version: 1, family: "research", status: "research", candidateAt: "2026-01-01", name: "Test", category: "Test", sourceLabels: [], headline: "Test", audit: { overfit: null, leakage: null, verdict: "not evaluated" }, createdAt: null, updatedAt: null, performance: { provenance: "unavailable", netReturn: null, maxDrawdown: null, recoveryFactor: null, sharpe: null, forwardReturn: null, winRate: null, trades: null, symbols: null, cash: null } };
const transaction = (symbol: string, shares: number, side: StrategyPortfolioTransaction["side"] = "buy"): StrategyPortfolioTransaction => ({ strategyId: record.id, transactionId: `${symbol}-${side}`, date: side === "buy" ? "2026-01-01" : "2026-01-02", symbol, side, shares, price: 10, fee: side === "buy" ? 2 : 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
const defaults: StrategyResultDependencies = { getStrategy: async () => record, listTransactions: async () => [], getPackage: strategyPackageById, getMark: async () => ({ mark: null, provenance: null, dataMode: "unavailable" }) };
type ResultBody = { error: { code: string }; equity: unknown; coverage: { status: string; marked: number }; run: { runId: string }; basis: string; asOf: string; holdings: Array<Record<string, number | null>>; holdingsValue: number | null; dataMode: string; warnings: string[] };
const bodyOf = async (response: Response) => await response.json() as ResultBody;
const request = () => new Request("http://localhost:3001/api/v1/data/strategy-holdings?strategy=custom.test");

test("strategy results reject unauthenticated remote access before reading packages or ledgers", async () => {
  const response = await strategyResultResponse(new Request("https://trader.example/api/v1/data/strategy-equity"), "strategy-equity", record.id, { ...defaults, getStrategy: async () => { throw new Error("Must not read"); } });
  assert.equal(response.status, 401);
  assert.equal((await bodyOf(response)).error.code, "authentication_required");
});

test("equity is a saved artifact and never fabricated from transaction summaries", async () => {
  const missing = await strategyResultResponse(request(), "strategy-equity", record.id, { ...defaults, listTransactions: async () => { throw new Error("Do not infer a curve"); } });
  assert.equal(missing.status, 200);
  const absent = await bodyOf(missing);
  assert.equal(absent.equity, null);
  assert.equal(absent.coverage.status, "unavailable");
  const pack = STRATEGY_PACKAGE_DEFINITIONS.find(item => item.run && item.equity)!;
  assert.ok(pack);
  const deps = { ...defaults, getStrategy: async () => ({ ...record, id: pack.id, origin: "built_in" as const, performance: { ...record.performance, provenance: "backtest_artifact" as const } }), getMark: async () => { throw new Error("Saved results cannot request current marks"); } };
  const saved = await strategyResultResponse(request(), "strategy-equity", pack.id, deps);
  const body = await bodyOf(saved);
  assert.deepEqual(body.equity, pack.equity);
  assert.equal(body.run.runId, pack.run!.runId);
  const holdings = await bodyOf(await strategyResultResponse(request(), "strategy-holdings", pack.id, deps));
  assert.equal(holdings.basis, "backtest_end");
  assert.equal(holdings.asOf, pack.run!.data.end);
  assert.deepEqual(holdings.holdings, pack.run!.execution.finalPositions);
});

test("current ledger valuation uses existing fee-aware holdings calculation and preserves missing marks", async () => {
  const response = await strategyResultResponse(request(), "strategy-holdings", record.id, { ...defaults,
    listTransactions: async () => [transaction("AAPL", 10), transaction("AAPL", 3, "sell"), transaction("MSFT", 2)],
    getMark: async symbol => ({ mark: symbol === "AAPL" ? { price: 20, changePercent: 0, asOf: "2026-09-04", source: "completed_daily_close" } : null, provenance: { provider: "test" }, dataMode: "provider" }),
  });
  const body = await bodyOf(response);
  assert.equal(body.basis, "current_ledger");
  assert.equal(body.holdings[0].shares, 7);
  assert.equal(body.holdings[0].average, 10.2);
  assert.equal(body.holdings[0].value, 140);
  assert.equal(body.holdings[0].allocation, null, "Unknown cash weight cannot imply full investment");
  assert.equal(body.holdings[1].value, null);
  assert.equal(body.holdingsValue, null);
  assert.equal(body.coverage.status, "partial");
  assert.equal(body.coverage.marked, 1);
});

test("holding quotes are bounded at 50 symbols and four concurrent reads without dropping excess quantities", async () => {
  let active = 0, maxActive = 0, reads = 0;
  const response = await strategyResultResponse(request(), "strategy-holdings", record.id, { ...defaults,
    listTransactions: async () => Array.from({ length: 55 }, (_, index) => transaction(`S${index}`, 1)),
    getMark: async () => {
      reads++; active++; maxActive = Math.max(active, maxActive);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { mark: { price: 20, changePercent: null, asOf: "2026-09-04", source: "completed_daily_close" }, provenance: {}, dataMode: "fixture" };
    },
  });
  const body = await bodyOf(response);
  assert.equal(reads, 50);
  assert.equal(maxActive, 4);
  assert.equal(body.holdings.length, 55);
  assert.equal(body.coverage.marked, 50);
  assert.equal(body.dataMode, "fixture");
  assert.equal(body.holdingsValue, null);
  assert.ok(body.warnings.some((warning: string) => warning.includes("fixture")));
});
