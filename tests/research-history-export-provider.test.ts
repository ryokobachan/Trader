import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OptionsContractPriceHistory, optionHistoryCsv } from "../src/app/features/stock-detail/OptionsContractPriceHistory";
import { FinancialHistoryPanel, financialHistoryCsv } from "../src/app/features/stock-detail/FinancialResearchPanels";
import type { OptionsPriceHistory } from "../api/options/price-history.server";
import { I18nProvider } from "../src/app/platform/i18n";

const fetchedAt = "2026-09-05T00:00:00.000Z";
test("daily CSV exports missing prices as empty fields, not zero, with source and contract identity", () => {
  const history: OptionsPriceHistory = { symbol: "NBIS", contractId: "NBIS260911C00230000", expiration: "2026-09-11", side: "call", strike: 230,
    underlying: { symbol: "NBIS" }, currency: "USD", timezone: "America/New_York", source: "Yahoo Finance", fetchedAt: fetchedAt,
    sourceUrl: "https://finance.yahoo.com/quote/NBIS260911C00230000/history/", sourceAsOf: null, interval: "1d", requestedRange: "1y", priceAdjustment: "source_ohlc", adjustedCloseUsed: false,
    coverage: { from: "2025-09-05", to: "2026-09-05", firstDate: "2026-09-03", lastDate: "2026-09-04", missingBars: 1, sourceRows: 2, returnedBars: 2, observedBars: 1 },
    items: [{ date: "2026-09-04", time: 1788528600, close: 8.4, volume: 0 }, { date: "2026-09-03", time: 1788442200 }],
  };
  const lines = optionHistoryCsv(history).split("\n");
  assert.match(lines[0], /contract_id.*retrieved_at/);
  assert.match(lines[1], /"","","","8.4","0","USD"/);
  assert.match(lines[2], /"","","","","","USD"/);
});
test("past-price lookup remains accessible without a current Nasdaq snapshot", () => {
  const prices = renderToStaticMarkup(createElement(OptionsContractPriceHistory, { symbol: "NBIS", ja: true }));
  assert.match(prices, /満期済みの契約を調べる/);
  assert.match(prices, /現在のチェーンを取得できない場合も過去価格を照会/);
  assert.doesNotMatch(prices, /過去の価格・出来高を取得しています/);
});
test("annual cash-flow fallback uses its own source and exports original units", () => {
  const rows = [{ period: "2025-12-31", fiscalDateEnding: "2025-12-31", currency: "USD" as const, operatingCashFlow: 384800000, investingCashFlow: -4229300000, financingCashFlow: 5125500000,
    provenance: { providerId: "yahoo", sourceId: "yahoo:cashflow", asOf: "2025-12-31", ingestedAt: fetchedAt } }];
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: "en" }, createElement(FinancialHistoryPanel, { annualCashFlows: rows })));
  assert.match(html, /Operating, investing &amp; financing cash flow/);
  assert.match(html, /Yahoo Finance/);
  assert.match(html, /reporting period ends, not release dates/);
  const csv = financialHistoryCsv(rows, "annual", ["operatingCashFlow", "investingCashFlow", "financingCashFlow", "capitalExpenditure"]);
  assert.match(csv, /"investingCashFlow","-4229300000","yahoo"/);
  assert.match(csv, /"capitalExpenditure","","yahoo"/);
});
