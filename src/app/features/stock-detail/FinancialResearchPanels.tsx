"use client";

import { useId, useState, type CSSProperties } from "react";
import type {
  CompanyNewsItem,
  CompanyResearch,
  DataProvenance,
  FinancialStatementPeriod,
  FundamentalFiscalForecast,
} from "../../platform/provider-contracts";
import { useI18n } from "../../platform/i18n";
import { OptionsChainPanel } from "./OptionsChainPanel";

const METRICS = [
  ["revenue", "売上高", "Revenue"],
  ["grossProfit", "粗利益", "Gross profit"],
  ["operatingIncome", "営業利益", "Operating income"],
  ["ebitda", "EBITDA", "EBITDA"],
  ["netIncome", "純利益", "Net income"],
  ["eps", "希薄化後EPS", "Diluted EPS"],
  ["researchAndDevelopment", "研究開発費", "Research & development"],
  ["sellingGeneralAndAdministrative", "販売費・一般管理費", "Selling, general & administrative"],
  ["totalAssets", "総資産", "Total assets"],
  ["totalLiabilities", "総負債", "Total liabilities"],
  ["totalDebt", "有利子負債", "Total debt"],
  ["netDebt", "純有利子負債", "Net debt"],
  ["shareholdersEquity", "株主資本", "Shareholders’ equity"],
  ["cashAndShortTermInvestments", "現金・短期投資", "Cash & short-term investments"],
  ["operatingCashFlow", "営業CF", "Operating cash flow"],
  ["capitalExpenditure", "設備投資", "Capital expenditure"],
  ["freeCashFlow", "フリーCF", "Free cash flow"],
  ["investingCashFlow", "投資CF", "Investing cash flow"],
  ["financingCashFlow", "財務CF", "Financing cash flow"],
] as const;
type HistoryMetric = typeof METRICS[number][0];

const FINANCIAL_GROUPS = [
  { id: "income", ja: "損益計算書", en: "Income statement",
    descriptionJa: "売上と利益の大きさを比較し、事業の収益力を確認できます。",
    descriptionEn: "Compare sales and profits to understand business profitability.",
    metrics: ["revenue", "grossProfit", "operatingIncome", "ebitda", "netIncome", "eps", "researchAndDevelopment", "sellingGeneralAndAdministrative"],
    comparison: ["revenue", "operatingIncome", "netIncome"] },
  { id: "balance", ja: "貸借対照表", en: "Balance sheet",
    descriptionJa: "総資産・負債・株主資本を比較し、財務の構成を確認できます。",
    descriptionEn: "Compare assets, liabilities and equity to understand the financial structure.",
    metrics: ["totalAssets", "totalLiabilities", "totalDebt", "netDebt", "shareholdersEquity", "cashAndShortTermInvestments"],
    comparison: ["totalAssets", "totalLiabilities", "shareholdersEquity"] },
  { id: "cashflow", ja: "キャッシュフロー", en: "Cash flow",
    descriptionJa: "営業・投資・財務の3つのキャッシュフローを期間ごとに比較します。プラスは現金の流入、マイナスは流出です。",
    descriptionEn: "Compare operating, investing and financing cash flows in each period. Positive values are cash inflows; negative values are outflows.",
    metrics: ["operatingCashFlow", "investingCashFlow", "financingCashFlow", "freeCashFlow", "capitalExpenditure"],
    comparison: ["operatingCashFlow", "investingCashFlow", "financingCashFlow"] },
] as const satisfies readonly { id: string; ja: string; en: string; descriptionJa: string; descriptionEn: string; metrics: readonly HistoryMetric[]; comparison: readonly HistoryMetric[] }[];
type FinancialGroup = typeof FINANCIAL_GROUPS[number];
const SERIES_COLORS = ["#6285ff", "#d9aa59", "#b2b2ba"] as const;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function amount(value: number | undefined, ja: boolean, eps = false, compact = true) {
  if (!finite(value)) return "—";
  return new Intl.NumberFormat(ja ? "ja-JP" : "en-US", {
    style: "currency", currency: "USD", notation: eps || !compact ? "standard" : "compact",
    maximumFractionDigits: eps || !compact ? 2 : 1,
  }).format(value);
}

