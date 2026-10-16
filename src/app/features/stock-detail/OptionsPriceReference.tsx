"use client";

import type { CSSProperties } from "react";
import type { OptionsChainSnapshot } from "../../platform/options-contracts";
import { optionPriceReference } from "./options-price-reference";

export function OptionsPriceReference({ snapshot, ja }: { snapshot: OptionsChainSnapshot; ja: boolean }) {
  const reference = optionPriceReference(snapshot);
  const price = (value: number) => new Intl.NumberFormat(ja ? "ja-JP" : "en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const reasons = {
    stale: ja ? "更新に失敗して過去のデータを表示しているため、損益分岐点の計算を省略しています。" : "The source refresh failed. Breakeven calculations are omitted for stale data.",
    underlying: ja ? "基準となる株価を取得できないため計算できません。" : "The underlying price is unavailable.",
    incomplete: ja ? "契約の取得が一部に限られるため計算を省略しています。" : "The chain is incomplete, so the calculation is omitted.",
    expired: ja ? "有効な満期日を確認できないため計算できません。" : "No current expiration is available.",
    nearby: ja ? "基準株価から5%以内の契約を確認できないため計算を省略しています。" : "No strike within 5% of the underlying price is available.",
    quotes: ja ? "株価に最も近い同一価格のコール・プットに、有効な買気配と売気配がそろっていません。最終価格や遠い契約では補完していません。" : "The nearest strike lacks a valid positive bid and ask for both a call and a put. Last prices and more distant strikes are not substituted.",
  };
  return <section className="options-price-reference" aria-label={ja ? "満期の損益分岐点" : "Expiration breakeven reference"}>
    <header><div><h3>{ja ? "満期の価格を考える参考" : "A reference for the expiration price"}</h3><p>{ja ? "同じ権利行使価格のコールとプットを両方買った場合の損益分岐点（ストラドル）。" : "Breakeven prices for a hypothetical purchase of a call and a put at the same strike (a straddle)."}</p></div><span className="options-reference-badge">{ja ? "予測範囲ではありません" : "Not a forecast range"}</span></header>
    {reference.status === "available" ? <>
      <p className="options-reference-basis">{snapshot.expiration} · {ja ? "権利行使価格" : "Strike"} {price(reference.strike)} · {ja ? "両方の気配中間値の合計" : "Combined bid/ask midpoints"} {price(reference.premium)}</p>
      <div className="options-reference-prices">
        <div><span>{ja ? "下側の損益分岐点" : "Lower breakeven"}</span><strong>{reference.lower === null ? (ja ? "なし" : "None") : price(reference.lower)}</strong><small>{reference.lower === null ? (ja ? "計算値が0ドル未満" : "Calculated value is below zero") : `${price(reference.strike)} − ${price(reference.premium)}`}</small></div>
        <div><span>{ja ? "基準株価" : "Underlying reference"}</span><strong>{price(reference.underlying)}</strong><small>{snapshot.underlyingAsOf ?? (ja ? "価格の更新日未公表" : "Price date unavailable")}</small></div>
        <div><span>{ja ? "上側の損益分岐点" : "Upper breakeven"}</span><strong>{price(reference.upper)}</strong><small>{price(reference.strike)} + {price(reference.premium)}</small></div>
      </div>
      {reference.lower !== null && reference.upper > reference.lower && <div className="options-reference-track" aria-hidden="true" style={{ "--reference-position": `${Math.max(0, Math.min(100, (reference.underlying - reference.lower) / (reference.upper - reference.lower) * 100))}%` } as CSSProperties}><span /><i /></div>}
      <p className="options-data-note">{ja ? `コール ${price(reference.callMid)} ＋ プット ${price(reference.putMid)}。手数料を含まず、気配の中間値で約定できるとは限りません。両契約の売買気配差は合計 ${price(reference.spread)}。` : `Call ${price(reference.callMid)} + put ${price(reference.putMid)}. Fees are excluded; execution at the midpoint is not assured. Combined bid/ask spread: ${price(reference.spread)}.`}</p>
      {!snapshot.optionQuoteAsOf && <p className="options-data-note">{ja ? "オプション価格の更新時刻が未公表のため、株価と同じ時点の値かは確認できません。掲載気配に基づく参考計算です。" : "The option quote timestamp is unavailable, so alignment with the underlying price cannot be verified. This is a calculation from the displayed quotes."}</p>}
    </> : <p className="options-data-note">{reasons[reference.reason]}</p>}
    <p className="options-reference-meaning">{ja ? "この価格は、将来の高値・安値や「この範囲に収まる確率」を示しません。株価は範囲を超えて動く可能性があります。" : "These levels do not indicate future highs, lows, or a probability of staying inside the band. The stock can move beyond them."}</p>
    <a className="options-education-link" href="https://www.optionseducation.org/strategies/all-strategies/long-straddle" target="_blank" rel="noreferrer">{ja ? "計算の考え方（OIC） ↗" : "Calculation explained by OIC ↗"}</a>
  </section>;
}
