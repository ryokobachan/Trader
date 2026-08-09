import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildStockDetailTechnicalMetrics,
  buildStockDetailViewModel,
  formatStockDetailProviderChain,
} from "../app/features/stock-detail/detail-view-model";
import {
  SYMBOL_WORKSPACE_SCHEMA_VERSION,
  type DataProvenance,
  type MarketBar,
  type SymbolWorkspace,
} from "../app/platform/provider-contracts";

const provenance = (providerId: string, sourceId: string): DataProvenance => ({
  providerId,
  sourceId,
  asOf: "2026-08-08T15:00:00.000Z",
  ingestedAt: "2026-08-08T15:00:01.000Z",
});

function workspaceFixture(): SymbolWorkspace {
  const yahooIdentity = provenance("yahoo", "yahoo:quoteSummary:AAPL");
  const yahooFundamentals = provenance("yahoo", "yahoo:fundamentals:AAPL");
  const benzinga = provenance("benzinga", "benzinga:consensus:AAPL");
  return {
    schemaVersion: SYMBOL_WORKSPACE_SCHEMA_VERSION,
    instrument: {
      instrumentId: "us:AAPL",
      symbol: "AAPL",
      name: "Apple Inc.",
      assetType: "common_stock",
      active: true,
      listingCountry: "US",
      exchange: "NASDAQ",
      exchangeMic: "XNAS",
      currency: "USD",
      sector: "Technology",
      provenance: yahooIdentity,
    },
    quote: {
      instrumentId: "us:AAPL",
      price: 220,
      change: 2,
      changePercent: 0.92,
      previousClose: 218,
      open: 219,
      high: 221,
      low: 217,
      volume: 51_000_000,
      marketCap: 3_300_000_000_000,
      currency: "USD",
      marketState: "closed",
      delaySeconds: 0,
      provenance: yahooIdentity,
    },
    profile: {
      instrumentId: "us:AAPL",
      description: "Consumer technology company.",
      website: "https://www.apple.com/",
      sector: "Technology",
      country: "US",
      city: "Cupertino",
      beta: 1.2,
      provenance: yahooIdentity,
    },
    fundamentals: {
      instrumentId: "us:AAPL",
      currency: "USD",
      period: "FY 2025",
      revenue: 391_000_000_000,
      revenueGrowth: 0.06,
      grossProfit: 180_000_000_000,
      ebitda: 130_000_000_000,
      eps: 6.08,
      enterpriseValue: 3_500_000_000_000,
      trailingPe: 36.2,
      enterpriseValueToEbitda: 26.9,
      roic: 0.42,
      grossMargin: 0.462,
      cashAndShortTermInvestments: 55_000_000_000,
      totalDebt: 112_000_000_000,
      quickRatio: 0.82,
      operatingCashFlow: 118_000_000_000,
      dividendPerShare: 1.04,
      bookValuePerShare: 6.1,
      provenance: yahooFundamentals,
    },
    earnings: [{
      reportDate: "2026-10-29",
      fiscalDateEnding: "2026-09-30",
      epsEstimate: 1.72,
      provenance: yahooFundamentals,
    }],
    analyst: {
      instrumentId: "us:AAPL",
      targetConsensus: 240,
      targetLow: 190,
      targetHigh: 280,
      analystCount: 42,
      buy: 27,
      hold: 12,
      sell: 3,
      strongSell: 0,
      provenance: benzinga,
    },
    news: [],
    selectedProviders: {
      instrument: "yahoo",
      market: "yahoo",
      fundamentals: "yahoo>fmp",
      analyst: "benzinga>fmp",
      news: "yahoo>fmp",
    },
    dataMode: "provider",
    status: "complete",
    warnings: [],
    asOf: yahooIdentity.asOf,
  };
}

function ascendingBars(length: number): MarketBar[] {
  return Array.from({ length }, (_, index) => ({
    time: `2026-06-${String(index + 1).padStart(2, "0")}`,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }));
}

test("renders only present workspace fields with Yahoo and Benzinga provenance", () => {
  const workspace = workspaceFixture();
  const model = buildStockDetailViewModel(
    workspace,
    ascendingBars(60),
    provenance("yahoo", "yahoo:chart:AAPL"),
  );

  assert.equal(model.profile.source.label, "Yahoo Finance");
  assert.equal(model.fundamentals.source.label, "Yahoo Finance");
  assert.equal(model.analyst.source.label, "Benzinga");
  assert.equal(model.technicals.source.label, "Yahoo Finance");
  assert.equal(model.profile.description, "Consumer technology company.");
  assert.deepEqual(
    model.fundamentals.metrics.map((item) => item.label),
    [
      "売上高",
      "売上高成長率",
      "粗利益",
      "EBITDA",
      "EPS",
      "企業価値（EV）",
      "実績PER",
      "EV / EBITDA",
      "ROIC",
      "粗利率",
      "現金・短期投資",
      "有利子負債",
      "当座比率",
      "営業CF",
      "1株配当",
      "1株簿価",
    ],
  );
  assert.ok(model.fundamentals.metrics.every((item) => item.note?.includes("Provider最新値")));
  assert.equal(
    model.fundamentals.metrics.find((item) => item.label === "1株簿価")?.note,
    "Provider最新値 · USD / 株",
  );
  assert.equal(
    model.fundamentals.metrics.find((item) => item.label === "ROIC")?.value,
    "42.0%",
  );
  assert.deepEqual(
    model.earnings.rows[0].metrics.map((item) => item.label),
    ["EPS予想"],
  );
  assert.ok(model.analyst.metrics.some((item) => item.label === "強い売り" && item.value === "0"));
  assert.ok(model.analyst.metrics.some((item) => item.label === "平均目標への乖離"));
  assert.equal(
    [...model.profile.metrics, ...model.fundamentals.metrics, ...model.analyst.metrics]
      .some((item) => item.value === "—"),
    false,
  );
});

