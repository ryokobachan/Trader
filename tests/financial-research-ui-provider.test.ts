import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  CompanyResearchPanel,
  CompanyNewsPanel,
  DividendsPanel,
  FinancialHistoryPanel,
  FiscalForecastPanel,
  OwnershipOptionsPanel,
  financialHistoryPoints,
  financialYearOverYear,
  tradingViewOptionsUrl,
} from "../src/app/features/stock-detail/FinancialResearchPanels";
import { I18nProvider, type Locale } from "../src/app/platform/i18n";
import type {
  CompanyResearch,
  DataProvenance,
  FinancialStatementPeriod,
  FundamentalFiscalForecast,
} from "../src/app/platform/provider-contracts";

const PROVENANCE: DataProvenance = Object.freeze({
  providerId: "tradingview", sourceId: "test:annual-financials", asOf: "2026-09-05T04:00:00.000Z",
  ingestedAt: "2026-09-05T04:00:00.000Z",
});

function render(element: ReactElement, locale: Locale = "en") {
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale }, element));
}

function period(value: string, data: Partial<FinancialStatementPeriod> = {}): FinancialStatementPeriod {
  return Object.freeze({ period: value, currency: "USD", provenance: PROVENANCE, ...data });
}

function research(data: Partial<CompanyResearch> = {}): CompanyResearch {
  return {
    instrumentId: "us:XNAS:NBIS", corporateActions: [],
    coverage: { ownership: "available", quarterlyFinancials: "available", corporateActions: "available" },
    provenance: { ...PROVENANCE, providerId: "yahoo", sourceId: "test:research" }, ...data,
  };
}

function corporateActionsSection(html: string) {
  const section = html.split("CORPORATE ACTIONS")[1]?.split("COMPANY NEWS")[0];
  assert.ok(section, "the corporate-actions panel must exist");
  return section;
}

function financialChart(html: string) {
  const chart = html.split('<svg class="financial-history-chart financial-comparison-chart"')[1]?.split("</svg>")[0];
  assert.ok(chart, "the financial comparison chart must exist");
  return chart;
}

test("financial-history points sort by explicit source dates without mutating the input", () => {
  const input = Object.freeze([
    period("FY 2025", { fiscalDateEnding: "2025-08-31", revenue: 300 }),
    period("FY 2023", { fiscalDateEnding: "2023-08-31", revenue: 100 }),
    period("FY 2024", { fiscalDateEnding: "2024-08-31", revenue: 200 }),
  ]);
  assert.deepEqual(financialHistoryPoints(input, "revenue"), [
    { period: "FY 2023", value: 100 }, { period: "FY 2024", value: 200 }, { period: "FY 2025", value: 300 },
  ]);
  assert.deepEqual(input.map(row => row.period), ["FY 2025", "FY 2023", "FY 2024"]);
  assert.deepEqual(financialHistoryPoints([period("2025", { revenue: 2 }), period("2024", { revenue: 1 })], "revenue"),
    [{ period: "2024", value: 1 }, { period: "2025", value: 2 }]);
});

test("financial-history points preserve losses and zero while missing and nonfinite observations become gaps", () => {
  const input = [
    period("2020", { netIncome: -300 }), period("2021", { netIncome: 0 }), period("2022"),
    period("2023", { netIncome: Number.NaN }), period("2024", { netIncome: Number.POSITIVE_INFINITY }),
  ];
  assert.deepEqual(financialHistoryPoints(input, "netIncome"), [
    { period: "2020", value: -300 }, { period: "2021", value: 0 }, { period: "2022", value: null },
    { period: "2023", value: null }, { period: "2024", value: null },
  ]);
});

