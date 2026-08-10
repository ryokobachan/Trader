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
  assert.match(source, /strategy\.performance\.provenance === "user_supplied"/);
  assert.match(source, /strategy\.performance\.provenance !== "illustrative_catalog"/);
  assert.match(source, /return st\("sample\.unavailable"\)/);
  assert.match(source, /selected\.origin === "built_in"/);
});

test("seeded charts are limited to built-in illustrative strategies", async () => {
  const source = await strategyHomeSource();

  assert.match(
    source,
    /const illustrativeStrategyChartsAvailable = selected\.origin === "built_in"\s*&& selected\.performance\.provenance === "illustrative_catalog"/,
  );
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
  assert.match(source, /st\(illustrativeStrategyChartsAvailable \? "tip\.description" : "tip\.userDataDescription"\)/);
});

test("transaction reads and writes are scoped to a strategy and stale responses are ignored", async () => {
  const source = await strategyHomeSource();

  assert.match(source, /transactionsByStrategy\[selected\.id\] \?\? \[\]/);
  assert.match(source, /transactionReadEpochRef\.current !== requestEpoch/);
  assert.match(source, /selectedStrategyIdRef\.current !== strategyId/);
  assert.match(source, /if \(transactionSavingRef\.current\) return/);
  assert.match(source, /transactionSavingRef\.current = true/);
  assert.match(source, /\[strategyId\]: payload\.transactions\.map\(portfolioTransactionFromApi\)/);
  assert.match(source, /transactionMutationStatus === "saving"/);
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