function ResearchSource({ provenance }: { provenance?: DataProvenance }) {
  const { locale } = useI18n();
  if (!provenance) return null;
  const label = provenance.providerId === "tradingview" ? "TradingView"
    : provenance.providerId === "yahoo" ? "Yahoo Finance"
    : provenance.providerId === "stockanalysis" ? "Stock Analysis"
    : provenance.providerId === "google-finance-earnings" ? "Google Finance" : provenance.providerId;
  return <small className="financial-research-source">{label} · {provenance.asOf.slice(0, 10)}{provenance.isStale ? (locale === "ja" ? " · 前回取得値" : " · Last available values") : ""}</small>;
}

/** Preserve missing observations as gaps, without converting them to zero. */
export function financialHistoryPoints(rows: readonly FinancialStatementPeriod[], metric: HistoryMetric) {
  return [...rows].sort((a, b) => (a.fiscalDateEnding ?? a.period).localeCompare(b.fiscalDateEnding ?? b.period))
    .map(row => ({ period: row.period, value: finite(row[metric]) ? row[metric]! : null }));
}

/** A positive, comparable prior value is required for a meaningful growth rate. */
export function financialYearOverYear(rows: readonly FinancialStatementPeriod[], current: FinancialStatementPeriod, metric: HistoryMetric) {
  // Explicit fiscal labels survive 52/53-week calendars and their changing end dates.
  const fiscalLabel = /^(19|20|21)\d{2}(?:-Q[1-4])?$/.test(current.period);
  const currentDate = fiscalLabel ? current.period : current.fiscalDateEnding ?? current.period;
  const year = currentDate.match(/\d{4}/)?.[0];
  if (!year) return null;
  const priorDate = currentDate.replace(year, String(Number(year) - 1));
  const previous = rows.find(row => (fiscalLabel ? row.period : row.fiscalDateEnding ?? row.period) === priorDate);
  const value = current[metric];
  const priorValue = previous?.[metric];
  if (!finite(value) || !finite(priorValue) || priorValue <= 0) return null;
  return (value - priorValue) / priorValue;
}

function metricLabel(metric: HistoryMetric, ja: boolean) {
  const entry = METRICS.find(([key]) => key === metric)!;
  return ja ? entry[1] : entry[2];
}

export function financialHistoryCsv(rows: readonly FinancialStatementPeriod[], basis: "annual" | "quarterly", metrics: readonly HistoryMetric[]) {
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return ["period,period_end,frequency,currency,metric,value,source,retrieved_at", ...rows.flatMap(row => metrics.map(metric => [row.period, row.fiscalDateEnding ?? "", basis, row.currency, metric, finite(row[metric]) ? row[metric] : "", row.provenance.providerId, row.provenance.ingestedAt].map(quote).join(",")))].join("\n");
}

