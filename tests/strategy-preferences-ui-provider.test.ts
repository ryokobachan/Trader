import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function strategyHomeSource() {
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const start = pageSource.indexOf("function StrategyHome(");
  const end = pageSource.indexOf("function WatchlistPanel(", start);
  assert.ok(start >= 0 && end > start);
  return pageSource.slice(start, end);
}

test("StrategyHome merges durable preferences and connects edit/delete mutations", async () => {
  const source = await strategyHomeSource();

  assert.match(source, /strategyPreferences === null[\s\S]*sampleStrategiesForLocale\(locale, strategyPreferences\)/);
  assert.match(source, /fetch\("\/api\/v1\/strategy-preferences"/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /upsertStrategyPreference\(payload\.preference\)/);
  assert.match(source, /payload\?\.error\?\.code === "last_visible_strategy"/);
  assert.match(source, /selectPortfolio\(fallback\.id\)/);
  assert.match(source, /strategyPreferenceReadEpochRef\.current !== requestEpoch/);
  assert.match(source, /mergeStrategyPreferenceSnapshots\(current, payload\.preferences\)/);
  assert.match(source, /disabled=\{!strategyCatalogReady\}/);
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
