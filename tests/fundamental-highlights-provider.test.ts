import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FundamentalHighlights } from "../src/app/features/stock-detail/FundamentalHighlights";
import { I18nProvider } from "../src/app/platform/i18n";

test("major valuation metrics stay discoverable when the source reports no value", () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: "ja" }, createElement(FundamentalHighlights, { metrics: [], source: { label: "TradingView" } })));
  for (const label of ["実績PER", "予想PER", "PEGレシオ", "PBR", "PSR", "ROE", "ROA", "ROIC"]) assert.ok(html.includes(label));
  assert.equal((html.match(/<dd>—<\/dd>/g) ?? []).length, 24);
  assert.match(html, /未取得または算出対象外/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("known source values are retained with meaningful accessible definitions", () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: "en" }, createElement(FundamentalHighlights, { metrics: [{id: "fundamentals.forwardPe", label:"予想PER", value: "24.80x"}], source: { label: "TradingView" }, period: "2025" })));
  assert.match(html, /24.80x/);
  assert.match(html, /<abbr tabindex="0" title="Price relative to forecast earnings">Forward P\/E<\/abbr>/);
  assert.match(html, /2025/);
});

test("explicit alternative provider ratios identify their source and negative multiples have an explanation", () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: "ja" }, createElement(FundamentalHighlights, {
    metrics: [{id:"fundamentals.forwardPe", label:"予想PER", value:"-75.53x"}], source: {label:"TradingView"},
    valuationSources: { forwardPe: { basis:"forward", status:"reported", provenance: {providerId:"yahoo",sourceId:"nbis-forward", sourceUrl:"https://finance.yahoo.com/quote/NBIS/",asOf:"2026-09-05T00:00:00Z",ingestedAt:"2026-09-05T00:00:00Z"}} },
  })));
  assert.match(html, /Yahoo Finance/);
  assert.match(html, /-75.53x/);
  assert.match(html, /正の倍率と同じ基準で割安さを比較できません/);
  assert.match(html, /https:\/\/finance\.yahoo\.com\/quote\/NBIS/);
});

test("calculated PEG visibly names historical TTM growth rather than suggesting forward growth", () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: "ja" }, createElement(FundamentalHighlights, {
    metrics: [{ id: "fundamentals.pegRatio", label: "PEG", value: "1.20x" }], source: { label: "TradingView" },
    valuationSources: { pegRatio: { basis: "growth-adjusted", status: "calculated",
      calculation: { formula: "close / dilutedEpsTtm / dilutedEpsTtmGrowthPercent", inputs: { close: 120, dilutedEpsTtm: 4, dilutedEpsTtmGrowthPercent: 25 }, earningsPeriod: "TTM", growthBasis: "diluted-eps-ttm-yoy" },
      provenance: { providerId: "tradingview", sourceId: "calculated", asOf: "2026-09-06", ingestedAt: "2026-09-06" },
    } },
  })));
  assert.match(html, /TTM・前年比から計算/);
  assert.match(html, /将来5年の成長予想は使用しません/);
  assert.match(html, /1\.20x/);
});
