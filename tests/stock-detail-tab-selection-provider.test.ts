import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalStockDetailTabSelection,
  resolveStockDetailTab,
  type StockDetailTabSelection,
} from "../src/app/features/stock-detail/tab-selection";

type Tab = "financials" | "analyst" | "technicals";
const tabs: readonly Tab[] = ["financials", "analyst", "technicals"];

test("keeps rendered and fetched stock-detail tabs aligned across a symbol roundtrip", () => {
  let selection: StockDetailTabSelection<Tab> = { ticker: "AAPL", tab: "analyst" };

  const aaplRendered = resolveStockDetailTab(selection, "AAPL", tabs, "financials");
  const aaplFetchGate = resolveStockDetailTab(selection, "AAPL", tabs, "financials");
  assert.equal(aaplRendered, "analyst");
  assert.equal(aaplFetchGate, aaplRendered);

  const msftRenderedBeforeCommit = resolveStockDetailTab(selection, "MSFT", tabs, "financials");
  const msftFetchGateBeforeCommit = resolveStockDetailTab(selection, "MSFT", tabs, "financials");
  assert.equal(msftRenderedBeforeCommit, "financials");
  assert.equal(msftFetchGateBeforeCommit, msftRenderedBeforeCommit);

  selection = canonicalStockDetailTabSelection(selection, "MSFT", tabs, "financials");
  assert.deepEqual(selection, { ticker: "MSFT", tab: "financials" });

  const returnedAaplRendered = resolveStockDetailTab(selection, "AAPL", tabs, "financials");
  const returnedAaplFetchGate = resolveStockDetailTab(selection, "AAPL", tabs, "financials");
  assert.equal(returnedAaplRendered, "financials");
  assert.equal(returnedAaplFetchGate, returnedAaplRendered);
});

test("wires the parent-resolved tab into both StockDetailPage and analyst fetching", async () => {
  const source = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(source, /const activeStockDetailSection = resolveStockDetailTab\(/);
  assert.match(source, /activeSection=\{activeStockDetailSection\}/);
  assert.match(source, /activeSection:\s*StockDetailTabId/);
  assert.match(source, /activeStockDetailSection === "analyst"/);
  assert.doesNotMatch(source, /const \[tabSelection, setTabSelection\]/);
});