test("financial history renders a negative bar and a table gap, without fabricating a zero bar", () => {
  const html = render(createElement(FinancialHistoryPanel, { annual: [
    period("2025", { revenue: 500 }), period("2024"), period("2023", { revenue: -100 }),
  ] }));
  assert.match(html, /TradingView/);
  assert.match(html, /<title id="[^"]+">Revenue 2023 – 2025<\/title>/);
  assert.equal((html.match(/<rect /g) ?? []).length, 2);
  assert.match(html, /data-negative="true"/);
  assert.match(html, /<title>2023 · Revenue: -\$100/);
  assert.match(html, /<th scope="row">Revenue<\/th><td title="\$500\.00">\$500<\/td><td>—<\/td>/);
  assert.doesNotMatch(html, /<details>/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("financial comparison charts compare same-unit income measures and leave EPS in the table", () => {
  const html = render(createElement(FinancialHistoryPanel, { annual: [
    period("2024", { revenue: 1_000, operatingIncome: 250, netIncome: 200, eps: 2.5, totalAssets: 5_000 }),
    period("2025", { revenue: 1_200, operatingIncome: 300, netIncome: 220, eps: 3 }),
  ] }));
  const svg = html.split("<svg")[1].split("</svg>")[0];
  assert.equal((svg.match(/<rect /g) ?? []).length, 6);
  assert.match(svg, /data-metric="revenue"/);
  assert.match(svg, /data-metric="operatingIncome"/);
  assert.match(svg, /data-metric="netIncome"/);
  assert.doesNotMatch(svg, /data-metric="eps"|data-metric="totalAssets"/);
  assert.match(html, /<th scope="row">Diluted EPS<\/th><td title="\$3\.00">\$3\.00<\/td><td title="\$2\.50">\$2\.50<\/td>/);
  assert.match(html, /YoY \+20%/);
  assert.match(html, /aria-pressed="false">Balance sheet/);
  assert.match(html, /disabled="" aria-pressed="false">Cash flow/);
});

test("cash-flow comparison preserves unavailable categories instead of substituting CapEx or free cash flow", () => {
  const cash = render(createElement(FinancialHistoryPanel, { annual: [
    period("2025", { operatingCashFlow: 100, capitalExpenditure: -60, freeCashFlow: 40 }),
  ] }));
  const chart = financialChart(cash);
  assert.match(cash, /aria-pressed="true">Cash flow/);
  assert.equal((chart.match(/<rect /g) ?? []).length, 1);
  assert.match(chart, /data-metric="investingCashFlow" data-missing="true"/);
  assert.match(chart, /data-metric="financingCashFlow" data-missing="true"/);
  assert.doesNotMatch(chart, /data-metric="capitalExpenditure"|data-metric="freeCashFlow"/);
  assert.match(cash, /<th scope="row">Investing cash flow<\/th><td>—<\/td>/);
  assert.match(cash, /<th scope="row">Financing cash flow<\/th><td>—<\/td>/);
  assert.match(cash, /<th scope="row">Capital expenditure<\/th><td title="-\$60\.00" class="financial-negative-value">-\$60<\/td>/);
  assert.match(cash, /<option value="freeCashFlow">Free cash flow/);
  assert.match(cash, /Capital expenditure retains the source sign convention/);
});

test("financial comparison falls back to available balance-sheet observations", () => {
  const balance = render(createElement(FinancialHistoryPanel, { annual: [
    period("2025", { totalAssets: 1_000, totalLiabilities: 600, shareholdersEquity: 400 }),
  ] }));
  assert.match(balance, /aria-pressed="true">Balance sheet/);
  assert.match(balance, /data-metric="totalLiabilities"/);
  assert.doesNotMatch(balance, /data-metric="totalDebt"/);
});

test("annual cash-flow bars compare operating, investing and financing with one signed scale and distinct fills", () => {
  const html = render(createElement(FinancialHistoryPanel, { annual: [
    period("2025", { operatingCashFlow: 120, investingCashFlow: -160, financingCashFlow: 50, freeCashFlow: 20, capitalExpenditure: -100 }),
    period("2024", { operatingCashFlow: 100, investingCashFlow: -80, financingCashFlow: -20 }),
  ] }), "ja");
  const chart = financialChart(html);
  assert.match(html, /TradingView · 2026-09-05/);
  assert.match(html, /年次 · USD · 2024 – 2025/);
  assert.match(chart, /営業・投資・財務キャッシュフロー 2024 – 2025/);
  assert.equal((chart.match(/<rect /g) ?? []).length, 6);
  for (const metric of ["operatingCashFlow", "investingCashFlow", "financingCashFlow"]) assert.equal((chart.match(new RegExp(`data-metric="${metric}"`, "g")) ?? []).length, 2);
  assert.match(chart, /data-metric="investingCashFlow" data-negative="true"[^>]+fill="none"/);
  assert.match(chart, /data-metric="financingCashFlow" data-negative="true"[^>]+fill="url\(#[^"]+-cashflow-hatch\)"/);
  const positive = chart.match(/data-metric="operatingCashFlow" x="[^"]+" y="([\d.]+)" width="[^"]+" height="([\d.]+)"/)!;
  const negative = chart.match(/data-metric="investingCashFlow" data-negative="true" x="[^"]+" y="([\d.]+)"/)!;
  assert.ok(positive && negative);
  assert.ok(Math.abs(Number(positive[1]) + Number(positive[2]) - Number(negative[1])) < 1e-10);
  assert.match(chart, /tabindex="0" role="button" aria-pressed="false" aria-label="2024:/);
  assert.match(chart, /tabindex="0" role="button" aria-pressed="true" aria-label="2025:/);
  assert.match(html, /キャッシュフローを確認する期間/);
  assert.match(html, /為替換算などの影響/);
});

test("quarterly cash flows keep reported zero distinct from missing values in all three categories", () => {
  const html = render(createElement(FinancialHistoryPanel, { quarterly: [
    period("2026-06-30", { operatingCashFlow: 0, investingCashFlow: -50, financingCashFlow: Number.NaN }),
    period("2026-03-31", { operatingCashFlow: 30, investingCashFlow: 0, financingCashFlow: 60 }),
  ] }));
  const chart = financialChart(html);
  assert.match(html, /disabled="" aria-pressed="false">Annual/);
  assert.match(html, /aria-pressed="true">Quarterly/);
  assert.match(html, /Quarterly · USD · 2026-03-31 – 2026-06-30/);
  assert.match(chart, /<line data-metric="operatingCashFlow" data-zero="true"/);
  assert.match(chart, /<line data-metric="investingCashFlow" data-zero="true"/);
  assert.match(chart, /<text data-metric="financingCashFlow" data-missing="true"/);
  assert.equal((chart.match(/<rect /g) ?? []).length, 3);
  assert.match(html, /<th scope="row">Financing cash flow<\/th><td>—<\/td><td title="\$60\.00">\$60<\/td>/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("supplemental-only cash flow data does not masquerade as the three cash-flow categories", () => {
  const html = render(createElement(FinancialHistoryPanel, { annual: [period("2025", { freeCashFlow: 40, capitalExpenditure: -60 })] }));
  const chart = financialChart(html);
  assert.match(html, /Operating, investing and financing CF are unavailable/);
  assert.equal((chart.match(/<rect /g) ?? []).length, 0);
  assert.equal((chart.match(/data-missing="true"/g) ?? []).length, 3);
  assert.match(html, /<option value="freeCashFlow">Free cash flow/);
  assert.match(html, /<th scope="row">Free cash flow<\/th><td title="\$40\.00">\$40<\/td>/);
});

test("growth uses the same fiscal period a year earlier, never the adjacent quarter", () => {
  const current = period("2026-Q2", { fiscalDateEnding: "2026-06-30", revenue: 150 });
  const rows = [
    period("2025-Q2", { fiscalDateEnding: "2025-06-30", revenue: 100 }),
    period("2026-Q1", { fiscalDateEnding: "2026-03-31", revenue: 140 }), current,
  ];
  assert.equal(financialYearOverYear(rows, current, "revenue"), 0.5);
  assert.equal(financialYearOverYear(rows.slice(1), current, "revenue"), null);
  assert.equal(financialYearOverYear([period("2025", { netIncome: -5 })], period("2026", { netIncome: 3 }), "netIncome"), null);
  assert.equal(financialYearOverYear([period("2025", { revenue: 0 })], period("2026", { revenue: 3 }), "revenue"), null);
  assert.equal(financialYearOverYear([period("2025", { revenue: 2 })], period("2026", { revenue: Number.NaN }), "revenue"), null);
});

test("year-over-year comparisons use fiscal labels across 52/53-week reporting calendars", () => {
  const current = period("2026-Q3", { fiscalDateEnding: "2026-06-27", revenue: 150 });
  const previous = period("2025-Q3", { fiscalDateEnding: "2025-06-28", revenue: 100 });
  const differentQuarter = period("2025-Q2", { fiscalDateEnding: "2025-06-27", revenue: 30 });
  assert.equal(financialYearOverYear([previous, differentQuarter, current], current, "revenue"), 0.5);
  const annual = period("2025", { fiscalDateEnding: "2025-09-27", revenue: 200 });
  assert.equal(financialYearOverYear([period("2024", { fiscalDateEnding: "2024-09-28", revenue: 100 }), annual], annual, "revenue"), 1);
  const dated = period("2026-06-30", { fiscalDateEnding: "2026-06-30", revenue: 150 });
  assert.equal(financialYearOverYear([period("2025-06-30", { revenue: 100 }), dated], dated, "revenue"), 0.5);
  assert.equal(financialYearOverYear([period("2025-06-29", { revenue: 100 }), dated], dated, "revenue"), null);
});

test("a nominal annual row without values does not hide available quarterly data", () => {
  const html = render(createElement(FinancialHistoryPanel, { annual: [period("2025")], quarterly: [period("2026-06-30", { revenue: 1_000 })] }));
  assert.match(html, /disabled="" aria-pressed="false">Annual/);
  assert.match(html, /aria-pressed="true">Quarterly/);
  assert.match(html, /<title>2026-06-30 · Revenue: \$1K/);
});

test("quarterly-only financial history chooses source-dated quarters and the actual available metric", () => {
  const html = render(createElement(FinancialHistoryPanel, { quarterly: [
    period("2026-06-30", { fiscalDateEnding: "2026-06-30", eps: -0.68,
      provenance: { ...PROVENANCE, providerId: "yahoo" } }),
  ] }));
  assert.match(html, /disabled="" aria-pressed="false">Annual/);
  assert.match(html, /aria-pressed="true">Quarterly/);
  assert.match(html, /Yahoo Finance/);
  assert.match(html, /Diluted EPS/);
  assert.match(html, /-\$0\.68/);
  assert.match(html, /2026-06-30/);
  assert.doesNotMatch(html, /2026-Q2/);
});

test("empty financial history emits no illustrative chart", () => {
  assert.equal(render(createElement(FinancialHistoryPanel)), "");
  assert.equal(render(createElement(FinancialHistoryPanel, { annual: [period("2025")] })), "");
});

test("fiscal forecast SSR shows upcoming estimates chronologically and excludes reported actuals", () => {
  const forecasts: readonly FundamentalFiscalForecast[] = Object.freeze([
    { period: "2026-Q4", reported: false, epsEstimate: 1.2, revenueEstimate: 900_000_000,
      epsActual: 98765, provenance: PROVENANCE },
    { period: "2026-Q2", reported: true, epsActual: -0.12, epsEstimate: -0.7,
      revenueActual: 582_300_000, provenance: PROVENANCE },
    { period: "2026-Q3", reported: false, epsEstimate: -0.4, revenueEstimate: 700_000_000, provenance: PROVENANCE },
  ]);
  const html = render(createElement(FiscalForecastPanel, { forecasts }));
  assert.match(html, /aria-pressed="true">Upcoming/);
  assert.match(html, /aria-pressed="false">Reported results/);
  assert.ok(html.indexOf("2026-Q3") < html.indexOf("2026-Q4"));
  assert.match(html, /-\$0\.40/);
  assert.doesNotMatch(html, /2026-Q2|98765|98,765|EPS actual|Revenue actual/);
  assert.deepEqual(forecasts.map(row => row.period), ["2026-Q4", "2026-Q2", "2026-Q3"]);
});

test("reported-only history does not appear as an upcoming forecast", () => {
  const html = render(createElement(FiscalForecastPanel, { forecasts: [
    { period: "2026-Q2", reported: true, epsActual: 0.5, provenance: PROVENANCE },
  ] }));
  assert.match(html, /No data for these periods/);
  assert.doesNotMatch(html, /2026-Q2|<tbody>/);
  assert.equal(render(createElement(FiscalForecastPanel)), "");
});

test("ownership displays the actual Stock Analysis source and converts normalized fractions once", () => {
  const html = render(createElement(CompanyResearchPanel, { research: research({
    ownership: { insiderOwnership: 0.125, institutionalOwnership: 0.5678,
      shortFloatRatio: 0, shortRatio: 2.5, shortInterestDate: "2026-08-15",
      provenance: { ...PROVENANCE, providerId: "stockanalysis" } },
  }) }));
  const ownership = [...html.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)]
    .map(([section]) => section)
    .find(section => section.includes('<span class="eyebrow">OWNERSHIP &amp; SHORT INTEREST</span>'));
  assert.ok(ownership, "the ownership card must exist independently of option-history sources");
  assert.match(ownership, /<small class="financial-research-source">Stock Analysis · 2026-09-05<\/small>/);
  assert.doesNotMatch(ownership, /Google Finance|Yahoo Finance/);
  assert.match(ownership, /Insider ownership<\/span><b>12\.5%/);
  assert.match(ownership, /Institutional ownership<\/span><b>56\.78%/);
  assert.match(ownership, /Short % of float<\/span><b>0%/);
  assert.match(ownership, /2\.50 days/);
  assert.match(ownership, /Short interest as of.*2026-08-15/);
});

test("corporate actions distinguish confirmed empty history from an unavailable source", () => {
  const empty = corporateActionsSection(render(createElement(CompanyResearchPanel, { research: research() })));
  assert.match(empty, /No matching events in this period/);
  assert.doesNotMatch(empty, /This data is currently unavailable/);
  const unavailable = corporateActionsSection(render(createElement(CompanyResearchPanel, { research: research({
    coverage: { ownership: "available", quarterlyFinancials: "available", corporateActions: "unavailable" },
  }) })));
  assert.match(unavailable, /This data is currently unavailable/);
  assert.doesNotMatch(unavailable, /No matching events/);
});

test("corporate actions show source dates, per-share dividends and split ratios without mixing units", () => {
  const html = corporateActionsSection(render(createElement(CompanyResearchPanel, { research: research({
    corporateActions: [
      { id: "split", type: "split", date: "2024-06-10", numerator: 10, denominator: 1, provenance: PROVENANCE },
      { id: "dividend", type: "dividend", date: "2026-08-18", amount: 0.25, currency: "USD", provenance: PROVENANCE },
    ],
  }) })));
  assert.ok(html.indexOf("2026-08-18") < html.indexOf("2024-06-10"));
  assert.match(html, /\$0\.25 \/ share/);
  assert.match(html, /10 : 1/);
  assert.match(html, /dividends use ex-dividend dates/);
  assert.doesNotMatch(html, /No matching events|currently unavailable/);
});

test("retained ownership and corporate events disclose their stale state after refresh failure", () => {
  const stale = { ...PROVENANCE, providerId: "yahoo", isStale: true };
  const html = render(createElement(CompanyResearchPanel, { research: research({
    ownership: { insiderOwnership: 0.1, provenance: stale },
    corporateActions: [{ id: "old-dividend", type: "dividend", date: "2026-08-01", amount: 1, currency: "USD", provenance: stale }],
    coverage: { ownership: "unavailable", quarterlyFinancials: "available", corporateActions: "unavailable" },
  }) }));
  assert.match(html, /Insider ownership<\/span><b>10%/);
  assert.match(html, /Refresh failed; showing the last available values/);
  assert.match(html, /Refresh failed; showing the last available events/);
  assert.match(html, /2026-08-01/);
});

test("Japanese research renders translated labels and truthful unavailable/empty states", () => {
  const html = render(createElement(CompanyResearchPanel, { research: research({
    ownership: { insiderOwnership: 0.1, provenance: { ...PROVENANCE, providerId: "stockanalysis" } },
  }) }), "ja");
  assert.match(html, /内部者保有比率/);
  assert.match(html, /10%/);
  assert.match(html, /Stock Analysis/);
  assert.match(html, /この期間に該当するイベントはありません/);
  assert.match(html, /表示できるニュースはありません/);
  assert.doesNotMatch(html, /Insider ownership|No matching events|No news is available/);
});

test("ownership/options tab is independent and loads source-backed options with external links", () => {
  const html = render(createElement(OwnershipOptionsPanel, { research: research({
    ownership: { institutionalOwnership: 0.4, provenance: PROVENANCE },
  }) }), "ja");
  assert.match(html, /機関保有比率/);
  assert.match(html, /class="loading-spinner" aria-hidden="true"/);
  assert.doesNotMatch(html, />オプション価格を取得しています/);
  assert.match(html, /https:\/\/jp.tradingview.com\/symbols\/NASDAQ-NBIS\/options-chain\//);
  assert.doesNotMatch(html, /CORPORATE ACTIONS|COMPANY NEWS/);
  assert.equal(tradingViewOptionsUrl("nbis", "XNAS", true), "https://jp.tradingview.com/symbols/NASDAQ-NBIS/options-chain/");
  assert.equal(tradingViewOptionsUrl("IBM", "XNYS"), "https://www.tradingview.com/symbols/NYSE-IBM/options-chain/");
  assert.equal(tradingViewOptionsUrl("NBIS", "unknown"), undefined);
  assert.equal(tradingViewOptionsUrl("../bad", "NASDAQ"), undefined);
  const unavailable = render(createElement(OwnershipOptionsPanel));
  assert.match(unavailable, /Select a symbol to view option prices/);
  assert.doesNotMatch(unavailable, /href=/);
});

test("dividend and news panels can render without unrelated research sections", () => {
  const dividends = render(createElement(DividendsPanel, { research: research() }));
  assert.match(dividends, /No matching events in this period/);
  assert.doesNotMatch(dividends, /OWNERSHIP|OPTIONS|COMPANY NEWS/);
  const news = Object.freeze([
    { id: "older", instrumentId: "us:XNAS:NBIS", title: "Earlier company story", url: "https://example.com/earlier", publisher: "Source", publishedAt: "2026-08-01T00:00:00Z", provenance: PROVENANCE },
    { id: "newer", instrumentId: "us:XNAS:NBIS", title: "Latest company story", url: "https://example.com/latest", publisher: "Source", publishedAt: "2026-09-01T00:00:00Z", provenance: PROVENANCE },
  ]);
  const html = render(createElement(CompanyNewsPanel, { news }));
  assert.ok(html.indexOf("Latest company story") < html.indexOf("Earlier company story"));
  assert.deepEqual(news.map(item => item.id), ["older", "newer"]);
  assert.doesNotMatch(html, /CORPORATE ACTIONS|OWNERSHIP/);
});
