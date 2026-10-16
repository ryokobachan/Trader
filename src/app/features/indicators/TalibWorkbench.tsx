"use client";

import { LoadingIndicator } from "../../components/LoadingIndicator";

import { useEffect, useMemo, useRef, useState } from "react";
import { ColorType, createChart, HistogramSeries, LineSeries, type Time } from "lightweight-charts";
import type { MarketBar } from "../../platform/provider-contracts";
import type { TalibCalculation, TalibCatalog, TalibDefinition, TalibResult } from "../../platform/talib-contracts";
import { useI18n } from "../../platform/i18n";
import "./TalibWorkbench.css";

type Selection = { id: string; parameters?: Record<string, number> };
const DEFAULT_SELECTION: Selection[] = ["KAMA", "SAR", "CMO", "MFI", "NATR", "CDLENGULFING"].map(id => ({ id }));
const STORAGE_KEY = "trader.talib.indicators.v1";
const COLORS = ["#8ab4f8", "#ffb86b", "#c5a3ff", "#71d6a4"];
const GROUPS: Record<string, string> = {
  "Overlap Studies": "移動平均・トレンド", "Momentum Indicators": "モメンタム", "Volume Indicators": "出来高",
  "Volatility Indicators": "ボラティリティ", "Cycle Indicators": "サイクル", "Pattern Recognition": "ローソク足パターン",
  "Price Transform": "価格変換", "Statistic Functions": "統計・回帰",
};
const PARAMS: Record<string, string> = { timeperiod: "期間", fastperiod: "短期", slowperiod: "長期", signalperiod: "シグナル期間", matype: "移動平均方式（0〜8）", penetration: "食い込み率", acceleration: "加速率", maximum: "加速率上限" };

function chartTime(value: string): Time {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value as Time : Math.floor(Date.parse(value) / 1000) as Time;
}

function ResultChart({ result, times }: { result: TalibResult; times: readonly string[] }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      height: 180, autoSize: true,
      layout: { attributionLogo: false, background: { type: ColorType.Solid, color: "#111114" }, textColor: "#b5b5bf", fontSize: 15 },
      grid: { vertLines: { color: "#202026" }, horzLines: { color: "#202026" } },
      rightPriceScale: { borderColor: "#303038" }, timeScale: { borderColor: "#303038" },
    });
    for (const [index, output] of result.series.entries()) {
      const series = result.group === "Pattern Recognition"
        ? chart.addSeries(HistogramSeries, { color: COLORS[index % COLORS.length], priceLineVisible: false })
        : chart.addSeries(LineSeries, { color: COLORS[index % COLORS.length], lineWidth: 2, priceLineVisible: false });
      series.setData(output.values.map((value, i) => value === null ? { time: chartTime(times[i]) }
        : { time: chartTime(times[i]), value }));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [result, times]);
  return <div className="talib-result-chart" ref={host} role="img" aria-label={`${result.id} history`} />;
}

