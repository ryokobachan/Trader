import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OptionsPriceHistory } from "../api/options/price-history.server";
import {
  OptionsContractPriceHistory,
  OptionsContractHistoryData,
  optionHistoryCsv,
  optionHistoryDateAnchor,
  optionHistoryOpenInterestChange,
  optionHistoryResponseMatches,
} from "../src/app/features/stock-detail/OptionsContractPriceHistory";

function history(overrides: Partial<OptionsPriceHistory> = {}): OptionsPriceHistory {
  return {
    symbol: "NBIS", contractId: "NBIS260911C00230000", expiration: "2026-09-11", side: "call", strike: 230,
    underlying: { symbol: "NBIS" }, currency: "USD", timezone: "America/New_York", source: "ChartExchange",
    sourceUrl: "https://chartexchange.com/symbol/opra-nbis20260911c230/", fetchedAt: "2026-09-06T00:00:00.000Z",
    sourceAsOf: null, interval: "1d", requestedRange: "available", priceAdjustment: "source_ohlc", adjustedCloseUsed: false,
    openInterestDateBasis: "source_session_date_unverified",
    coverage: { from: "2026-09-01", to: "2026-09-05", firstDate: "2026-09-01", lastDate: "2026-09-05", missingBars: 1, sourceRows: 3, returnedBars: 3, observedBars: 2 },
    items: [{ date: "2026-09-01", openInterest: 100, close: 3, volume: 0 }, { date: "2026-09-02" }, { date: "2026-09-05", openInterest: 120, close: 4, volume: 20 }],
    ...overrides,
  };
}

