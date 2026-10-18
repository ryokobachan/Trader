"use client";

import type { StockDetailMetric, StockDetailSource } from "@api/stock-detail/metrics";
import type { FundamentalsSnapshot } from "../../platform/provider-contracts";
import { useI18n } from "../../platform/i18n";

const GROUPS = [
  { ja: "株価の評価", en: "Valuation", metrics: [
    ["trailingPe", "実績PER", "Trailing P/E", "株価 ÷ 直近12か月の1株利益", "Price / trailing 12-month earnings per share"],
    ["forwardPe", "予想PER", "Forward P/E", "予想利益に対する株価の倍率", "Price relative to forecast earnings"],
    ["pegRatio", "PEGレシオ", "PEG ratio", "利益成長率を考慮したPER。成長率の期間は提供元の定義です。", "P/E adjusted for earnings growth; growth period follows the source definition"],
    ["priceToBook", "PBR", "Price / book", "株価 ÷ 1株純資産", "Price / book value per share"],
    ["priceToSales", "PSR", "Price / sales", "時価総額 ÷ 売上高", "Market capitalization / revenue"],
    ["priceToFreeCashFlow", "株価 / FCF", "Price / FCF", "時価総額 ÷ フリーキャッシュフロー", "Market capitalization / free cash flow"],
    ["enterpriseValueToEbitda", "EV / EBITDA", "EV / EBITDA", "企業価値 ÷ 利払・税引・償却前利益", "Enterprise value / earnings before interest, tax, depreciation and amortization"],
    ["enterpriseValueToRevenue", "EV / 売上高", "EV / revenue", "企業価値 ÷ 売上高", "Enterprise value / revenue"],
    ["enterpriseValue", "企業価値（EV）", "Enterprise value", "株式と純有利子負債などを合わせた企業の評価額", "Value of equity plus net debt and other source adjustments"],
    ["earningsYield", "利益利回り", "Earnings yield", "利益 ÷ 時価総額", "Earnings / market capitalization"],
  ] },
  { ja: "成長と収益性", en: "Growth & profitability", metrics: [
    ["revenueGrowth", "売上高成長率", "Revenue growth", "前年の同じ期間に対する売上高の増減", "Revenue change against the same prior-year period"],
    ["epsGrowth", "EPS成長率", "EPS growth", "前年の同じ期間に対する1株利益の増減", "EPS change against the same prior-year period"],
    ["eps", "EPS", "EPS", "1株当たり利益。財務実績の対象期間の値です。", "Earnings per share for the stated financial reporting period"],
    ["roe", "ROE", "ROE", "自己資本に対する利益の割合", "Return on equity"],
    ["roa", "ROA", "ROA", "総資産に対する利益の割合", "Return on assets"],
    ["roic", "ROIC", "ROIC", "投下資本に対する利益の割合", "Return on invested capital"],
    ["grossMargin", "粗利率", "Gross margin", "粗利益 ÷ 売上高", "Gross profit / revenue"],
    ["operatingMargin", "営業利益率", "Operating margin", "営業利益 ÷ 売上高", "Operating income / revenue"],
    ["netMargin", "純利益率", "Net margin", "純利益 ÷ 売上高", "Net income / revenue"],
    ["freeCashFlowMargin", "FCFマージン", "FCF margin", "フリーキャッシュフロー ÷ 売上高", "Free cash flow / revenue"],
  ] },
  { ja: "財務の健全性", en: "Financial health", metrics: [
    ["debtToEquity", "負債 / 自己資本", "Debt / equity", "有利子負債 ÷ 自己資本", "Total debt / equity"],
    ["currentRatio", "流動比率", "Current ratio", "流動資産 ÷ 流動負債", "Current assets / current liabilities"],
    ["quickRatio", "当座比率", "Quick ratio", "換金しやすい流動資産 ÷ 流動負債", "Liquid current assets / current liabilities"],
    ["freeCashFlowYield", "FCF利回り", "FCF yield", "フリーキャッシュフロー ÷ 時価総額", "Free cash flow / market capitalization"],
  ] },
] as const;

