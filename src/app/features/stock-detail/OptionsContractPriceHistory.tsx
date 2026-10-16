"use client";

import { LoadingIndicator } from "../../components/LoadingIndicator";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { OptionPriceHistoryBar, OptionsPriceHistory } from "@api/options/price-history.server";
import type { OptionsChainSnapshot } from "../../platform/options-contracts";

type HistorySource = "chartexchange" | "yahoo";
type HistoryMetric = "openInterest" | "close" | "volume";
const sourceNames = { chartexchange: "ChartExchange", yahoo: "Yahoo Finance" } as const;
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A plotting coordinate only; never exported or described as the source's observation time. */
export function optionHistoryDateAnchor(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN;
  const anchor = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(anchor) && new Date(anchor).toISOString().slice(0, 10) === date ? anchor : Number.NaN;
}

export function optionHistoryResponseMatches(value: OptionsPriceHistory, symbol: string, contractId: string, source: HistorySource) {
  return value?.symbol === symbol && value.contractId === contractId && value.source === sourceNames[source]
    && Array.isArray(value.items) && value.items.every(item => Number.isFinite(optionHistoryDateAnchor(item.date)));
}

/** Missing sessions are not zero observations. The comparison date must accompany this change. */
export function optionHistoryOpenInterestChange(items: readonly OptionPriceHistoryBar[], index: number): { value: number; previousDate: string } | null {
  const current = items[index];
  if (!current || !valid(current.openInterest)) return null;
  const previous = items.slice(0, index).findLast(item => valid(item.openInterest));
  return previous ? { value: current.openInterest - previous.openInterest!, previousDate: previous.date } : null;
}

export function optionHistoryCsv(history: OptionsPriceHistory) {
  const columns = ["symbol", "contract_id", "session_date", "timestamp", "open", "high", "low", "close", "volume", "currency", "timezone", "source", "retrieved_at", "open_interest", "open_interest_date_basis", "source_url", "requested_range", "source_as_of"];
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [columns.join(","), ...history.items.map(item => [history.symbol, history.contractId, item.date, item.time, item.open, item.high, item.low, item.close, item.volume, history.currency, history.timezone, history.source, history.fetchedAt, item.openInterest, history.openInterestDateBasis, history.sourceUrl, history.requestedRange, history.sourceAsOf].map(quote).join(","))].join("\n");
}