test("returns explicit empty sections instead of fixture or pseudo values", () => {
  const model = buildStockDetailViewModel(null, []);

  assert.equal(model.identity, null);
  assert.equal(model.quote, null);
  assert.deepEqual(model.profile.metrics, []);
  assert.deepEqual(model.fundamentals.metrics, []);
  assert.deepEqual(model.earnings.rows, []);
  assert.deepEqual(model.analyst.metrics, []);
  assert.deepEqual(model.technicals.metrics, []);
  assert.equal(model.profile.source.label, "Provider未選択");
  assert.doesNotMatch(JSON.stringify(model), /fixture|pseudo|開発用/i);
});

test("calculates technical metrics only when OHLCV history is sufficient", () => {
  const metrics = buildStockDetailTechnicalMetrics(ascendingBars(60));
  const values = new Map(metrics.map((item) => [item.label, item.value]));

  assert.equal(values.get("SMA 20"), "$150.50");
  assert.equal(values.get("RSI 14"), "100.0");
  assert.equal(values.get("ATR 14"), "$3.00");
  assert.ok(values.has("EMA 50"));
  assert.ok(values.has("実現ボラティリティ 30"));
  assert.ok(values.has("期間VWAP"));

  const singleBarMetrics = buildStockDetailTechnicalMetrics(ascendingBars(1));
  assert.deepEqual(
    singleBarMetrics.map((item) => item.label),
    ["取得期間レンジ", "期間VWAP"],
  );
});

test("keeps primary and fallback provider order visible", () => {
  assert.equal(
    formatStockDetailProviderChain("yahoo>fmp"),
    "Yahoo Finance → FMP (fallback)",
  );
  assert.equal(
    formatStockDetailProviderChain("benzinga, fmp"),
    "Benzinga → FMP (fallback)",
  );
});

test("keeps legacy pseudo metrics and broker fixtures out of the detail screen", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function StockDetailPage(");
  const end = source.indexOf("function IndicatorsPanel(", start);
  assert.ok(start >= 0 && end > start);
  const detailSource = source.slice(start, end);

  assert.doesNotMatch(detailSource, /scaledMetric|pseudoRandom|getStockIntelligence|getIndicatorReading/);
  assert.doesNotMatch(detailSource, /TipRanks|Morgan Stanley|Goldman Sachs|Barclays/);
  assert.doesNotMatch(detailSource, /開発用fixture|Midasスコア|機関保有率|Put \/ Call/);
});

test("connects visual earnings and Benzinga target history to the detail screen", async () => {
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const chartSource = await readFile(new URL("../app/features/stock-detail/StockDetailCharts.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /EarningsActualEstimateChart/);
  assert.match(pageSource, /AnalystTargetHistoryChart/);
  assert.match(pageSource, /parameters\[date_from\]/);
  assert.match(pageSource, /parameters\[date_to\]/);
  assert.match(pageSource, /parameters\[tickers\]/);
  assert.match(pageSource, /pagesize:\s*"1000"/);
  assert.match(chartSource, /detail\.chart\.target\.title/);
  assert.match(chartSource, /detail\.chart\.earnings\.title/);
  assert.match(chartSource, /attributionLogo:\s*false/);
});

test("keeps stock detail concise with merged financials and real category tabs", async () => {
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const detailStart = pageSource.indexOf("function StockDetailPage(");
  const detailEnd = pageSource.indexOf("function IndicatorsPanel(", detailStart);
  const detailSource = pageSource.slice(detailStart, detailEnd);
  const workspaceTabsStart = pageSource.indexOf('<nav className="workspace-view-tabs"');
  const workspaceTabsEnd = pageSource.indexOf("</nav>", workspaceTabsStart);
  const workspaceTabsSource = pageSource.slice(workspaceTabsStart, workspaceTabsEnd);

  assert.match(detailSource, /stock-detail-content-one-column/);
  assert.match(detailSource, /role="tablist"/);
  assert.match(detailSource, /role="tabpanel"/);
  assert.match(detailSource, /activeSection === "financials"/);
  assert.match(detailSource, /activeSection === "analyst"/);
  assert.match(detailSource, /activeSection === "technicals"/);
  assert.match(pageSource, /detail\.tab\.financials/);
  assert.match(detailSource, /detail\.section\.financials/);
  assert.match(detailSource, /EarningsActualEstimateChart/);
  assert.match(detailSource, /detail\.section\.targetHistory/);
  assert.match(detailSource, /AnalystRatingHistoryTable/);
  assert.doesNotMatch(detailSource, /scrollIntoView/);
  assert.doesNotMatch(detailSource, /stock-detail-sticky-chart/);
  assert.doesNotMatch(detailSource, /stock-detail-price-stage|価格推移/);
  assert.doesNotMatch(detailSource, /activeSection === "overview"|activeSection === "earnings"/);
  assert.doesNotMatch(detailSource, /aria-expanded=\{profileExpanded\}/);
  assert.match(pageSource, /earnings-comparison-grid/);
  assert.doesNotMatch(workspaceTabsSource, /> 詳細<\/button>/);
});
