import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CORE_SYMBOL_SUMMARY_MODULES } from "../src/app/features/symbol-summary/core-modules";
import { SymbolSummaryHost } from "../src/app/features/symbol-summary/SymbolSummaryHost";
import { I18nProvider, type Locale } from "../src/app/platform/i18n";
import {
  compareSummaryPrices,
  formatSummaryAfterHoursPrice,
  formatSummaryCurrentPrice,
  type SymbolSummaryIntelligence,
  type SymbolSummaryModuleProps,
  type SymbolSummaryStock,
  validSummaryAfterHoursClose,
} from "../src/app/platform/symbol-summary";
import type { SyntheticLatestClose } from "../src/app/platform/provider-contracts";

const stock: SymbolSummaryStock = {
  ticker: "AAPL",
  name: "Apple Inc.",
  logoPath: "https://financialmodelingprep.com/image-stock/AAPL.png",
  logoFallback: "AA",
  market: "NASDAQ",
  sector: "Technology",
  currency: "$",
  currencyCode: "USD",
  price: 200,
  change: 1.5,
  changeValue: 3,
  high: 202,
  low: 197,
  volume: "12M",
  marketCap: "3T",
  target: 220,
  targetLow: 180,
  targetHigh: 250,
  analysts: 10,
  buy: 7,
  neutral: 2,
  sell: 1,
  revenue: "400B",
  revenueGrowth: "+5%",
  eps: "6.00",
  epsGrowth: "+4%",
  pe: "30",
  dividend: "0.5%",
};

const intelligence: SymbolSummaryIntelligence = {
  country: "US",
  industry: "Consumer Electronics",
  website: "apple.com",
  employees: "100,000",
  nextEarnings: "2026/10/30",
  earningsSession: "取引終了後",
  earningsEstimate: "1.50",
  revenueEstimate: "100B",
  exDividend: "2026/08/10",
  description: "Apple designs consumer technology products.",
  averageVolume30d: "50M",
  dayRangePosition: 50,
  yearRangePosition: 60,
  yearLow: "150",
  yearHigh: "220",
  beta: "1.2",
  dataFreshness: "1分前",
  performance: { week: "+1%", month: "+2%", threeMonths: "+3%", yearToDate: "+4%", year: "+5%" },
  technical: { overall: "買い", movingAverages: "買い", oscillators: "中立", rsi: "55" },
};

function latestClose(close: number | null, symbol = "AAPL"): SyntheticLatestClose {
  return {
    symbol,
    sourceSymbol: `BINANCE:${symbol}USDT.P`,
    close,
    currency: "USDT",
    source: "tradingview-websocket",
    updatedAt: close === null ? null : "2026-08-09T10:04:00Z",
  };
}

function renderSummary(
  locale: Locale = "en",
  overrides: Partial<SymbolSummaryModuleProps> = {},
  initiallyEnabledModuleKeys?: readonly string[],
) {
  return renderToStaticMarkup(createElement(
    I18nProvider,
    { initialLocale: locale },
    createElement(SymbolSummaryHost, {
      stock,
      intelligence,
      watched: false,
      onToggleWatched: () => undefined,
      onOpenDetails: () => undefined,
      registrations: CORE_SYMBOL_SUMMARY_MODULES,
      initiallyEnabledModuleKeys,
      ...overrides,
    }),
  ));
}

test("compares the selected symbol current and after-hours prices with semantic tones", () => {
  assert.equal(compareSummaryPrices(200, 201), "positive");
  assert.equal(compareSummaryPrices(200, 199), "negative-text");
  assert.equal(compareSummaryPrices(200, 200), "neutral");
  assert.equal(compareSummaryPrices(0, 201), "neutral");
  assert.equal(compareSummaryPrices(200, null), "neutral");

  assert.equal(validSummaryAfterHoursClose(stock, latestClose(201)), 201);
  assert.equal(validSummaryAfterHoursClose(stock, latestClose(201, "MSFT")), null);
  assert.equal(validSummaryAfterHoursClose(stock, latestClose(0)), null);
  assert.equal(validSummaryAfterHoursClose(stock, latestClose(null)), null);
});

test("formats the summary after-hours value without a currency prefix", () => {
  assert.equal(formatSummaryAfterHoursPrice(312.28), "312.28");
  assert.equal(formatSummaryAfterHoursPrice(1.23456), "1.2346");
  assert.equal(formatSummaryAfterHoursPrice(null), "-");
  assert.equal(formatSummaryCurrentPrice(stock), "200.00");
});

test("fixed identity module renders after-hours value and exposes it to generic module props", () => {
  const moduleProps: SymbolSummaryModuleProps = {
    stock,
    intelligence,
    afterHours: latestClose(201.25),
    watched: false,
    onToggleWatched: () => undefined,
    density: "compact",
  };
  const html = renderSummary("en", moduleProps, []);

  assert.match(html, />After hours</);
  assert.match(html, /class="positive">201\.25</);
  assert.match(html, />USD</);
  assert.doesNotMatch(html, />USDT</);
  assert.doesNotMatch(html, />\$200\.00</);
  assert.doesNotMatch(html, />\$201\.25</);
  assert.ok(html.indexOf("data-module-id=\"core.identity_quote\"") < html.indexOf("Open AAPL details"));
});

test("technical ratings use the same diverging green and red track as performance", () => {
  const html = renderSummary();

  assert.match(html, /summary-technical-meter summary-performance-track/);
  assert.match(html, /data-tone="positive"/);
  assert.doesNotMatch(html, /<meter/);
});

test("symbol summary SSR defaults to English and localizes provider enum values", () => {
  const html = renderSummary("en");

  assert.match(html, />Symbol overview</);
  assert.match(html, /Display items/);
  assert.match(html, />Price range</);
  assert.match(html, />Today&#x27;s range</);
  assert.match(html, />Performance</);
  assert.match(html, />1W</);
  assert.match(html, />Technicals</);
  assert.match(html, />Moving averages</);
  assert.match(html, />Buy</);
  assert.match(html, />Neutral</);
  assert.match(html, />Details</);
  assert.doesNotMatch(html, />銘柄概要</);
  assert.doesNotMatch(html, />買い</);
});

test("symbol summary can render its Japanese locale without changing module data", () => {
  const html = renderSummary("ja", { afterHours: latestClose(201.25) });

  assert.match(html, />銘柄概要</);
  assert.match(html, /表示項目/);
  assert.match(html, />時間外</);
  assert.match(html, />価格レンジ</);
  assert.match(html, />本日のレンジ</);
  assert.match(html, />パフォーマンス</);
  assert.match(html, />1週</);
  assert.match(html, />テクニカル</);
  assert.match(html, />移動平均</);
  assert.match(html, />買い</);
  assert.match(html, />詳細</);
  assert.match(html, /Apple designs consumer technology products\./);
});