function financialScale(values: readonly number[]) {
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const rawStep = (maximum - minimum || 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = ([1, 2, 5, 10].find(multiplier => multiplier * magnitude >= rawStep) ?? 10) * magnitude;
  const lower = Math.floor(minimum / step) * step;
  const upper = Math.ceil(maximum / step) * step || step;
  return { lower, upper, ticks: Array.from({ length: Math.round((upper - lower) / step) + 1 }, (_, index) => lower + index * step) };
}

export function FinancialHistoryPanel({ annual = [], quarterly = [], annualCashFlows = [] }: {
  annual?: readonly FinancialStatementPeriod[];
  quarterly?: readonly FinancialStatementPeriod[];
  annualCashFlows?: readonly FinancialStatementPeriod[];
}) {
  const { locale } = useI18n();
  const ja = locale === "ja";
  const chartId = useId();
  const [basis, setBasis] = useState<"annual" | "quarterly">("annual");
  const [selectedGroup, setSelectedGroup] = useState<FinancialGroup["id"]>("income");
  const [selectedMetric, setSelectedMetric] = useState<HistoryMetric | "comparison">("comparison");
  const [selectedCashFlowPeriod, setSelectedCashFlowPeriod] = useState<string>();
  const hasValues = (periods: readonly FinancialStatementPeriod[]) => periods.some(row => METRICS.some(([key]) => finite(row[key])));
  const hasAnnual = hasValues(annual) || hasValues(annualCashFlows);
  const hasQuarterly = hasValues(quarterly);
  const effectiveBasis = basis === "annual" && !hasAnnual ? "quarterly"
    : basis === "quarterly" && !hasQuarterly ? "annual" : basis;
  const baseRows = effectiveBasis === "annual" ? annual : quarterly;
  const cashRows = effectiveBasis === "annual" && hasValues(annualCashFlows) ? annualCashFlows : baseRows;
  const groups = FINANCIAL_GROUPS.filter(group => group.metrics.some(key => (group.id === "cashflow" ? cashRows : baseRows).some(row => finite(row[key]))));
  if (!groups.length) return null;
  const group = groups.find(candidate => candidate.id === selectedGroup) ?? groups[0];
  const rows = [...(group.id === "cashflow" ? cashRows : baseRows)]
    .sort((a, b) => (a.fiscalDateEnding ?? a.period).localeCompare(b.fiscalDateEnding ?? b.period));
  const available = (group.metrics as readonly HistoryMetric[]).filter(key => rows.some(row => finite(row[key])));
  const metric = selectedMetric !== "comparison" && available.includes(selectedMetric) ? selectedMetric : "comparison";
  const primary = (group.comparison as readonly HistoryMetric[]).filter(key => available.includes(key));
  const fallback = available.filter(key => key !== "eps").slice(0, 3);
  // Keep the three cash-flow categories visible even when one is unavailable.
  // CapEx and FCF are supplemental measures, not replacements for investing or financing CF.
  const comparison = group.id === "cashflow" ? group.comparison as readonly HistoryMetric[] : primary.length ? primary : fallback.length ? fallback : [available[0]];
  const series = metric === "comparison" ? comparison : [metric];
  const cashFlowComparison = group.id === "cashflow" && metric === "comparison";
  const tableMetrics = group.id === "cashflow" ? [...comparison, ...available.filter(key => !comparison.includes(key))] : available;
  const visibleRows = rows.slice(effectiveBasis === "annual" ? -8 : -12);
  const latest = rows.at(-1)!;
  const summaryRow = cashFlowComparison ? visibleRows.find(row => row.period === selectedCashFlowPeriod) ?? latest : latest;
  const numbers = visibleRows.flatMap(row => series.flatMap(key => finite(row[key]) ? [row[key]!] : []));
  const { lower, upper, ticks } = financialScale(numbers);
  const y = (value: number) => 24 + (upper - value) / (upper - lower) * 210;
  const baseline = y(0);
  const step = 746 / visibleRows.length;
  const barWidth = Math.min(35, (step - 14) / series.length);
  const chartTitle = cashFlowComparison ? (ja ? "営業・投資・財務キャッシュフロー" : "Operating, investing & financing cash flow") : series.length === 1 ? metricLabel(series[0], ja) : (ja ? group.ja : group.en);
  const eps = series.length === 1 && series[0] === "eps";
  const source = latest.provenance;
  const growthFormat = new Intl.NumberFormat(ja ? "ja-JP" : "en-US", { style: "percent", maximumFractionDigits: 1, signDisplay: "always" });
  const caption = `${ja ? (effectiveBasis === "annual" ? "年次" : "四半期") : (effectiveBasis === "annual" ? "Annual" : "Quarterly")} · USD${eps ? (ja ? " / 株" : " / share") : ""} · ${visibleRows[0].period} – ${latest.period}`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([financialHistoryCsv(rows, effectiveBasis, tableMetrics)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${group.id}-${effectiveBasis}-financials.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="financial-research-card financial-history-panel" aria-label={ja ? "財務の推移" : "Financial history"}>
    <header><div><span className="eyebrow">FINANCIAL HISTORY</span><h2>{ja ? "財務の推移" : "Financial history"}</h2><ResearchSource provenance={source} /></div>
      <div className="financial-research-controls" role="group" aria-label={ja ? "会計期間" : "Reporting frequency"}>
        <button type="button" disabled={!hasAnnual} aria-pressed={effectiveBasis === "annual"} onClick={() => setBasis("annual")}>{ja ? "年次" : "Annual"}</button>
        <button type="button" disabled={!hasQuarterly} aria-pressed={effectiveBasis === "quarterly"} onClick={() => setBasis("quarterly")}>{ja ? "四半期" : "Quarterly"}</button>
      </div>
    </header>
    <div className="financial-research-controls financial-history-export"><button type="button" onClick={download}>{ja ? "この財務表をCSVで保存" : "Download this financial table as CSV"}</button></div>
    <div className="financial-statement-tabs" role="group" aria-label={ja ? "財務諸表" : "Financial statements"}>
      {FINANCIAL_GROUPS.map(candidate => <button key={candidate.id} type="button" disabled={!groups.includes(candidate)} aria-pressed={group.id === candidate.id} onClick={() => { setSelectedGroup(candidate.id); setSelectedMetric("comparison"); }}>{ja ? candidate.ja : candidate.en}</button>)}
    </div>
    <p className="financial-statement-description">{ja ? group.descriptionJa : group.descriptionEn}</p>
    {cashFlowComparison && <div className="financial-cashflow-period"><label>{ja ? "確認する期間" : "Inspect period"}<select aria-label={ja ? "キャッシュフローを確認する期間" : "Cash flow period to inspect"} value={summaryRow.period} onChange={event => setSelectedCashFlowPeriod(event.target.value)}>{[...visibleRows].reverse().map(row => <option value={row.period} key={row.period}>{row.period}</option>)}</select></label><span>{ja ? "グラフに触れるか、期間にフォーカスして3区分の値を確認できます。" : "Hover, tap or focus a period in the chart to inspect all three categories."}</span></div>}
    <div className={`financial-history-summary${cashFlowComparison ? " financial-cashflow-summary" : ""}`} aria-live={cashFlowComparison ? "polite" : undefined} aria-atomic={cashFlowComparison ? true : undefined}>
      {comparison.map((key, index) => {
        const growth = financialYearOverYear(rows, summaryRow, key);
        return <div className="financial-history-summary-item" key={key} style={{ "--series-color": SERIES_COLORS[index] } as CSSProperties}>
          <span>{metricLabel(key, ja)}</span><strong>{amount(summaryRow[key], ja, key === "eps")}</strong>
          <small>{summaryRow.period}{growth !== null ? ` · ${ja ? "前年同期比" : "YoY"} ${growthFormat.format(growth)}` : ""}</small>
        </div>;
      })}
    </div>
    <div className="financial-chart-heading">
      <div><h3>{chartTitle}</h3><p className="financial-research-caption">{caption}</p></div>
      <select aria-label={ja ? "表示する財務指標" : "Financial history metric"} value={metric} onChange={event => setSelectedMetric(event.target.value as HistoryMetric | "comparison")}>
        <option value="comparison">{group.id === "cashflow" ? (ja ? "営業・投資・財務CFを比較" : "Compare operating, investing & financing CF") : (ja ? "主要項目を比較" : "Compare key metrics")}</option>
        {available.map(key => <option value={key} key={key}>{metricLabel(key, ja)}</option>)}
      </select>
    </div>
    <div className="financial-chart-legend" aria-label={ja ? "グラフの凡例" : "Chart legend"}>
      {series.map((key, index) => <span key={key}>{cashFlowComparison ? <svg className="financial-cashflow-legend-key" viewBox="0 0 14 14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" fill={index === 0 ? SERIES_COLORS[index] : "none"} stroke={SERIES_COLORS[index]} strokeWidth="1.5" />{index === 2 && <path d="M1 6 L6 1 M1 12 L12 1 M6 13 L13 6" stroke={SERIES_COLORS[index]} strokeWidth="1" />}</svg> : <i style={{ background: SERIES_COLORS[index] }} aria-hidden="true" />}{metricLabel(key, ja)}</span>)}
    </div>
    {cashFlowComparison && !numbers.length && <p className="financial-research-caption" role="status">{ja ? "この期間の営業・投資・財務CFは未取得です。補足の指標は表示項目の選択欄と比較表で確認できます。" : "Operating, investing and financing CF are unavailable for these periods. Supplemental metrics remain available in the metric selector and comparison table."}</p>}
    <div className="financial-chart-scroll" role="region" aria-label={ja ? "財務比較グラフ（横スクロール可）" : "Financial comparison chart (scrollable)"} tabIndex={0}>
      <svg className="financial-history-chart financial-comparison-chart" viewBox="0 0 860 280" role={cashFlowComparison ? "group" : "img"} aria-labelledby={`${chartId}-title ${chartId}-description`}>
        <title id={`${chartId}-title`}>{`${chartTitle} ${visibleRows[0].period} – ${latest.period}`}</title>
        <desc id={`${chartId}-description`}>{cashFlowComparison ? (ja ? "会計期間ごとに営業・投資・財務CFの順に並べて比較。営業は塗り、投資は輪郭、財務は斜線で区別。ゼロより下は現金流出、×は未取得、ゼロ線上の短線は実測ゼロです。各期間にフォーカスすると上の数値が切り替わります。" : "Compare operating, investing and financing CF in that order within each fiscal period. Operations are filled, investing outlined and financing hatched. Cash outflows extend below zero. Crosses mean unavailable data; short marks on zero mean reported zero. Focus a period to update the values above.") : (ja ? "会計期間ごとの比較。ゼロより下はマイナス、未取得の値は棒を表示しません。数値は下の比較表で確認できます。" : "Comparison by fiscal period. Negative values extend below zero; unavailable values have no bar. Values appear in the table below.")}</desc>
        {cashFlowComparison && <defs><pattern id={`${chartId}-cashflow-hatch`} width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5" stroke={SERIES_COLORS[2]} strokeWidth="1" /></pattern></defs>}
        {ticks.map(tick => <g key={tick}>
          <line x1="94" x2="840" y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "var(--muted-2)" : "var(--line-soft)"} strokeDasharray={tick === 0 ? undefined : "3 5"} />
          <text x="84" y={y(tick) + 4} textAnchor="end">{amount(tick, ja, eps)}</text>
        </g>)}
        {visibleRows.map((row, index) => <g key={row.period} className={cashFlowComparison ? "financial-cashflow-chart-period" : undefined}
          tabIndex={cashFlowComparison ? 0 : undefined} role={cashFlowComparison ? "button" : undefined}
          aria-pressed={cashFlowComparison ? row.period === summaryRow.period : undefined}
          aria-label={cashFlowComparison ? `${row.period}: ${series.map(key => `${metricLabel(key, ja)} ${amount(row[key], ja)}`).join(" · ")}` : undefined}
          onFocus={cashFlowComparison ? () => setSelectedCashFlowPeriod(row.period) : undefined}
          onPointerEnter={cashFlowComparison ? event => { if (event.pointerType !== "touch") setSelectedCashFlowPeriod(row.period); } : undefined}
          onClick={cashFlowComparison ? () => setSelectedCashFlowPeriod(row.period) : undefined}
          onKeyDown={cashFlowComparison ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedCashFlowPeriod(row.period); } } : undefined}>
          {cashFlowComparison && <path className="financial-cashflow-hit-area" d={`M${94 + index * step} 24 h${step} v210 h${-step} Z`} />}
          {series.map((key, seriesIndex) => {
            const value = row[key];
            const barX = 94 + index * step + (step - series.length * barWidth) / 2 + seriesIndex * barWidth + 1;
            const width = Math.max(2, barWidth - 3);
            if (!finite(value)) return cashFlowComparison ? <text key={key} data-metric={key} data-missing="true" className="financial-cashflow-missing" x={barX + width / 2} y={baseline + 14} textAnchor="middle">×<title>{`${row.period} · ${metricLabel(key, ja)}: —`}</title></text> : null;
            if (cashFlowComparison && value === 0) return <line key={key} data-metric={key} data-zero="true" x1={barX} x2={barX + width} y1={baseline} y2={baseline} stroke={SERIES_COLORS[seriesIndex]} strokeWidth="2"><title>{`${row.period} · ${metricLabel(key, ja)}: ${amount(0, ja)}`}</title></line>;
            return <rect key={key} data-metric={key} data-negative={value < 0 || undefined}
              x={barX} y={Math.min(y(value), baseline)} width={width} height={Math.max(1, Math.abs(y(value) - baseline))}
              fill={cashFlowComparison && seriesIndex === 1 ? "none" : cashFlowComparison && seriesIndex === 2 ? `url(#${chartId}-cashflow-hatch)` : SERIES_COLORS[seriesIndex]}
              fillOpacity={cashFlowComparison ? 0.9 : value < 0 ? 0.28 : 0.9} stroke={SERIES_COLORS[seriesIndex]} strokeWidth={cashFlowComparison ? "1.5" : "1"} rx="1">
              <title>{`${row.period} · ${metricLabel(key, ja)}: ${amount(value, ja, key === "eps")}`}</title>
            </rect>;
          })}
          <text x={94 + (index + 0.5) * step} y="258" textAnchor="middle">{effectiveBasis === "quarterly" && /^\d{4}-\d{2}-\d{2}$/.test(row.period) ? row.period.slice(0, 7) : row.period}</text>
        </g>)}
      </svg>
    </div>
    <p className="financial-research-caption financial-chart-note">{cashFlowComparison ? (ja ? "マイナスはゼロ線より下に表示。×・— は未取得、ゼロ線上の短線は実測ゼロです。" : "Negative values extend below zero. × and — mean unavailable; a short mark on zero means a reported zero.") : (ja ? "マイナスはゼロ線より下に表示。未取得は「—」。" : "Negative values extend below zero. Unavailable values are shown as —.")}{group.id === "cashflow" ? (ja ? " 設備投資の符号は提供元の表記に従います。" : " Capital expenditure retains the source sign convention.") : ""}</p>
    <p className="financial-research-caption">{ja ? "過去の財務値は現在取得できる版です。表示日付は会計期間末で、公表日ではありません。当時の情報だけを使うバックテストでは、提出日時と修正前の開示も確認する必要があります。" : "Historical statements are the versions available today. Dates are reporting period ends, not release dates. A point-in-time backtest also needs filing timestamps and original disclosure versions."}</p>
    {group.id === "cashflow" && <p className="financial-cashflow-definition">{ja ? "営業CFは本業、投資CFは設備・資産などの取得や売却、財務CFは借入・返済や株主との資金のやり取りです。3区分の合計は、為替換算などの影響で現金残高の増減と一致しない場合があります。フリーCF・設備投資は個別表示と下の比較表で確認できます。" : "Operating CF reflects business operations; investing CF includes purchases and sales of assets; financing CF covers borrowing, repayments and shareholder funding or distributions. Exchange-rate effects and other adjustments can make the three-category total differ from the change in cash balances. Free CF and capital expenditure remain in the metric selector and table below."}</p>}
    <div className="financial-comparison-table-heading"><h3>{ja ? "期間別の比較" : "Compare periods"}</h3><span>{ja ? "新しい会計期間から表示 · 金額はUSD、EPSはUSD / 株" : "Newest periods first · USD, except EPS in USD / share"}</span></div>
    <div className="financial-research-table-wrap financial-comparison-table" role="region" aria-label={ja ? "期間別の財務比較表（横スクロール可）" : "Financial comparison table (scrollable)"} tabIndex={0}>
      <table><caption className="financial-visually-hidden">{ja ? group.ja : group.en} · USD · {rows[0].period} – {latest.period}</caption><thead><tr><th scope="col">{ja ? "項目" : "Metric"}</th>{[...rows].reverse().map(row => <th scope="col" key={row.period}>{row.period}{row.fiscalDateEnding && row.fiscalDateEnding !== row.period && <small>{row.fiscalDateEnding}</small>}</th>)}</tr></thead><tbody>
        {tableMetrics.map(key => <tr key={key}><th scope="row">{metricLabel(key, ja)}</th>{[...rows].reverse().map(row => <td title={finite(row[key]) ? amount(row[key], ja, key === "eps", false) : undefined} className={finite(row[key]) && row[key]! < 0 ? "financial-negative-value" : undefined} key={row.period}>{amount(row[key], ja, key === "eps")}</td>)}</tr>)}
      </tbody></table>
    </div>
  </section>;
}

export function FiscalForecastPanel({ forecasts = [] }: { forecasts?: readonly FundamentalFiscalForecast[] }) {
  const { locale } = useI18n();
  const ja = locale === "ja";
  const [view, setView] = useState<"future" | "reported">("future");
  if (!forecasts.length) return null;
  const rows = forecasts.filter(row => row.reported === (view === "reported"))
    .sort((a, b) => view === "future" ? a.period.localeCompare(b.period) : b.period.localeCompare(a.period));
  return <section className="financial-research-card" aria-label={ja ? "会計期間別の市場予想" : "Fiscal period estimates"}>
    <header><div><span className="eyebrow">CONSENSUS ESTIMATES</span><h2>{ja ? "会計期間別の市場予想" : "Fiscal period estimates"}</h2><ResearchSource provenance={forecasts[0].provenance} /></div>
      <div className="financial-research-controls" role="group" aria-label={ja ? "予想の表示期間" : "Estimate periods"}>
        <button type="button" aria-pressed={view === "future"} onClick={() => setView("future")}>{ja ? "今後の予想" : "Upcoming"}</button>
        <button type="button" aria-pressed={view === "reported"} onClick={() => setView("reported")}>{ja ? "報告済みの実績比較" : "Reported results"}</button>
      </div>
    </header>
    <p className="financial-research-caption">{ja ? "対象の会計期間を表示しています。決算発表日は下の決算実績で確認できます。" : "Periods refer to fiscal quarters. Release dates are shown in reported earnings below."}</p>
    {rows.length ? <div className="financial-research-table-wrap"><table><thead><tr><th>{ja ? "会計期間" : "Fiscal period"}</th><th>{ja ? "EPS予想" : "EPS estimate"}</th>{view === "reported" && <th>{ja ? "EPS実績" : "EPS actual"}</th>}<th>{ja ? "売上高予想" : "Revenue estimate"}</th>{view === "reported" && <th>{ja ? "売上高実績" : "Revenue actual"}</th>}</tr></thead><tbody>
      {rows.map(row => <tr key={row.period}><th>{row.period}</th><td>{amount(row.epsEstimate, ja, true)}</td>{view === "reported" && <td>{amount(row.epsActual, ja, true)}</td>}<td>{amount(row.revenueEstimate, ja)}</td>{view === "reported" && <td>{amount(row.revenueActual, ja)}</td>}</tr>)}
    </tbody></table></div> : <p className="financial-research-caption">{ja ? "この期間のデータはありません。" : "No data for these periods."}</p>}
  </section>;
}

type ResearchPanelProps = { research?: CompanyResearch | null };
type OwnershipOptionsProps = ResearchPanelProps & { symbol?: string; exchange?: string };

export function tradingViewOptionsUrl(symbol?: string, exchange?: string, ja = false) {
  const exchanges: Record<string, string> = { XNAS: "NASDAQ", NASDAQ: "NASDAQ", XNYS: "NYSE", NYSE: "NYSE", XASE: "AMEX", AMEX: "AMEX", ARCX: "AMEX", NYSEARCA: "AMEX", BATS: "BATS" };
  const venue = exchange ? exchanges[exchange.toUpperCase()] : undefined;
  if (!symbol || !venue || !/^[A-Z0-9.^-]+$/i.test(symbol)) return undefined;
  return `https://${ja ? "jp" : "www"}.tradingview.com/symbols/${venue}-${encodeURIComponent(symbol.toUpperCase())}/options-chain/`;
}

export function OwnershipOptionsPanel({ research, symbol, exchange }: OwnershipOptionsProps) {
  const { locale } = useI18n();
  const ja = locale === "ja";
  const ownership = research?.ownership;
  const percent = (value: number) => new Intl.NumberFormat(ja ? "ja-JP" : "en-US", { style: "percent", maximumFractionDigits: 2 }).format(value);
  const number = (value: number) => new Intl.NumberFormat(ja ? "ja-JP" : "en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
  const metrics = ownership ? [
    [ja ? "内部者保有比率" : "Insider ownership", ownership.insiderOwnership, percent],
    [ja ? "機関保有比率" : "Institutional ownership", ownership.institutionalOwnership, percent],
    [ja ? "空売り残高" : "Shares short", ownership.sharesShort, number],
    [ja ? "前月の空売り残高" : "Shares short, prior month", ownership.sharesShortPriorMonth, number],
    [ja ? "浮動株に対する空売り比率" : "Short % of float", ownership.shortFloatRatio, percent],
    [ja ? "発行済株式に対する空売り比率" : "Short % of shares", ownership.shortOutstandingRatio, percent],
    [ja ? "買い戻し所要日数" : "Days to cover", ownership.shortRatio, (v: number) => `${v.toFixed(2)} ${ja ? "日" : "days"}`],
  ] as const : [];
  const instrumentParts = research?.instrumentId.split(":");
  const optionsUrl = tradingViewOptionsUrl(symbol ?? instrumentParts?.[2], exchange ?? instrumentParts?.[1], ja);
  return <div className="financial-research-stack">
    <section className="financial-research-card">
      <header><div><span className="eyebrow">OWNERSHIP & SHORT INTEREST</span><h2>{ja ? "保有比率・空売り残高" : "Ownership & short interest"}</h2><ResearchSource provenance={ownership?.provenance} /></div></header>
      {metrics.some(([, value]) => finite(value)) ? <div className="detail-metric-grid">{metrics.map(([label, value, format]) => finite(value) && <div className="detail-metric" key={label}><span>{label}</span><b>{format(value)}</b></div>)}</div> : <p className="financial-research-caption">{ja ? "現在このデータを取得できません。" : "This data is currently unavailable."}</p>}
      {ownership?.shortInterestDate && <p className="financial-research-caption">{ja ? "空売り残高の基準日" : "Short interest as of"}: {ownership.shortInterestDate}</p>}
      {research?.coverage.ownership === "unavailable" && ownership && <p className="financial-research-caption">{ja ? "更新に失敗したため、前回取得した値を表示しています。" : "Refresh failed; showing the last available values."}</p>}
    </section>
    {symbol || instrumentParts?.[2] ? <OptionsChainPanel key={symbol ?? instrumentParts?.[2]} symbol={(symbol ?? instrumentParts?.[2])!} externalUrl={optionsUrl} />
      : <section className="financial-research-card"><h2>{ja ? "オプション" : "Options"}</h2><p className="financial-research-caption">{ja ? "銘柄を選ぶとオプション価格を表示します。" : "Select a symbol to view option prices."}</p></section>}
  </div>;
}

export function DividendsPanel({ research }: ResearchPanelProps) {
  const { locale } = useI18n();
  const ja = locale === "ja";
  const [actionType, setActionType] = useState<"all" | "dividend" | "split">("all");
  const actions = [...(research?.corporateActions ?? [])].filter(action => actionType === "all" || action.type === actionType).sort((a, b) => b.date.localeCompare(a.date));
  return <section className="financial-research-card" aria-label={ja ? "配当・株式分割" : "Dividends & stock splits"}>
    <header><div><span className="eyebrow">CORPORATE ACTIONS</span><h2>{ja ? "配当・株式分割" : "Dividends & stock splits"}</h2><small className="financial-research-caption">{ja ? "過去5年 · 配当は権利落ち日" : "Past 5 years · dividends use ex-dividend dates"}</small></div>
      <select aria-label={ja ? "企業イベントの種類" : "Corporate action type"} value={actionType} onChange={event => setActionType(event.target.value as typeof actionType)}><option value="all">{ja ? "すべて" : "All"}</option><option value="dividend">{ja ? "配当" : "Dividends"}</option><option value="split">{ja ? "株式分割" : "Splits"}</option></select>
    </header>
    {actions.length ? <div className="financial-research-table-wrap"><table><thead><tr><th scope="col">{ja ? "日付" : "Date"}</th><th scope="col">{ja ? "種類" : "Type"}</th><th scope="col">{ja ? "内容" : "Details"}</th></tr></thead><tbody>{actions.map(action => <tr key={action.id}><th scope="row">{action.date}</th><td>{action.type === "dividend" ? (ja ? "配当" : "Dividend") : (ja ? "株式分割" : "Stock split")}</td><td>{action.type === "dividend" ? `${amount(action.amount, ja, true)} ${ja ? "/ 株" : "/ share"}` : finite(action.numerator) && finite(action.denominator) && action.denominator > 0 ? `${action.numerator} : ${action.denominator}` : "—"}</td></tr>)}</tbody></table></div> : <p className="financial-research-caption">{research?.coverage.corporateActions === "available" ? (ja ? "この期間に該当するイベントはありません。" : "No matching events in this period.") : (ja ? "現在このデータを取得できません。" : "This data is currently unavailable.")}</p>}
    <ResearchSource provenance={actions[0]?.provenance ?? research?.provenance} />
    {research?.coverage.corporateActions === "unavailable" && actions.length > 0 && <p className="financial-research-caption">{ja ? "更新に失敗したため、前回取得したイベントを表示しています。" : "Refresh failed; showing the last available events."}</p>}
  </section>;
}

export function CompanyNewsPanel({ news = [] }: { news?: readonly CompanyNewsItem[] }) {
  const { locale } = useI18n();
  const ja = locale === "ja";
  return <section className="financial-research-card" aria-label={ja ? "企業ニュース" : "Company news"}>
    <header><div><span className="eyebrow">COMPANY NEWS</span><h2>{ja ? "企業ニュース" : "Company news"}</h2></div></header>
    {news.length ? <ul className="financial-research-news">{[...news].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 20).map(item => <li key={item.id}><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a><small>{item.publisher} · {item.publishedAt.slice(0, 10)}</small></li>)}</ul> : <p className="financial-research-caption">{ja ? "表示できるニュースはありません。" : "No news is available."}</p>}
  </section>;
}

/** Kept for existing consumers; the stock-detail tabs use the focused panels. */
export function CompanyResearchPanel({ research, news = [] }: ResearchPanelProps & { news?: readonly CompanyNewsItem[] }) {
  return <div className="financial-research-stack"><OwnershipOptionsPanel research={research} /><DividendsPanel research={research} /><CompanyNewsPanel news={news} /></div>;
}
