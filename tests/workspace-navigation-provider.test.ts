import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceRoute, workspaceRouteUrl } from "../src/app/features/navigation/workspace-route";

const defaults = { stockTabs: ["overview", "financials", "technicals", "ownership", "dividends", "analyst", "news"] as const, strategyId: "default-strategy" };
for (const url of [
  "/chart/NVDA", "/chart/BRK.B", "/symbols/MSFT/analyst", "/symbols/NVDA/technicals",
  "/strategies", "/strategies/custom%20strategy/transactions", "/strategies/value/holdings",
  "/institutional", "/ideas", "/data-sources", "/x-analysis",
]) {
  test(`workspace URL survives reload: ${url}`, () => {
    const location = new URL(url, "http://localhost:3001");
    assert.equal(workspaceRouteUrl(parseWorkspaceRoute(location.pathname, location.search, defaults)), url);
  });
}
test("root and malformed locations have safe defaults", () => {
  assert.equal(workspaceRouteUrl(parseWorkspaceRoute("/", "", defaults)), "/chart/AAPL");
  assert.equal(workspaceRouteUrl(parseWorkspaceRoute("/symbols/%XX/analyst", "", defaults)), "/chart/AAPL");
  assert.equal(workspaceRouteUrl(parseWorkspaceRoute("/symbols/nvda/invalid", "", defaults)), "/symbols/NVDA/overview");
});
test("strategy list and detail remain distinct and default tabs are explicit", () => {
  assert.equal(parseWorkspaceRoute("/strategies", "", defaults).strategyScreen, "index");
  assert.equal(parseWorkspaceRoute("/strategies/custom-id", "", defaults).strategyId, "custom-id");
  assert.equal(workspaceRouteUrl(parseWorkspaceRoute("/strategies/custom-id", "", defaults)), "/strategies/custom-id/overview");
});

for (const path of [
  "/institutional", "/ideas", "/data-sources", "/x-analysis", "/strategies",
  "/strategies/value/overview", "/strategies/value/holdings", "/strategies/value/transactions",
]) {
  test(`symbol-independent URLs stay clean: ${path}`, () => {
    const route = parseWorkspaceRoute(path, "?symbol=NBIS", defaults);
    assert.equal(workspaceRouteUrl(route), path);
    assert.equal(workspaceRouteUrl({ ...route, ticker: "TSLA" }), path);
    assert.equal(workspaceRouteUrl(parseWorkspaceRoute(path, "", defaults)), path);
  });
}

test("all stock-detail categories have stable URLs and legacy research links migrate", () => {
  for (const tab of defaults.stockTabs) {
    const path = `/symbols/NBIS/${tab}`;
    assert.equal(workspaceRouteUrl(parseWorkspaceRoute(path, "", defaults)), path);
  }
  assert.equal(workspaceRouteUrl(parseWorkspaceRoute("/symbols/NBIS/research", "", defaults)), "/symbols/NBIS/ownership");
});

test("Details navigation uses the chart selection and has its own active state", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const chart = source.indexOf('aria-label={t("nav.chart")}');
  const details = source.indexOf('aria-label={t("nav.details")}');
  const strategy = source.indexOf('aria-label={t("nav.strategies")}');
  assert.ok(chart > 0 && details > chart && strategy > details);
  assert.match(source, /const navigationView = primaryView;/);
  assert.match(source, /onClick=\{openStockDetails\}><ListBullets/);
  assert.match(source, /setStockDetailTabSelection\(\{ ticker: selectedTicker, tab: DEFAULT_STOCK_DETAIL_TAB \}\)/);
});