test("date-only chart coordinates retain calendar gaps without inventing source timestamps", () => {
  const dates = ["2026-03-06", "2026-03-09", "2026-03-10"];
  assert.equal(optionHistoryDateAnchor(dates[1]) - optionHistoryDateAnchor(dates[0]), 3 * 86_400_000);
  assert.ok(Number.isNaN(optionHistoryDateAnchor("2026-02-31")));
  const value = history({ items: dates.map((date, index) => ({ date, openInterest: index * 100 })) });
  const html = renderToStaticMarkup(createElement(OptionsContractHistoryData, { history: value, metric: "openInterest", ja: true }));
  const positions = [...html.matchAll(/<circle cx="([\d.]+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(positions, [70, 557.5, 720]);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  assert.ok(value.items.every(item => item.time === undefined));
});

test("OI changes compare the prior valid observation, retain zero and return null for missing values", () => {
  const items = [{ date: "2026-09-01", openInterest: 100 }, { date: "2026-09-02" }, { date: "2026-09-05", openInterest: 0 }];
  assert.equal(optionHistoryOpenInterestChange(items, 0), null);
  assert.equal(optionHistoryOpenInterestChange(items, 1), null);
  assert.deepEqual(optionHistoryOpenInterestChange(items, 2), { value: -100, previousDate: "2026-09-01" });
  assert.equal(optionHistoryOpenInterestChange(items, 10), null);
  assert.deepEqual(optionHistoryOpenInterestChange([...items, { date: "2026-09-06", openInterest: 0 }], 3), { value: 0, previousDate: "2026-09-05" });
});

test("OI chart breaks at missing rows and labels change with its comparison date, not a daily change", () => {
  const html = renderToStaticMarkup(createElement(OptionsContractHistoryData, { history: history(), metric: "openInterest", ja: true }));
  assert.equal((html.match(/class="options-history-point"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /class="options-history-line"/);
  assert.match(html, /×/);
  assert.match(html, /前回観測からの増減/);
  assert.match(html, /\+20/);
  assert.match(html, /比較日: 2026-09-01/);
  assert.doesNotMatch(html, /前日比/);
  assert.match(html, /全取得期間.*2026-09-01.*2026-09-05/);
  assert.match(html, /公表時点は未確認/);
  assert.match(html, /ChartExchange ↗/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /過去データの日付/);
});

test("volume bars preserve zero and missing volume instead of plotting a zero for every gap", () => {
  const html = renderToStaticMarkup(createElement(OptionsContractHistoryData, { history: history(), metric: "volume", ja: false }));
  assert.equal((html.match(/class="options-history-volume"/g) ?? []).length, 2);
  assert.match(html, /<title>2026-09-01 · 0<\/title>/);
  assert.match(html, /×/);
  assert.doesNotMatch(html, /class="options-history-line"/);
});

test("CSV preserves absent source time, zero and missing OI, and source date provenance", () => {
  const lines = optionHistoryCsv(history()).split("\n");
  const columns = lines[0].split(",");
  const values = lines.slice(1).map(line => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1]));
  const field = (row: number, name: string) => values[row][columns.indexOf(name)];
  assert.equal(field(0, "timestamp"), "");
  assert.equal(field(0, "volume"), "0");
  assert.equal(field(0, "open_interest"), "100");
  assert.equal(field(1, "open_interest"), "");
  assert.equal(field(2, "open_interest_date_basis"), "source_session_date_unverified");
  assert.equal(field(2, "source_as_of"), "");
  assert.equal(field(2, "requested_range"), "available");
  assert.equal(field(2, "source_url"), history().sourceUrl);
  const json = JSON.parse(JSON.stringify(history()));
  assert.equal(json.items[0].time, undefined);
  assert.equal(json.openInterestDateBasis, "source_session_date_unverified");
});

test("response validation refuses source or contract mixing and invalid plotting dates", () => {
  const value = history();
  assert.ok(optionHistoryResponseMatches(value, "NBIS", value.contractId, "chartexchange"));
  assert.equal(optionHistoryResponseMatches(value, "NBIS", value.contractId, "yahoo"), false);
  assert.equal(optionHistoryResponseMatches(value, "MU", value.contractId, "chartexchange"), false);
  assert.equal(optionHistoryResponseMatches(value, "NBIS", "NBIS260911P00230000", "chartexchange"), false);
  assert.equal(optionHistoryResponseMatches({ ...value, items: [{ date: "2026-02-31" }] }, "NBIS", value.contractId, "chartexchange"), false);
});

test("initial controls prioritize ChartExchange OI and preserve manual expired-contract lookup", () => {
  const html = renderToStaticMarkup(createElement(OptionsContractPriceHistory, { symbol: "NBIS", ja: true }));
  assert.match(html, /value="chartexchange" selected=""/);
  assert.match(html, /aria-pressed="true">建玉/);
  assert.match(html, /Yahoo Finance（価格・出来高）/);
  assert.match(html, /満期済みの契約を調べる/);
  assert.match(html, /再取得/);
  assert.doesNotMatch(html, /最大1年|取得しています/);
});

test("Yahoo charts keep actual timestamps in export and explicitly exclude OI", () => {
  const yahoo = history({ source: "Yahoo Finance", sourceUrl: "https://finance.yahoo.com/quote/NBIS260911C00230000/history/", requestedRange: "1y", openInterestDateBasis: undefined,
    items: [{ date: "2026-09-04", time: 1788528600, close: 8.4, volume: 0 }] });
  const html = renderToStaticMarkup(createElement(OptionsContractHistoryData, { history: yahoo, metric: "close", ja: true }));
  assert.match(html, /Yahoo Finance ↗/);
  assert.match(html, /Yahoo Financeは価格・出来高のみ/);
  assert.doesNotMatch(html, /前回観測からの増減/);
  assert.match(html, /<circle cx="395"/);
  assert.match(optionHistoryCsv(yahoo), /"1788528600"/);
  assert.ok(optionHistoryResponseMatches(yahoo, yahoo.symbol, yahoo.contractId, "yahoo"));
});

test("empty histories and wholly missing OI produce no imaginary trend", () => {
  for (const items of [[], [{ date: "2026-09-04", close: 0 }]]) {
    const html = renderToStaticMarkup(createElement(OptionsContractHistoryData, { history: history({ items }), metric: "openInterest", ja: true }));
    assert.match(html, /有効な過去値がありません/);
    assert.doesNotMatch(html, /<svg|NaN|Infinity/);
  }
});