function downloadHistory(history: OptionsPriceHistory, format: "csv" | "json") {
  const contents = format === "csv" ? optionHistoryCsv(history) : JSON.stringify(history, null, 2);
  const url = URL.createObjectURL(new Blob([contents], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${history.contractId}-${history.source.replaceAll(" ", "-")}-daily.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// One source, one contract, one metric: daily position/price lines, daily volume bars.
// The calendar-date axis keeps date gaps; missing rows break lines and remain visible as ×.
export function OptionsContractHistoryData({ history, metric, ja }: { history: OptionsPriceHistory; metric: HistoryMetric; ja: boolean }) {
  const items = useMemo(() => [...history.items].sort((a, b) => a.date.localeCompare(b.date)), [history.items]);
  const [selected, setSelected] = useState<{ metric: HistoryMetric; date: string }>();
  const observed = items.filter(item => valid(item[metric]));
  const latestIndex = items.findLastIndex(item => valid(item[metric]));
  const selectedIndex = selected?.metric === metric ? items.findIndex(item => item.date === selected.date) : -1;
  const index = selectedIndex >= 0 ? selectedIndex : Math.max(0, latestIndex);
  const detail = items[index];
  const change = optionHistoryOpenInterestChange(items, index);
  const money = (value: number | undefined) => valid(value) ? `$${value.toLocaleString(ja ? "ja-JP" : "en-US", { maximumFractionDigits: 3 })}` : "—";
  const count = (value: number | undefined) => valid(value) ? value.toLocaleString(ja ? "ja-JP" : "en-US", { maximumFractionDigits: 0 }) : "—";
  const metricLabel = metric === "openInterest" ? ja ? "建玉" : "Open interest" : metric === "close" ? ja ? "オプション終値" : "Option close" : ja ? "出来高" : "Volume";
  const format = metric === "close" ? money : count;
  const maximum = Math.max(1, ...observed.map(item => item[metric]!)) * 1.1;
  const first = optionHistoryDateAnchor(items[0]?.date ?? ""), last = optionHistoryDateAnchor(items.at(-1)?.date ?? "");
  const x = (date: string) => first === last ? 395 : 70 + (optionHistoryDateAnchor(date) - first) / (last - first) * 650;
  const y = (value: number) => 224 - value / maximum * 188;
  const barWidth = Math.max(1, Math.min(14, 650 / Math.max(1, (last - first) / 86_400_000) * 0.7));
  const choose = (candidate: number) => {
    const item = items[Math.max(0, Math.min(items.length - 1, candidate))];
    if (item) setSelected({ metric, date: item.date });
  };
  const selectKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !items.length) return;
    const next = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
  };
  const sourceDateUnverified = history.openInterestDateBasis === "source_session_date_unverified";
  return <>
    <p className="options-data-note"><a className="options-education-link" href={history.sourceUrl} target="_blank" rel="noreferrer">{history.source} ↗</a> · {ja ? "全取得期間" : "Entire retrieved period"}: {history.coverage.firstDate ?? "—"} – {history.coverage.lastDate ?? "—"} · {items.length}{ja ? "日分" : " daily rows"}</p>
    <p className="options-history-chart-label"><strong>{metricLabel}</strong><span>{metric === "close" ? ja ? "USD / 1株相当" : "USD / share" : ja ? "契約数" : "Contracts"} · {ja ? "日次" : "Daily"} · {sourceDateUnverified ? ja ? "提供元の記載日" : "Source-labelled dates" : history.timezone}</span></p>
    {observed.length ? <div className="options-history-plot" tabIndex={0} role="group" aria-label={ja ? "過去データのグラフ。左右矢印キーで日付を選べます。" : "Historical option chart. Use left and right arrow keys to select a date."} onKeyDown={selectKeyboard}>
      <svg viewBox="0 0 760 272" role="img" aria-label={`${metricLabel} · ${items[0]?.date} – ${items.at(-1)?.date}`} onPointerMove={event => {
        if (event.pointerType === "touch") return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = (event.clientX - bounds.left) / bounds.width * 760;
        const nearest = items.reduce((best, item, candidate) => Math.abs(x(item.date) - position) < Math.abs(x(items[best].date) - position) ? candidate : best, 0);
        choose(nearest);
      }}>
        {[0, maximum / 2, maximum].map(value => <g key={value}><line x1="70" x2="720" y1={y(value)} y2={y(value)} className="options-history-grid" /><text x="62" y={y(value) + 4} textAnchor="end">{format(value)}</text></g>)}
        {detail && <line x1={x(detail.date)} x2={x(detail.date)} y1="30" y2="224" className="options-history-cursor" />}
        {items.map((item, itemIndex) => {
          const value = item[metric], previous = items[itemIndex - 1];
          return <g key={item.date} data-date={item.date}>{valid(value) ? <>
            {metric !== "volume" ? <>
              {previous && valid(previous[metric]) && <line x1={x(previous.date)} y1={y(previous[metric]!)} x2={x(item.date)} y2={y(value)} className="options-history-line" />}
              <circle cx={x(item.date)} cy={y(value)} r="3.5" className="options-history-point"><title>{`${item.date} · ${metricLabel}: ${format(value)}`}</title></circle>
            </> : <rect x={x(item.date) - barWidth / 2} y={y(value)} width={barWidth} height={Math.max(1, 224 - y(value))} className="options-history-volume"><title>{`${item.date} · ${count(value)}`}</title></rect>}
          </> : <text x={x(item.date)} y="240" textAnchor="middle">×</text>}</g>;
        })}
        <text x="70" y="264">{items[0]?.date}</text><text x="720" y="264" textAnchor="end">{items.at(-1)?.date}</text>
      </svg>
    </div> : <p className="options-data-note">{ja ? "この表示項目に有効な過去値がありません。" : "No valid historical values for this metric."}</p>}
    {detail && <div className="options-history-daily-readout">
      <label>{ja ? "日付" : "Date"}<select aria-label={ja ? "過去データの日付" : "Historical data date"} value={index} onChange={event => choose(Number(event.target.value))}>{items.map((item, i) => <option key={item.date} value={i}>{item.date}</option>)}</select></label>
      {history.source === "ChartExchange" && <>
        <span className="options-history-primary-value">{ja ? "建玉" : "Open interest"}<b>{count(detail.openInterest)}</b></span>
        <span>{ja ? "前回観測からの増減" : "Change since previous observation"}<b>{change ? `${change.value > 0 ? "+" : change.value < 0 ? "−" : ""}${count(Math.abs(change.value))}` : "—"}</b><small>{change ? `${ja ? "比較日" : "Compared with"}: ${change.previousDate}` : ja ? "比較できる観測値なし" : "No comparable observations"}</small></span>
      </>}
      <span>{ja ? "終値" : "Close"}<b>{money(detail.close)}</b></span><span>{ja ? "出来高" : "Volume"}<b>{count(detail.volume)}</b></span>
      <span>{ja ? "始値" : "Open"}<b>{money(detail.open)}</b></span><span>{ja ? "高値" : "High"}<b>{money(detail.high)}</b></span><span>{ja ? "安値" : "Low"}<b>{money(detail.low)}</b></span>
    </div>}
    <div className="options-history-exports"><button type="button" onClick={() => downloadHistory(history, "csv")}>{ja ? "日次データをCSVで保存" : "Download daily CSV"}</button><button type="button" onClick={() => downloadHistory(history, "json")}>JSON</button></div>
    <p className="options-data-note">{ja ? "—・×は未取得です。0とは区別し、欠損を推定で埋めていません。株価ではなく、このオプション契約の価格です。日次データだけでは個々の取引の買い・売りや新規建ては判別できません。" : "— and × mean unavailable, distinct from zero. Missing values are not estimated. These are option contract prices, not stock prices. Daily data cannot identify individual trade direction or opening trades."}</p>
    <p className="options-data-note">{history.source === "ChartExchange" ? ja ? "建玉は提供元の記載日に合わせています。どの時点の残高か・公表時点は未確認のため、当日に知り得た数値としてのバックテストには使えません。IV・Greeks・過去の全チェーンはこの履歴に含まれません。" : "Open interest retains the source's date labels. Its balance date and publication time are unverified; it is not point-in-time backtest data. IV, Greeks, and complete historical chains are not included." : ja ? "Yahoo Financeは価格・出来高のみです。建玉・IV・Greeks・過去の全チェーンはこの履歴に含まれません。" : "Yahoo Finance provides prices and volume only. Open interest, IV, Greeks, and complete historical chains are not included."}</p>
    <p className="options-data-note">{ja ? "取得" : "Retrieved"}: {new Date(history.fetchedAt).toLocaleString(ja ? "ja-JP" : "en-US")} · {ja ? "提供値の価格調整は未検証。" : "Source price adjustments are unverified."}</p>
  </>;
}

export function OptionsContractPriceHistory(props: { symbol: string; snapshot?: OptionsChainSnapshot; ja: boolean }) {
  return <OptionsContractHistory key={props.symbol} {...props} />;
}

function OptionsContractHistory({ symbol, snapshot, ja }: { symbol: string; snapshot?: OptionsChainSnapshot; ja: boolean }) {
  const nearest = useMemo(() => [...(snapshot?.contracts ?? [])].filter(item => item.side === "call").sort((a, b) => Math.abs(a.strike - (snapshot?.underlyingPrice ?? 0)) - Math.abs(b.strike - (snapshot?.underlyingPrice ?? 0)))[0], [snapshot]);
  const [source, setSource] = useState<HistorySource>("chartexchange");
  const [choice, setChoice] = useState("");
  const [manualId, setManualId] = useState("");
  const [manualExpiry, setManualExpiry] = useState("");
  const [manualSide, setManualSide] = useState("C");
  const [manualStrike, setManualStrike] = useState("");
  const [metric, setMetric] = useState<HistoryMetric>("openInterest");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; value?: OptionsPriceHistory; error?: boolean }>();
  const contractId = choice === manualId && manualId ? manualId : snapshot?.contracts.some(item => item.contractId === choice) ? choice : nearest?.contractId ?? "";
  const key = `${symbol}:${contractId}:${source}:${attempt}`;
  const endpoint = `/api/v1/symbols/${encodeURIComponent(symbol)}/options/prices?${new URLSearchParams({ contractId, source })}`;
  const history = state?.key === key ? state.value : undefined;
  const error = state?.key === key && state.error;
  const loading = Boolean(contractId) && !history && !error;
  useEffect(() => {
    if (!contractId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      setState({ key, error: true });
    }, 30_000);
    fetch(endpoint, { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("unavailable");
      const value = await response.json() as OptionsPriceHistory;
      if (!optionHistoryResponseMatches(value, symbol, contractId, source)) throw new Error("invalid");
      if (!controller.signal.aborted) setState({ key, value });
    }).catch(() => { if (!controller.signal.aborted) setState({ key, error: true }); }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [endpoint, key, contractId, symbol, source]);

  return <section className="options-history-panel" aria-label={ja ? "オプションの過去価格・建玉" : "Historical option prices and open interest"}>
    <h3>{ja ? "オプション建玉・価格・出来高の推移" : "Option open interest, price and volume history"}</h3>
    <p className="options-data-note">{ja ? "登録不要の公開データから、契約別の日次履歴を表示します。" : "Daily history for an individual contract from public data; no registration required."} {source === "chartexchange" ? ja ? "ChartExchangeで取得できた期間を表示します。" : "Showing the period available from ChartExchange." : ja ? "Yahoo Financeには最大1年を照会します。" : "Yahoo Finance is queried for up to one year."} {ja ? "上のNasdaq気配値とは出典・日時が異なります。" : "The source and dates differ from the Nasdaq quotes above."}</p>
    <div className="options-chain-controls">
      <label>{ja ? "取得元" : "Source"}<select aria-label={ja ? "過去データの取得元" : "Historical data source"} value={source} onChange={event => { const next = event.target.value as HistorySource; setSource(next); setMetric(next === "chartexchange" ? "openInterest" : "close"); }}><option value="chartexchange">ChartExchange</option><option value="yahoo">{ja ? "Yahoo Finance（価格・出来高）" : "Yahoo Finance (price / volume)"}</option></select></label>
      <label>{ja ? "確認する契約" : "Contract to inspect"}<select disabled={!snapshot?.contracts.length && !manualId} aria-label={ja ? "過去価格を確認する契約" : "Historical price contract"} value={contractId} onChange={event => setChoice(event.target.value)}>{(snapshot?.contracts ?? []).map(item => <option key={item.contractId} value={item.contractId}>{item.expiration} · {item.side === "call" ? ja ? "コール" : "Call" : ja ? "プット" : "Put"} · ${item.strike}</option>)}{manualId && !snapshot?.contracts.some(item => item.contractId === manualId) && <option value={manualId}>{manualId}</option>}</select></label>
      <div className="financial-research-controls" role="group" aria-label={ja ? "過去データの表示項目" : "Historical metric"}>
        <button type="button" disabled={source === "yahoo"} aria-pressed={metric === "openInterest"} onClick={() => setMetric("openInterest")}>{ja ? "建玉" : "Open interest"}</button>
        <button type="button" aria-pressed={metric === "close"} onClick={() => setMetric("close")}>{ja ? "オプション終値" : "Option close"}</button>
        <button type="button" aria-pressed={metric === "volume"} onClick={() => setMetric("volume")}>{ja ? "出来高" : "Volume"}</button>
      </div>
      <button className="options-history-retry" type="button" disabled={!contractId || loading} onClick={() => setAttempt(value => value + 1)}>{ja ? "再取得" : "Reload"}</button>
    </div>
    <details className="options-table-details"><summary>{ja ? "別の満期・満期済みの契約を調べる" : "Look up another or expired contract"}</summary><form className="options-chain-controls options-historical-lookup" onSubmit={event => {
      event.preventDefault();
      const strike = Number(manualStrike);
      if (!/^20\d{2}-\d{2}-\d{2}$/.test(manualExpiry) || !Number.isFinite(optionHistoryDateAnchor(manualExpiry)) || !Number.isFinite(strike) || strike <= 0 || strike >= 100000) return;
      const id = `${symbol}${manualExpiry.replaceAll("-", "").slice(2)}${manualSide}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
      setManualId(id); setChoice(id); setAttempt(value => value + 1);
    }}><label>{ja ? "満期日" : "Expiration"}<input type="date" required min="2000-01-01" max="2099-12-31" value={manualExpiry} onChange={event => setManualExpiry(event.target.value)} /></label><label>{ja ? "種類" : "Side"}<select value={manualSide} onChange={event => setManualSide(event.target.value)}><option value="C">{ja ? "コール" : "Call"}</option><option value="P">{ja ? "プット" : "Put"}</option></select></label><label>{ja ? "行使価格（USD）" : "Strike (USD)"}<input type="number" required min="0.001" max="99999.999" step="0.001" value={manualStrike} onChange={event => setManualStrike(event.target.value)} /></label><button type="submit">{ja ? "履歴を表示" : "Show history"}</button></form><p className="options-data-note">{ja ? "過去の全契約一覧は提供されていません。満期済みの契約は、指定しても提供元に履歴が残っていない場合があります。" : "A complete historical contract list is not supplied. The source may no longer retain an expired contract even when its terms are specified."}</p></details>
    {!contractId ? <p className="options-data-note">{ja ? "満期日・種類・行使価格を指定すると、現在のチェーンを取得できない場合も過去価格を照会できます。" : "Enter an expiration, side, and strike to look up history even when the current chain is unavailable."}</p> : !history ? <p className="options-data-note" role="status">{error ? ja ? `${sourceNames[source]}からこの契約の過去データを取得できませんでした。30秒ほど待って「再取得」を押すか、取得元・契約を変更してください。` : `Past data could not be retrieved from ${sourceNames[source]}. Wait about 30 seconds before reloading, or choose another source or contract.` : <LoadingIndicator />}</p> : <OptionsContractHistoryData key={key} history={history} metric={metric} ja={ja} />}
  </section>;
}
