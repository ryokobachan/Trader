"use client";

import { LoadingIndicator } from "../../components/LoadingIndicator";

import { useEffect, useState } from "react";
import { useI18n } from "../../platform/i18n";
import type { OptionContractQuote, OptionsChainSnapshot } from "../../platform/options-contracts";
import { OptionsDistributionChart } from "./OptionsDistributionChart";
import { OptionsPriceReference } from "./OptionsPriceReference";
import { OptionsContractPriceHistory } from "./OptionsContractPriceHistory";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function OptionsChainTable({ contracts, ja = false, greeks = false }: {
  contracts: readonly OptionContractQuote[]; ja?: boolean; greeks?: boolean;
}) {
  const price = (value: number | undefined) => finite(value) ? new Intl.NumberFormat(ja ? "ja-JP" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : "—";
  const count = (value: number | undefined) => finite(value) ? value.toLocaleString(ja ? "ja-JP" : "en-US") : "—";
  const greek = (value: number | undefined) => finite(value) ? value.toFixed(4) : "—";
  return <div className="financial-research-table-wrap options-chain-table" role="region" tabIndex={0} aria-label={ja ? "オプション比較表（横スクロール可）" : "Options comparison table (scrollable)"}>
    <table><caption className="financial-visually-hidden">{ja ? "オプション契約別の実データ。価格はUSD / 株。" : "Source data by option contract. Prices are USD per share."}</caption><thead><tr>
      <th scope="col">{ja ? "権利行使価格" : "Strike"}</th>
      {greeks ? <><th scope="col">Delta</th><th scope="col">Gamma</th><th scope="col">Theta</th><th scope="col">Vega</th><th scope="col">Rho</th><th scope="col">IV</th></>
        : <><th scope="col">{ja ? "最終価格" : "Last"}</th><th scope="col">{ja ? "買気配" : "Bid"}</th><th scope="col">{ja ? "売気配" : "Ask"}</th><th scope="col">{ja ? "前日比" : "Change"}</th><th scope="col">{ja ? "出来高" : "Volume"}</th><th scope="col">{ja ? "建玉" : "Open interest"}</th></>}
    </tr></thead><tbody>{contracts.map(contract => <tr key={contract.contractId}>
      <th scope="row" title={contract.contractId}>{price(contract.strike)}</th>
      {greeks ? <><td>{greek(contract.delta)}</td><td>{greek(contract.gamma)}</td><td>{greek(contract.theta)}</td><td>{greek(contract.vega)}</td><td>{greek(contract.rho)}</td><td title={ja ? "提供元のIVを確認できません" : "No verified source IV"}>—</td></>
        : <><td className="options-last-price">{price(contract.last)}</td><td>{price(contract.bid)}</td><td>{price(contract.ask)}</td><td>{finite(contract.change) && contract.change > 0 ? "+" : ""}{price(contract.change)}</td><td>{count(contract.volume)}</td><td>{count(contract.openInterest)}</td></>}
    </tr>)}</tbody></table>
  </div>;
}

type OptionsState = { key: string; snapshot?: OptionsChainSnapshot; error?: true };

export function OptionsChainPanel({ symbol, externalUrl }: { symbol: string; externalUrl?: string }) {
  const { locale } = useI18n();
  const ja = locale === "ja";
  const [expiration, setExpiration] = useState("");
  const [range, setRange] = useState<"near" | "all">("all");
  const [side, setSide] = useState<"call" | "put">("call");
  const [view, setView] = useState<"prices" | "greeks">("prices");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<OptionsState>();
  const key = `${symbol}:${expiration}:${range}:${attempt}`;
  const active = state?.key === key ? state : undefined;
  const snapshot = active?.snapshot;
  const loading = !active;

  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ range, ...(expiration ? { expiration } : {}) });
    fetch(`/api/v1/symbols/${encodeURIComponent(symbol)}/options?${parameters}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Options unavailable");
        const result = await response.json() as OptionsChainSnapshot;
        if (result.symbol !== symbol.toUpperCase() || !Array.isArray(result.contracts)) throw new Error("Invalid options response");
        if (!controller.signal.aborted) setState({ key, snapshot: result });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ key, error: true }); });
    return () => controller.abort();
  }, [symbol, expiration, range, key]);

  const rows = snapshot?.contracts.filter(contract => contract.side === side) ?? [];
  const latestKnown = state?.snapshot?.symbol === symbol.toUpperCase() ? state.snapshot : undefined;
  const expirations = snapshot?.expirations ?? latestKnown?.expirations ?? [];
  const price = (value: number) => new Intl.NumberFormat(ja ? "ja-JP" : "en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const fetchedAt = snapshot ? new Intl.DateTimeFormat(ja ? "ja-JP" : "en-US", { dateStyle: "short", timeStyle: "short" }).format(new Date(snapshot.fetchedAt)) : "";
  const strikes = snapshot ? [...new Set(snapshot.contracts.map(contract => contract.strike))].sort((a, b) => a - b) : [];

  return <section className="financial-research-card options-chain-panel" aria-label={ja ? "オプションチェーン" : "Options chain"}>
    <header><div><span className="eyebrow">OPTIONS CHAIN</span><h2>{ja ? "オプション価格・建玉" : "Option prices & open interest"}</h2><small className="financial-research-source">Nasdaq · {ja ? "公開参考データ" : "Public reference data"}{snapshot ? ` · ${ja ? "取得" : "Retrieved"} ${fetchedAt}` : ""}</small></div>
      <div className="options-source-links"><a href={snapshot?.sourceUrl ?? `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(symbol.toLowerCase())}/option-chain`} target="_blank" rel="noreferrer">Nasdaq ↗</a>{externalUrl && <a href={externalUrl} target="_blank" rel="noreferrer">{ja ? "外部チャート" : "External chart"} ↗</a>}</div>
    </header>
    <div className="options-chain-controls">
      <label>{ja ? "満期日" : "Expiration"}<select aria-label={ja ? "オプションの満期日" : "Options expiration"} disabled={!expirations.length} value={expiration || snapshot?.expiration || latestKnown?.expiration || ""} onChange={event => setExpiration(event.target.value)}>
        {!expirations.length && <option value="">{loading ? "—" : active?.error ? (ja ? "取得できません" : "Unavailable") : (ja ? "満期日なし" : "No expirations")}</option>}{expirations.map(date => <option key={date} value={date}>{date}</option>)}
      </select></label>
      <label>{ja ? "権利行使価格の範囲" : "Strike range"}<select aria-label={ja ? "権利行使価格の範囲" : "Strike range"} value={range} onChange={event => setRange(event.target.value as "near" | "all")}><option value="near">{ja ? "原資産価格の近辺" : "Near the money"}</option><option value="all">{ja ? "すべて" : "All strikes"}</option></select></label>
    </div>
    {loading ? <div className="options-chain-status"><LoadingIndicator /></div>
      : active?.error ? <div className="options-chain-status" role="status"><p>{ja ? "現在オプション情報を取得できません。30秒ほど待って再試行するか、提供元のページをご覧ください。" : "Options data is currently unavailable. Wait about 30 seconds before retrying, or open the source page."}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>{ja ? "再試行" : "Retry"}</button></div>
      : snapshot && <>
        <div className="options-chain-context"><p>{finite(snapshot.underlyingPrice) && <>{ja ? "原資産の最終価格" : "Underlying last price"}: <b>{price(snapshot.underlyingPrice)}</b>{snapshot.underlyingAsOf ? ` · ${snapshot.underlyingAsOf}` : ""}</>}</p><span>{snapshot.expiration} · {ja ? `${strikes.length}価格帯・${snapshot.contracts.length}契約` : `${strikes.length} strikes · ${snapshot.contracts.length} contracts`}</span></div>
        {snapshot.isStale && <p className="options-data-note" role="status">{ja ? "更新に失敗したため、前回取得したデータを表示しています。" : "Refresh failed; showing the last available data."}</p>}
        <div className="options-range-explanation">
          <div><strong>{ja ? "表示している権利行使価格" : "Displayed strike prices"}{strikes.length > 0 && <>: {price(strikes[0])} – {price(strikes[strikes.length - 1])}</>}</strong>
            <p>{range === "near"
              ? (ja ? "いまは株価近辺だけを表示しています。範囲外にも契約がある場合があります。" : "Only near-the-money strikes are shown. Contracts may be listed outside this range.")
              : snapshot.truncated ? (ja ? "全価格帯を指定していますが、取得上限や取得元の応答により一部の契約のみ表示しています。" : "All strikes were requested, but only a partial chain was retrieved.")
                : (ja ? "選択した満期について、取得元が返した全価格帯を表示しています。" : "All strikes returned by the source for this expiration are shown.")}</p>
            <p>{ja ? "この両端は株価の上限・下限ではありません。満期日を変えると、掲載される価格帯も変わります。" : "The endpoints are not bounds on the stock price. Other expirations can have different listed strikes."}</p>
          </div>
        </div>
        <OptionsDistributionChart key={`${symbol}:${snapshot.expiration}:${range}`} snapshot={snapshot} ja={ja} />
        <div className="options-reading-guide"><strong>{ja ? "建玉から高値・安値は決まりません" : "Open interest does not set future highs or lows"}</strong><p>{ja ? "建玉は未決済の契約数です。買い手と売り手があり、ヘッジにも使われるため、コールが多い＝上がる、プットが多い＝下がるとは限りません。山のある価格帯は契約が集まっている場所として見てください。" : "Open interest counts outstanding contracts. Every contract has a buyer and seller, and positions may be hedges. More calls need not mean a rise, nor more puts a fall. Peaks show where contracts are concentrated."}</p><a className="options-education-link" href="https://www.optionseducation.org/referencelibrary/faq/general-information" target="_blank" rel="noreferrer">{ja ? "建玉の読み方（OIC） ↗" : "How to read open interest (OIC) ↗"}</a></div>
        <OptionsPriceReference snapshot={snapshot} ja={ja} />
        <details className="options-table-details"><summary>{ja ? "価格・建玉・感応度を表で確認" : "Inspect prices, open interest & Greeks in a table"}</summary>
        <div className="financial-research-controls options-table-side-controls" role="group" aria-label={ja ? "オプションの種類" : "Option type"}><button type="button" aria-pressed={side === "call"} onClick={() => setSide("call")}>{ja ? "コール（買う権利）" : "Calls"}</button><button type="button" aria-pressed={side === "put"} onClick={() => setSide("put")}>{ja ? "プット（売る権利）" : "Puts"}</button></div>
        <div className="financial-research-controls options-view-controls" role="group" aria-label={ja ? "オプションの表示項目" : "Options table view"}><button type="button" aria-pressed={view === "prices"} onClick={() => setView("prices")}>{ja ? "価格・出来高・建玉" : "Prices, volume & open interest"}</button><button type="button" aria-pressed={view === "greeks"} onClick={() => setView("greeks")}>{ja ? "感応度・IV" : "Greeks & IV"}</button></div>
        {rows.length ? <OptionsChainTable contracts={rows} ja={ja} greeks={view === "greeks"} /> : <p className="options-chain-status">{ja ? "この満期日・範囲で表示できる契約はありません。" : "No contracts are available for this expiration and strike range."}</p>}
        {view === "prices" ? <p className="options-data-note">{ja ? "価格は1株あたりのUSD。最終価格と気配値は更新時点が異なる場合があります。「—」は未取得、出来高・建玉の単位は契約数です。" : "Prices are USD per share. Last trade and bid/ask can reflect different times. — means unavailable; volume and open interest are contract counts."}</p>
          : <><p className="options-data-note">{ja ? "Deltaは株価への感応度、GammaはDeltaの変化、Thetaは時間経過、Vegaは変動率、Rhoは金利への感応度です。提供元の値をそのまま表示しています。" : "Delta measures price sensitivity; Gamma measures change in Delta; Theta, Vega and Rho measure sensitivity to time, volatility and interest rates. Values are shown as supplied by Nasdaq."}</p><p className="options-data-note">{ja ? "IVは信頼できる提供値を確認できないため「—」を表示しています。外部のオプション画面でも確認できます。" : "IV is shown as — because no reliable source value is available. You can also check the external options page."}</p></>}
        </details>
        <p className="options-data-note">{snapshot.optionQuoteAsOf ? `${ja ? "価格の基準時刻" : "Quote as of"}: ${snapshot.optionQuoteAsOf}` : (ja ? "提供元はオプション価格の基準時刻を公表していません。取得日時は価格の更新日時とは異なります。" : "The source does not supply an option quote timestamp. Retrieval time is not the quote update time.")}</p>
        {snapshot.truncated && <p className="options-data-note">{ja ? "取得上限のため一部の契約を表示しています。「原資産価格の近辺」に絞るか、提供元で続きをご確認ください。" : "Only part of the chain was retrieved due to the row limit. Choose near-the-money strikes or open the source for more contracts."}</p>}
      </>}
    <OptionsContractPriceHistory key={`prices:${symbol}`} symbol={symbol} snapshot={snapshot ?? latestKnown} ja={ja} />
  </section>;
}
