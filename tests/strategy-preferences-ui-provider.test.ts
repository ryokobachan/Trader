import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function strategyHomeSource() {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const start = pageSource.indexOf("function StrategyHome(");
  const end = pageSource.indexOf("function WatchlistPanel(", start);
  assert.ok(start >= 0 && end > start);
  return pageSource.slice(start, end);
}

test("StrategyHome reads the unified strategy catalog and connects every CRUD mutation", async () => {
  const source = await strategyHomeSource();

  assert.match(source, /fetch\(`\/api\/v1\/strategies\?locale=\$\{encodeURIComponent\(locale\)\}`/);
  assert.match(source, /payload\.strategies\.map\(strategyRecordFromApi\)/);
  assert.match(source, /fetch\("\/api\/v1\/strategies", \{[\s\S]*method: "POST"/);
  assert.match(source, /const createStrategy = async/);
  assert.match(source, /const duplicateSelectedStrategy = async/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /upsertStrategyRecord\(payload\.strategy\)/);
  assert.match(source, /selected\.origin === "custom" \? \{ expectedVersion: selected\.version \}/);
  assert.match(source, /expectedVersion=\$\{encodeURIComponent\(String\(selected\.version\)\)\}/);
  assert.match(source, /payload\?\.error\?\.code === "last_visible_strategy"/);
  assert.match(source, /selectPortfolio\(fallback\.id\)/);
  assert.match(source, /strategyCatalogReadEpochRef\.current !== requestEpoch/);
  assert.match(source, /disabled=\{!strategyCatalogReady \|\| strategyMutationStatus !== "idle"\}/);
  assert.doesNotMatch(source, /\/api\/v1\/strategy-preferences/);
});

test("strategy loading, request failures, and version conflicts are visible", async () => {
  const source = await strategyHomeSource();

  assert.match(source, /strategyCatalogStatus === "loading"/);
  assert.match(source, /strategyCatalogStatus === "error"/);
  assert.match(source, /strategyMutationError === "conflict"/);
  assert.match(source, /className="strategy-request-notice conflict" role="alert"/);
  assert.match(source, /onClick=\{refreshStrategyCatalog\}/);
  assert.match(source, /strategy\.performance\.provenance === "illustrative_catalog"/);
  assert.match(source, /strategy\.performance\.provenance === "backtest_artifact"/);
  assert.match(source, /strategy\.performance\.provenance === "user_supplied"/);
  assert.match(source, /strategyListMetricsForDuration\(/);
  assert.match(source, /const strategyMetricsById = useMemo/);
  assert.match(source, /return st\("sample\.unavailable"\)/);
  assert.match(source, /selected\.origin === "built_in"/);
});

test("seeded charts stay illustrative while backtests render their recorded equity", async () => {
  const source = await strategyHomeSource();

  assert.match(
    source,
    /const illustrativeStrategyChartsAvailable = selected\.origin === "built_in"\s*&& selected\.performance\.provenance === "illustrative_catalog"/,
  );
  assert.match(source, /const selectedBacktestEquity = selectedHasBacktest \? selectedPackage\?\.equity \?\? null : null/);
  assert.match(source, /const selectedBacktestEquityPoints = selectedBacktestEquity\?\.points\.length/);
  assert.match(source, /selectedBacktestEquityPoints \? <PortfolioValueChart[\s\S]*?points=\{selectedBacktestEquityPoints\}/);
  assert.match(source, /selectedBacktestEquityPoints \? <PortfolioProfitChart[\s\S]*?points=\{selectedBacktestEquityPoints\}/);
  assert.match(source, /initialValue=\{selectedBacktestEquity\?\.initialValue\}/);
  assert.match(source, /useState<"TTM" \| "ALL">\("TTM"\)/);
  assert.match(source, /\(\["TTM", "ALL"\] as const\)\.map/);
  assert.match(source, /selectedBacktestRun \? <>[\s\S]*?selectedBacktestEquityPoints \? <PortfolioValueChart[\s\S]*?<StrategyChartUnavailable className="portfolio-chart-canvas"/);
  assert.match(source, /selectedBacktestRun \? <>[\s\S]*?selectedBacktestEquityPoints \? <PortfolioProfitChart[\s\S]*?<StrategyChartUnavailable className="portfolio-analysis-chart"/);
  assert.match(source, /illustrativeStrategyChartsAvailable \? <PortfolioValueChart/);
  assert.match(source, /illustrativeStrategyChartsAvailable \? <PortfolioProfitChart/);
  assert.match(
    source,
    /<StrategyChartUnavailable className="portfolio-chart-canvas"[^>]*message=\{st\("chart\.unavailable"\)\}/,
  );
  assert.match(
    source,
    /<StrategyChartUnavailable className="portfolio-analysis-chart"[^>]*message=\{st\("chart\.unavailable"\)\}/,
  );
  assert.match(source, /st\("status\.strategyDisclaimer"\)/);
});

test("transaction reads and writes are scoped to a strategy and stale responses are ignored", async () => {
  const source = await strategyHomeSource();

  assert.match(source, /const portfolioTabs: PortfolioTab\[\] = \["概要", "取引", "保有銘柄"\]/);
  assert.match(source, /const openPortfolio = \(id: string\) => \{[\s\S]*?const hasRecordedBacktest = target\?\.performance\.provenance === "backtest_artifact"[\s\S]*?setTab\(hasRecordedBacktest \? "取引" : "概要"\)[\s\S]*?setPeriod\(hasRecordedBacktest \? "ALL" : "YTD"\)/);
  assert.match(source, /role="tab"[^\n]*onClick=\{\(\) => setTab\(item\)\}/);
  assert.match(source, />\{portfolioTabLabel\(locale, item\)\}<\/button>/);
  assert.match(source, /transactionsByStrategy\[selected\.id\] \?\? \[\]/);
  assert.match(source, /const refreshStrategyData = \(\) => \{[\s\S]*?setTransactionRefreshVersion/);
  assert.match(source, /transactionReadEpochRef\.current !== requestEpoch/);
  assert.match(source, /selectedStrategyIdRef\.current !== strategyId/);
  assert.match(source, /if \(transactionSavingRef\.current\) return/);
  assert.match(source, /transactionSavingRef\.current = true/);
  assert.match(source, /\[strategyId\]: payload\.transactions\.map\(portfolioTransactionFromApi\)/);
  assert.match(source, /transactionMutationStatus === "saving"/);
});

test("strategy detail uses a static title and an explicit reload control", async () => {
  const source = await strategyHomeSource();

  assert.match(source, /<div className="portfolio-title-block"><h1>\{selected\.name\}<\/h1>/);
  assert.doesNotMatch(source, /<div className="portfolio-title-block"><select/);
  assert.match(source, /className=\{`strategy-refresh-action \$\{strategyDataRefreshing/);
  assert.match(source, /aria-busy=\{strategyDataRefreshing\}/);
  assert.match(source, /title=\{st\("action\.refreshDescription"\)\}/);
  assert.match(source, /onClick=\{refreshStrategyData\}/);
  assert.match(source, /strategyMarketStatus === "loading"/);
  assert.match(source, /setStrategyMarketMarks\(\(current\) => Object\.freeze\(\{ \.\.\.current, \.\.\.nextMarks \}\)\)/);
  assert.match(source, /watchlists\/quotes\$\{strategyRefreshVersion > 0 \? "\?fresh=1" : ""\}/);
});

test("strategy edit form is controlled and prevents invalid or concurrent saves", async () => {
  const source = await strategyHomeSource();

  assert.match(source, /value=\{settingsName\} required maxLength=\{120\}/);
  assert.match(source, /value=\{settingsHeadline\} required maxLength=\{500\}/);
  assert.match(source, /onSubmit=\{saveStrategySettings\}/);
  assert.match(source, /disabled=\{strategyMutationStatus !== "idle" \|\| !settingsName\.trim\(\) \|\| !settingsHeadline\.trim\(\)\}/);
  assert.match(source, /disabled=\{strategyMutationStatus !== "idle" \|\| strategies\.length <= 1\}/);
});

test("transaction import/export use inward and outward icon directions", async () => {
  const source = await strategyHomeSource();

  assert.match(
    source,
    /setDialog\("import"\)[^<]*><DownloadSimple size=\{15\} \/> \{st\("transactions\.import"\)\}/,
  );
  assert.match(
    source,
    /toast\.transactionsExported[^<]*><UploadSimple size=\{15\} \/> \{st\("transactions\.export"\)\}/,
  );
  assert.match(source, /className="file-drop"><UploadSimple size=\{24\}/);
});
