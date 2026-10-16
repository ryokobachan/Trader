"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowClockwise, Database, DownloadSimple } from "@phosphor-icons/react";
import { useI18n } from "../../platform/i18n";
import "./DataAccessLayout.css";
import "./DataAccessView.css";

type Definition = {
  id: string; description: string; source: string; history: string; category: string;
  subject: string; timeShape: string; backtest: string; notes: string[];
  parameters: Record<string, { type: string; required?: boolean; description: string; values?: string[]; min?: number; max?: number }>;
  metadataPaths?: { data?: string[]; provenance?: string[]; coverage?: string[]; warnings?: string[] };
};
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const LABELS: Record<string, string> = {
  bars: "株価OHLCV", technicals: "TA-Lib指標", financials: "財務履歴", earnings: "決算実績・予想", "corporate-actions": "配当・株式分割",
  "analyst-ratings": "アナリスト評価変更", "options-history": "個別オプション履歴", "sec-filings": "SEC提出書類", "sec-facts": "SEC財務ファクト", "sec-insiders": "内部者売買",
  "finra-short-volume": "日次空売り出来高", fred: "マクロ指標", usaspending: "米政府契約", news: "企業ニュース",
  "institutional-filings": "13F提出履歴", "institutional-holdings": "13F保有明細", "institutional-managers": "機関投資家",
  "x-posts": "X投稿履歴", "x-mentions": "X銘柄言及", "x-mention-outcomes": "X言及後の成績", "x-author-scores": "X投稿者評価", "x-author-strategies": "X追随戦略の成績", "x-accounts": "Xアカウント", "x-prices": "X分析用の保存株価",
  "strategy-list": "戦略一覧", strategy: "戦略詳細", "strategy-transactions": "戦略の売買履歴", "strategy-performance": "戦略成績", "strategy-equity": "資産曲線", "strategy-holdings": "保有・評価額",
};
const PARAM_LABELS: Record<string, string> = { symbol: "銘柄", institution: "機関CIK", account: "アカウント", period: "報告期間末", accession: "提出番号", from: "開始日", to: "終了日", date: "参照日", asOf: "利用可能情報の上限日時", limit: "1ページの件数", range: "期間", interval: "時間足", count: "本数", series: "指標ID", recipient: "受注企業名", indicators: "指標名（カンマ区切り）", parameters: "指標パラメータJSON", id: "戦略ID", "strategy-id": "戦略ID", strategy: "戦略ID", source: "取得元", contract: "契約ID", expiration: "満期日", side: "コール／プット", strike: "権利行使価格", fresh: "再取得", cik: "企業CIK" };
const SUBJECTS: Record<string, string> = { symbol: "銘柄", macro: "マクロ", "option-contract": "契約", institution: "機関投資家", account: "アカウント", strategy: "戦略", system: "システム" };
const SUITABILITY: Record<string, string> = { usable: "バックテスト入力可", conditional: "バックテストは条件付き", "analysis-only": "過去分析用", "result-only": "結果比較用", "not-applicable": "入力対象外" };
function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => record(current) ? current[key] : undefined, value);
}
function rowCollections(value: unknown, path = "", depth = 0): Record<string, Json[]> {
  if (Array.isArray(value) && value.every(record)) return { [path || "rows"]: value };
  if (!record(value) || depth > 3) return {};
  return Object.assign({}, ...Object.entries(value).slice(0, 60).map(([key, item]) => rowCollections(item, path ? `${path}.${key}` : key, depth + 1)));
}
function printable(value: unknown): string {
  return value === undefined || value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
}
const quoteShell = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function DatasetPanel({ dataset, onOpenChart }: { dataset: Definition; onOpenChart: (symbol: string) => void }) {
  const { locale } = useI18n(); const ja = locale === "ja";
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(dataset.parameters.symbol?.required ? { symbol: "AAPL" } : {}), ...(dataset.parameters.limit ? { limit: "50" } : {}) }));
  const [response, setResponse] = useState<Json | null>(null);
  const [requested, setRequested] = useState<URLSearchParams | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [tablePath, setTablePath] = useState("");
  const [copied, setCopied] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value.trim()));
  const command = `trader data get ${dataset.id}${[...params].map(([key, value]) => ` --${key}=${quoteShell(value)}`).join("")}`;
  const url = `/api/v1/data/${dataset.id}${params.size ? `?${params}` : ""}`;
  async function load(query: URLSearchParams) {
    requestRef.current?.abort(); const controller = new AbortController(); requestRef.current = controller;
    setBusy(true); setError(""); setResponse(null); setRequested(query); setTablePath("");
    try {
      const reply = await fetch(`/api/v1/data/${dataset.id}?${query}`, { signal: controller.signal, cache: "no-store" });
      const data: unknown = await reply.json();
      if (!reply.ok || !record(data) || data.error) throw new Error(record(data) && record(data.error) && typeof data.error.message === "string" ? data.error.message : (ja ? "取得できませんでした。" : "Could not retrieve data."));
      if (!controller.signal.aborted) setResponse(data);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Request failed"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void load(params); }
  function download() {
    if (!response) return;
    const target = URL.createObjectURL(new Blob([JSON.stringify(response, null, 2) + "\n"], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = target; anchor.download = `trader-${dataset.id}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(target), 1000);
  }
  const collections = rowCollections(response);
  const preferred = dataset.metadataPaths?.data?.find(path => collections[path]);
  const selectedPath = tablePath in collections ? tablePath : preferred ?? Object.keys(collections)[0] ?? "";
  const rows = collections[selectedPath] ?? [];
  const columns = [...new Set(rows.slice(0, 100).flatMap(row => Object.keys(row)))].slice(0, 14);
  const pagination = response && record(response.pagination) ? response.pagination : null;
  const nextCursor = pagination && typeof pagination.nextCursor === "string" ? pagination.nextCursor : null;
  const metadata = response ? [...new Set(["coverage", "provenance", "notes", "warnings", "dataMode", ...(dataset.metadataPaths?.coverage ?? []), ...(dataset.metadataPaths?.warnings ?? []), ...(dataset.metadataPaths?.provenance ?? [])])].map(path => ({ path, value: at(response, path) })).filter(item => item.value !== undefined) : [];
  return <article className="direct-source-panel data-access-panel">
    <header className="direct-source-heading"><div><h2>{ja ? LABELS[dataset.id] ?? dataset.id : dataset.id}</h2><p>{dataset.description}</p><p>{dataset.source}</p></div></header>
    <div className="data-access-tags"><span>{ja ? SUBJECTS[dataset.subject] ?? dataset.subject : dataset.subject}</span><span>{ja ? SUITABILITY[dataset.backtest] ?? dataset.backtest : dataset.backtest}</span></div>
    <p className="direct-source-hint">{dataset.history}</p>
    <form className="direct-source-form" onSubmit={submit}>
      {Object.entries(dataset.parameters).filter(([key]) => key !== "cursor").map(([key, rule]) => <label key={key} title={rule.description}>{ja ? PARAM_LABELS[key] ?? key : key}{rule.required ? " *" : ""}
        {rule.type === "choice" || rule.type === "flag" ? <select aria-label={ja ? PARAM_LABELS[key] ?? key : key} value={values[key] ?? ""} required={rule.required} onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))}><option value="">{ja ? "既定値" : "Default"}</option>{(rule.values ?? ["1"]).map(value => <option key={value} value={value}>{value}</option>)}</select>
          : <input aria-label={ja ? PARAM_LABELS[key] ?? key : key} type={rule.type === "date" ? "date" : rule.type === "integer" ? "number" : "text"} min={rule.min} max={rule.max} required={rule.required} value={values[key] ?? ""} onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))} />}
      </label>)}
      <button className="direct-source-fetch" disabled={busy}><ArrowClockwise size={16} className={busy ? "is-spinning" : undefined} />{ja ? busy ? "取得中…" : "データを取得" : busy ? "Loading…" : "Get data"}</button>
    </form>
    <details className="data-access-integration"><summary>{ja ? "CLI・他アプリから取得" : "Use from CLI or another app"}</summary><code>{command}</code><button type="button" onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => setCopied(false))}>{ja ? copied ? "コピー済み" : "コマンドをコピー" : copied ? "Copied" : "Copy command"}</button><a href={url} target="_blank" rel="noreferrer">HTTP JSON</a><a href="/api/v1/data/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a></details>
    <ul className="direct-source-notes">{dataset.notes.map(note => <li key={note}>{note}</li>)}</ul>
    <div aria-live="polite" aria-busy={busy}>
      {error && <p className="direct-source-error" role="alert">{error}</p>}
      {response && <><div className="direct-source-result-meta"><strong>{rows.length}{ja ? "行" : " rows"}</strong><button type="button" onClick={download}><DownloadSimple size={15} />JSON</button></div>
        {metadata.length > 0 && <details className="data-access-metadata" open><summary>{ja ? "取得範囲・公開版・注意点" : "Coverage, publication and notes"}</summary>{metadata.map(item => <div key={item.path}><strong>{item.path}</strong><pre>{JSON.stringify(item.value, null, 2)}</pre></div>)}</details>}
        {Object.keys(collections).length > 1 && <label className="data-access-collection">{ja ? "表示するデータ" : "Data table"}<select value={selectedPath} onChange={event => setTablePath(event.target.value)}>{Object.keys(collections).map(path => <option key={path} value={path}>{path} ({collections[path].length})</option>)}</select></label>}
        {rows.length > 0 && <div className="midas-table-shell direct-source-table"><table className="midas-data-table"><thead><tr>{columns.map(key => <th key={key}>{key}</th>)}</tr></thead><tbody>{rows.slice(0, 100).map((row, index) => <tr key={index}>{columns.map(key => <td key={key} title={printable(row[key])}>{["symbol", "ticker"].includes(key) && typeof row[key] === "string" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(row[key] as string) ? <button onClick={() => onOpenChart(row[key] as string)}>{String(row[key])}</button> : printable(row[key])}</td>)}</tr>)}</tbody></table></div>}
        {!rows.length && <p className="direct-source-hint">{ja ? nextCursor ? "この走査範囲に一致する行はありません。次のページで続けられます。" : "表形式の行はありません。JSON全体で応答を確認できます。" : nextCursor ? "No matching rows in this scan window. Continue with the next page." : "No tabular rows. Inspect the complete JSON below."}</p>}
        {rows.length > 100 && <p>{ja ? "画面は先頭100行を表示。JSONには取得した全行を含みます。" : "Showing the first 100 rows; JSON includes all returned rows."}</p>}
        {nextCursor && <button className="direct-source-fetch" disabled={busy} onClick={() => { const next = new URLSearchParams(requested ?? undefined); next.set("cursor", nextCursor); void load(next); }}>{ja ? "次のページ" : "Next page"}</button>}
        <details className="data-access-metadata"><summary>{ja ? "JSON全体" : "Complete JSON"}</summary><pre>{JSON.stringify(response, null, 2)}</pre></details>
      </>}
    </div>
  </article>;
}

export function DataAccessView({ scope = "all", onOpenChart }: { scope?: "all" | "institutional" | "x"; onOpenChart: (symbol: string) => void }) {
  const { locale } = useI18n(); const ja = locale === "ja";
  const [catalog, setCatalog] = useState<Definition[]>([]); const [error, setError] = useState(false); const [retry, setRetry] = useState(0);
  const [category, setCategory] = useState(scope === "all" ? "input" : ""); const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(scope === "institutional" ? "institutional-filings" : scope === "x" ? "x-mentions" : "bars");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/data", { signal: controller.signal, cache: "no-store" }).then(async response => {
      const value: unknown = await response.json();
      if (!response.ok || !record(value) || !Array.isArray(value.datasets)) throw new Error("catalog");
      if (!controller.signal.aborted) { setCatalog(value.datasets as Definition[]); setError(false); }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [retry]);
  const datasets = catalog.filter(item => (scope === "all" || item.id.startsWith(scope === "x" ? "x-" : "institutional-")) && (!category || item.category === category) && `${item.id} ${item.description} ${LABELS[item.id] ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const dataset = datasets.find(item => item.id === selected) ?? datasets[0];
  const title = scope === "institutional" ? ja ? "機関投資家・13F" : "Institutions · 13F" : scope === "x" ? ja ? "X投稿・分析データ" : "X posts and analysis" : ja ? "データ" : "Data";
  return <section className="midas-research-shell direct-sources-shell data-access-shell"><div className="midas-research-scroll">
    <header className="midas-page-header"><div className="midas-page-title"><Database size={24} /><div><h1>{title}</h1><p>{ja ? "バックテストの入力と分析結果を分けて探し、同じ取得口を画面・CLI・他アプリから利用できます。" : "Find backtest inputs and analysis results through one interface for the app, CLI and other clients."}</p></div></div></header>
    <div className="data-access-filters"><label>{ja ? "用途" : "Purpose"}<select value={category} onChange={event => setCategory(event.target.value)}>{[["", "すべて", "All"], ["input", "入力データ", "Inputs"], ["result", "結果・比較", "Results"], ["snapshot", "現在値", "Snapshots"], ["metadata", "定義・設定", "Definitions"]].map(([value, label, english]) => <option key={value} value={value}>{ja ? label : english}</option>)}</select></label><label>{ja ? "データを検索" : "Search datasets"}<input value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    {error ? <p role="alert">{ja ? "データ一覧を取得できませんでした。" : "Could not load the catalog."}<button onClick={() => setRetry(value => value + 1)}>{ja ? "再試行" : "Retry"}</button></p> : !catalog.length ? <p role="status">{ja ? "一覧を読み込み中…" : "Loading catalog…"}</p> : <div className="direct-source-workspace"><nav className="direct-source-list" aria-label={ja ? "データを選択" : "Select dataset"}>{datasets.map(item => <button key={item.id} aria-current={item.id === dataset?.id ? "true" : undefined} onClick={() => setSelected(item.id)}><span>{ja ? LABELS[item.id] ?? item.id : item.id}</span><small>{item.id}</small></button>)}</nav>{dataset ? <DatasetPanel key={dataset.id} dataset={dataset} onOpenChart={onOpenChart} /> : <p>{ja ? "該当するデータはありません。" : "No matching datasets."}</p>}</div>}
  </div></section>;
}
