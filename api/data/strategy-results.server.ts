import { createProviderRuntime } from "../index.server";
import { strategyPackageById } from "../../src/app/features/strategy/catalog";
import { derivePortfolioHoldingLots } from "../../src/app/features/strategy/transaction-holdings";
import { markSamplePortfolio, strategyMarketMark, type StrategyMarketMark } from "../../src/app/features/strategy/market-valuation";
import { providerEnvironment } from "../../src/app/platform/provider-environment.server";
import { requestOwnerId } from "../../src/app/platform/request-owner.server";
import { getStrategy } from "../../src/app/platform/strategies.server";
import { listStrategyPortfolioTransactions } from "../../src/app/platform/strategy-portfolio-transactions.server";
import { strategyErrorResponse, strategyLocale, strategyRequestId, strategyResponseHeaders } from "../../src/app/platform/strategy-http.server";
import { normalizeStrategyRecordId } from "../../src/app/platform/strategy-contracts";
import { providerDataMode } from "../../src/app/platform/watchlist-quotes.server";

type MarkResult = { mark: StrategyMarketMark | null; provenance: unknown; dataMode: string };
export type StrategyResultDependencies = {
  getStrategy: typeof getStrategy;
  listTransactions: typeof listStrategyPortfolioTransactions;
  getPackage: typeof strategyPackageById;
  getMark: (symbol: string, requestId: string, signal: AbortSignal) => Promise<MarkResult>;
};
const defaults: StrategyResultDependencies = {
  getStrategy, listTransactions: listStrategyPortfolioTransactions, getPackage: strategyPackageById,
  getMark: async (symbol, requestId, signal) => {
    const runtime = createProviderRuntime(providerEnvironment());
    const context = { requestId, signal };
    const instrument = await runtime.instrument.getUSStockBySymbol(symbol, context);
    if (!instrument) return { mark: null, provenance: null, dataMode: "unavailable" };
    const quote = await runtime.market.getQuote(instrument, context);
    let mark = strategyMarketMark(quote, []);
    const bars = mark ? null : await runtime.market.getBars?.(instrument, { range: "1mo", interval: "1d", count: 30 }, context);
    mark ??= strategyMarketMark(quote, bars?.items ?? []);
    return { mark, provenance: { quote: quote?.provenance ?? null, bars: bars?.provenance ?? null, selectedProviders: runtime.selectedProviderIds }, dataMode: providerDataMode(runtime.selectedProviderIds.instrument, runtime.selectedProviderIds.market, ...(bars ? [runtime.selectedProviderIds.bars] : [])) };
  },
};

/** Read saved results; never execute a strategy or write its ledger. */
export async function strategyResultResponse(request: Request, dataset: "strategy-equity" | "strategy-holdings", rawId: string, dependencies: StrategyResultDependencies = defaults): Promise<Response> {
  const requestId = strategyRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const strategyId = normalizeStrategyRecordId(rawId);
    const strategy = await dependencies.getStrategy(strategyId, strategyLocale(request), ownerId);
    const pack = strategy.origin === "built_in" ? dependencies.getPackage(strategyId) : null;
    const run = strategy.performance.provenance === "backtest_artifact" ? pack?.run ?? null : null;
    const common = { schemaVersion: "trader.strategy-results.v1", dataset, ownerId, strategyId, strategy, retrievedAt: new Date().toISOString() };
    const headers = strategyResponseHeaders(requestId);
    if (dataset === "strategy-equity") {
      const equity = run ? pack?.equity ?? null : null;
      return Response.json({ ...common, basis: "saved_backtest", equity, run,
        provenance: strategy.performance.provenance,
        coverage: { status: equity ? "available" : "unavailable", points: equity?.points.length ?? 0 },
        warnings: equity ? run?.warnings ?? [] : ["No saved equity curve exists for this strategy; metrics or ledger entries cannot reconstruct it."],
      }, { headers });
    }
    if (run) return Response.json({ ...common, basis: "backtest_end", asOf: run.data.end,
      holdings: run.execution.finalPositions, portfolioValue: run.execution.finalValue, cashPercent: run.execution.finalCashPercent,
      provenance: { type: "backtest_artifact", runId: run.runId, generatedAt: run.generatedAt, data: run.data },
      coverage: { status: "available", returned: run.execution.finalPositions.length },
      warnings: ["These are saved end-of-backtest positions and marks, not current live holdings.", ...run.warnings],
    }, { headers });

    const transactions = await dependencies.listTransactions(strategyId, ownerId);
    const lots = derivePortfolioHoldingLots(transactions);
    const markedSymbols = lots.slice(0, 50).map(lot => lot.ticker);
    const marks: Record<string, StrategyMarketMark> = {};
    const provenance: Record<string, unknown> = {};
    const modes = new Set<string>();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (request.signal.aborted) abort(); else request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    let index = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(4, markedSymbols.length) }, async () => {
        while (index < markedSymbols.length && !controller.signal.aborted) {
          const symbol = markedSymbols[index++];
          try {
            const result = await dependencies.getMark(symbol, requestId, controller.signal);
            if (result.mark) marks[symbol] = result.mark;
            provenance[symbol] = result.provenance;
            modes.add(result.dataMode);
          } catch { /* Missing marks are reported explicitly; do not invent prices. */ }
        }
      }));
    } finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
    const marked = markSamplePortfolio(lots, marks, strategy.performance.cash ?? 0);
    return Response.json({ ...common, basis: "current_ledger", holdings: marked.holdings.map(holding => ({ ...holding, ...(strategy.performance.cash === null ? { allocation: null } : {}), mark: marks[holding.ticker] ?? null })),
      holdingsValue: marked.holdingsValue, unrealizedGain: marked.unrealizedGain,
      provenance: { type: "transaction_ledger_with_current_marks", marks: provenance }, dataMode: modes.has("fixture") ? "fixture" : modes.size ? "provider" : "unavailable",
      coverage: { status: marked.complete || lots.length === 0 ? "complete" : "partial", holdings: lots.length, marked: Object.keys(marks).length, maxMarkedSymbols: 50 },
      warnings: ["Holdings use the existing long-only ledger calculation. They are result data, not historical market inputs.", ...(marked.complete || lots.length === 0 ? [] : ["Some current marks are missing; portfolio totals remain null."]), ...(lots.length > 50 ? ["Only the first 50 symbols were valued; additional quantities and costs remain visible."] : []), ...(modes.has("fixture") ? ["At least one market value uses fixture data, not a live observation."] : [])],
    }, { headers });
  } catch (error) { return strategyErrorResponse(error, requestId); }
}
