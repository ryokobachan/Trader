import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

function sourceBetween(startMarker: string, endMarker: string) {
  const start = pageSource.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = pageSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return pageSource.slice(start, end);
}

test("chart workspace has no chart-layout control or state", () => {
  const toolbarMenuType = pageSource.match(/type ToolbarMenuId = ([^;]+);/)?.[1];
  assert.ok(toolbarMenuType, "ToolbarMenuId must remain declared");
  assert.doesNotMatch(toolbarMenuType, /["']layout["']/i);

  assert.doesNotMatch(pageSource, /label=["']レイアウト["']/);
  assert.doesNotMatch(pageSource, /チャートレイアウト/);
  assert.doesNotMatch(pageSource, /const\s*\[\s*layout\s*,\s*setLayout\s*\]/);
  assert.doesNotMatch(pageSource, /setLayout\s*\(/);
  assert.doesNotMatch(pageSource, /["']1画面["']\s*,\s*["']2分割["']\s*,\s*["']4分割["']/);
});

test("strategy holdings use one native table with the fixed position-to-technical columns", () => {
  const holdingsPanel = sourceBetween(
    '{tab === "保有銘柄"',
    '{tab === "取引"',
  );
  assert.match(holdingsPanel, /<table\s+className="holdings-data-table"\s+aria-label=\{st\("holdings\.aria"\)\}>/);
  assert.match(holdingsPanel, /<thead><tr>/);
  assert.match(holdingsPanel, /<tbody>/);
  assert.doesNotMatch(holdingsPanel, /holdingView|holding-view-tabs/);

  const header = holdingsPanel.slice(
    holdingsPanel.indexOf("<thead><tr>"),
    holdingsPanel.indexOf("</tr></thead>"),
  );
  const visibleColumns = [...header.matchAll(/<th>(.*?)<\/th>/g)].map((match) => {
    const translationKey = match[1].match(/^\{st\("([^"]+)"\)\}$/)?.[1];
    return translationKey ? `i18n:${translationKey}` : match[1];
  });
  assert.deepEqual(visibleColumns, [
    "i18n:holdings.symbol",
    "i18n:holdings.shares",
    "i18n:holdings.averageCost",
    "i18n:holdings.currentPrice",
    "i18n:holdings.currentValue",
    "i18n:holdings.allocation",
    "i18n:holdings.unrealized",
    "i18n:holdings.daily",
    "i18n:holdings.marketCap",
    "PER",
    "i18n:holdings.oneMonth",
    "Beta",
    "RSI 14",
    "i18n:holdings.technical",
  ]);
  assert.match(header, /<th aria-label=\{st\("holdings\.actions"\)\}\s*\/>/);
});

test("strategy analysis content lives in Overview without a separate Analysis tab", () => {
  const portfolioTabType = pageSource.match(/type PortfolioTab = ([^;]+);/)?.[1];
  assert.equal(portfolioTabType, '"概要" | "保有銘柄" | "取引"');
  assert.doesNotMatch(pageSource, /tab\s*===\s*["']分析["']/);

  const tabNavigation = sourceBetween(
    '<nav className="portfolio-primary-tabs"',
    "</nav>",
  );
  assert.doesNotMatch(tabNavigation, /分析/);
  assert.match(tabNavigation, /portfolioTabLabel\(locale, item\)/);

  const overviewPanel = sourceBetween(
    '{tab === "概要"',
    '{tab === "保有銘柄"',
  );
  assert.match(overviewPanel, /<h2>\{st\("profitability\.title"\)\}<\/h2>/);
  assert.match(overviewPanel, /<h2>\{st\("contribution\.title"\)\}<\/h2>/);

  const summaryCards = sourceBetween(
    '<section className="portfolio-summary-cards"',
    "</section>",
  );
  for (const key of ["portfolio.value", "portfolio.maxDrawdown"]) {
    assert.match(summaryCards, new RegExp(`<span>\\{st\\("${key.replace(".", "\\.")}"\\)\\}</span>`));
  }
  for (const metric of ["Beta", "Sharpe", "Sortino"]) {
    assert.match(summaryCards, new RegExp(`<span>${metric}</span>`));
  }
});