export function FundamentalHighlights({ metrics, source, period, valuationSources }: {
  metrics: readonly StockDetailMetric[];
  source: StockDetailSource;
  period?: string;
  valuationSources?: FundamentalsSnapshot["valuationSources"];
}) {
  const { locale } = useI18n();
  const ja = locale === "ja";
  const byId = new Map(metrics.map(metric => [metric.id, metric]));
  return <section className="fundamental-highlights" aria-label={ja ? "主要指標" : "Key metrics"}>
    <header className="stock-detail-section-heading"><div><span className="eyebrow">KEY METRICS</span><h2>{ja ? "主要指標" : "Key metrics"}</h2></div><small>{source.label}{period ? ` · ${period}` : ""}</small></header>
    <details className="metric-reading-help"><summary>{ja ? "指標の見方" : "About these metrics"}</summary><p className="financial-research-caption">{ja ? "PER・PSRなどは直近12か月、予想PERは予想利益、収益性は財務実績の対象期間に基づきます。— は未取得または算出対象外。指標名にカーソルを合わせると意味を確認できます。" : "Valuation ratios use trailing or forecast earnings; profitability follows the financial reporting period. — means unavailable or not applicable. Focus or hover over a metric for its definition."}</p></details>
    <div className="fundamental-highlight-groups">{GROUPS.map(group => <section key={group.en}><h3>{ja ? group.ja : group.en}</h3><dl>{group.metrics.map(([id, jp, en, jpHelp, enHelp]) => {
      const metric = byId.get(`fundamentals.${id}`);
      const observation = valuationSources?.[id as "trailingPe" | "forwardPe" | "pegRatio"];
      const provider = observation?.provenance;
      const providerLabel = provider?.providerId === "yahoo" ? "Yahoo Finance"
        : provider?.providerId === "tradingview" ? "Market data provider" : provider?.providerId;
      const basis = observation?.basis === "ttm" ? "TTM" : observation?.basis === "forward" ? (ja ? "予想" : "Forward") : (ja ? "成長率調整" : "Growth-adjusted");
      const calculation = observation?.calculation;
      const calculationHelp = calculation?.growthBasis === "diluted-eps-ttm-yoy"
        ? (ja ? "株価 ÷ 希薄化後EPS（TTM）÷ 同EPSの前年比成長率（%）。将来5年の成長予想は使用しません。" : "Market data provider price / diluted EPS TTM / its year-over-year growth in percent. Does not use five-year forecast growth.")
        : calculation?.earningsPeriod === "NTM" ? (ja ? "株価 ÷ 今後12か月の予想EPS。" : "Market data provider price / next-twelve-month estimated EPS.")
        : calculation ? (ja ? "株価 ÷ 直近12か月の希薄化後EPS。" : "Market data provider price / trailing-twelve-month diluted EPS.") : undefined;
      const calculationLabel = calculation?.growthBasis === "diluted-eps-ttm-yoy" ? (ja ? "TTM・前年比から計算" : "Calculated: TTM YoY")
        : calculation?.earningsPeriod === "NTM" ? (ja ? "NTMから計算" : "Calculated: NTM") : (ja ? "TTMから計算" : "Calculated: TTM");
      return <div key={id}><dt><abbr tabIndex={0} title={calculationHelp ?? (ja ? jpHelp : enHelp)}>{ja ? jp : en}</abbr>{provider && <small className="valuation-source" title={calculationHelp ?? provider.asOf}>{provider.sourceUrl ? <a href={provider.sourceUrl} target="_blank" rel="noreferrer">{providerLabel}</a> : providerLabel} · {calculation ? calculationLabel : basis}{observation?.status === "not_reported" ? (ja ? " · 公開値なし" : " · Not reported") : ""}</small>}</dt><dd className={metric?.tone === "negative" ? "negative-text" : undefined}>{metric?.value ?? "—"}</dd></div>;
    })}</dl></section>)}</div>
    {metrics.some(metric => ["fundamentals.trailingPe", "fundamentals.forwardPe", "fundamentals.pegRatio"].includes(metric.id) && metric.value.startsWith("-")) && <p className="financial-research-caption">{ja ? "負のPER・PEGは、利益や成長率がマイナスの場合があります。正の倍率と同じ基準で割安さを比較できません。出典により利益の集計方法や予想期間が異なります。" : "Negative P/E or PEG can reflect negative earnings or growth and is not comparable to positive valuation multiples. Earnings definitions and forecast periods differ by source."}</p>}
  </section>;
}