export function TalibWorkbench({ symbol, bars }: { symbol: string; bars: readonly MarketBar[] }) {
  const { locale } = useI18n();
  const ja = locale === "ja";
  const [catalog, setCatalog] = useState<TalibCatalog | null>(null);
  const [selected, setSelected] = useState<Selection[]>(DEFAULT_SELECTION);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [result, setResult] = useState<{ key: string; value: TalibCalculation } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const settingsLoaded = useRef(false);
  const requestKey = useMemo(() => JSON.stringify({ symbol, bars, selected }), [symbol, bars, selected]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/indicators", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("catalog");
      const value = await response.json() as TalibCatalog;
      setCatalog(value);
      if (!settingsLoaded.current) {
        try {
          const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
          if (Array.isArray(saved) && saved.length <= 8 && new Set(saved.map(item => item?.id)).size === saved.length
            && saved.every(item => item && typeof item === "object" && value.indicators.some(definition => definition.id === item.id)
              && (item.parameters === undefined || item.parameters !== null && typeof item.parameters === "object" && !Array.isArray(item.parameters)
                && Object.values(item.parameters).every(parameter => typeof parameter === "number" && Number.isFinite(parameter))))) {
            setSelected(saved.map(item => ({ id: item.id, ...(item.parameters === undefined ? {} : { parameters: item.parameters }) })));
          }
        } catch { /* Storage is optional; use the reviewed defaults. */ }
        settingsLoaded.current = true;
      }
    }).catch(() => { if (!controller.signal.aborted) setError("catalog"); });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    if (settingsLoaded.current) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(selected)); } catch { /* Private browsing may disable storage. */ }
    }
  }, [selected]);

  useEffect(() => {
    if (!catalog || !bars.length || !selected.length) return;
    const controller = new AbortController();
    // Debounce edits; every response is tied to the complete symbol/bar/spec input.
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      fetch("/api/v1/indicators/calculate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bars: bars.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })), indicators: selected }), signal: controller.signal,
      }).then(async response => {
        if (!response.ok) throw new Error(response.status === 400 ? "parameters" : "calculate");
        const value = await response.json() as TalibCalculation;
        if (!controller.signal.aborted) setResult({ key: requestKey, value });
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "calculate"); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [bars, catalog, requestKey, selected, revision]);

  const visible = catalog?.indicators.filter(item => (!group || item.group === group)
    && `${item.id} ${item.name} ${GROUPS[item.group] ?? item.group}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const current = result?.key === requestKey ? result.value : null;
  const definitions = new Map(catalog?.indicators.map(item => [item.id, item]));
  const number = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat(ja ? "ja-JP" : "en-US", { maximumFractionDigits: 4 }).format(value);
  function updateParameter(id: string, parameter: string, value: string, definition: TalibDefinition) {
    const parsed = value === "" ? definition.parameters[parameter] : Number(value);
    if (!Number.isFinite(parsed)) return;
    setSelected(items => items.map(item => item.id === id ? { ...item, parameters: { ...definition.parameters, ...item.parameters, [parameter]: parsed } } : item));
  }
  return <section className="talib-workbench" aria-label={ja ? "TA-Lib指標ライブラリ" : "TA-Lib indicator library"}>
    <header className="talib-heading"><div><span className="eyebrow">TA-LIB</span><h2>{ja ? "指標ライブラリ" : "Indicator library"}</h2>
      <p>{ja ? "日足から計算。指標・期間を選び、値と履歴を比較できます。" : "Calculated from daily bars. Choose indicators and periods to compare values and history."}</p></div>
      <small>{symbol} · {bars.length}{ja ? "本の日足" : " daily bars"} · {catalog ? `${catalog.indicators.length}${ja ? "種類" : " functions"}` : "—"}</small></header>
    <div className="talib-picker">
      <input aria-label={ja ? "指標を検索" : "Search indicators"} placeholder={ja ? "指標を検索：KAMA、MFI、ローソク足…" : "Search KAMA, MFI, candlesticks…"} value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label={ja ? "指標の分類" : "Indicator group"} value={group} onChange={event => setGroup(event.target.value)}>
        <option value="">{ja ? "すべての分類" : "All groups"}</option>
        {Object.entries(GROUPS).map(([id, label]) => <option key={id} value={id}>{ja ? label : id}</option>)}
      </select>
      <span>{selected.length} / 8</span>
    </div>
    <div className="talib-library" aria-label={ja ? "利用可能な指標" : "Available indicators"}>
      {visible.map(definition => {
        const active = selected.some(item => item.id === definition.id);
        return <button type="button" key={definition.id} aria-pressed={active} disabled={!active && selected.length >= 8}
          onClick={() => setSelected(items => active ? items.filter(item => item.id !== definition.id) : [...items, { id: definition.id }])}>
          <b>{definition.id}</b><span>{definition.name}</span><small>{active ? (ja ? "選択中" : "Selected") : (ja ? GROUPS[definition.group] : definition.group)}</small>
        </button>;
      })}
      {catalog && visible.length === 0 && <p>{ja ? "一致する指標がありません。" : "No matching indicators."}</p>}
    </div>
    {error && <p className="talib-error" role="alert">{error === "parameters" ? (ja ? "パラメータが指標の対応範囲外です。値を確認してください。" : "Parameters are outside this indicator's supported range.")
      : (ja ? "指標を取得・計算できませんでした。" : "Indicators could not be loaded or calculated.")} <button type="button" onClick={() => setRevision(value => value + 1)}>{ja ? "再試行" : "Retry"}</button></p>}
    {!bars.length && <p role="status">{ja ? "日足データの取得後に計算します。" : "Waiting for daily price data."}</p>}
    {selected.length === 0 && <p>{ja ? "上の一覧から指標を選択してください。" : "Select indicators from the library above."}</p>}
    {loading && <LoadingIndicator />}
    <div className="talib-results" aria-busy={loading}>
      {selected.map(selection => {
        const definition = definitions.get(selection.id);
        if (!definition) return null;
        const calculated = current?.results.find(item => item.id === selection.id);
        return <article className="talib-result" key={selection.id}>
          <header><div><h3>{selection.id}</h3><small>{definition.name}</small></div>
            <button type="button" aria-label={`${ja ? "削除" : "Remove"} ${selection.id}`} onClick={() => setSelected(items => items.filter(item => item.id !== selection.id))}>×</button></header>
          <div className="talib-parameters">{Object.entries(definition.parameters).map(([name, defaultValue]) => <label key={name}>{ja ? PARAMS[name] ?? name : name}
            <input type="number" step={Number.isInteger(defaultValue) ? "1" : "any"} aria-label={`${selection.id} ${name}`} value={selection.parameters?.[name] ?? defaultValue}
              onChange={event => updateParameter(selection.id, name, event.target.value, definition)} /></label>)}</div>
          <div className="talib-readout">{calculated?.series.map((series, i) => <span key={series.name} style={{ color: COLORS[i % COLORS.length] }}>{series.name} <b>{number(series.values.at(-1))}</b></span>)
            ?? <span>{error ? "—" : ja ? "計算中…" : "Calculating…"}</span>}</div>
          {calculated && current && <ResultChart result={calculated} times={current.times} />}
          <footer>{ja ? "入力" : "Inputs"}: {Object.values(definition.inputs).flat().join(" / ")} · {ja ? "先頭の欠損本数" : "Warm-up bars"}: {calculated?.lookback ?? definition.lookback}
            {definition.group === "Pattern Recognition" && <p>{ja ? "0は該当なし。符号と数値の意味はパターンごとに異なります。単独の売買判断や確率を表す値ではありません。" : "Zero means no pattern. Sign and magnitude depend on the pattern; they are not standalone trade decisions or probabilities."}</p>}</footer>
        </article>;
      })}
    </div>
    <p className="talib-note">{ja ? "必要本数に満たない値は欠損のまま表示します。期間は営業日数ではなく入力した足の本数です。既存の26指標による売買評価とは別に、選択した指標を比較できます。" : "Warm-up values remain missing. Periods count input bars. Compare selected indicators alongside the existing 26-indicator rating."}</p>
  </section>;
}
