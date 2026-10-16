"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { OptionContractQuote, OptionsChainSnapshot } from "../../platform/options-contracts";

export type OptionsDistributionMetric = "openInterest" | "volume" | "midpoint";
type StrikePoint = {
  strike: number;
  call?: OptionContractQuote;
  put?: OptionContractQuote;
  callValue?: number;
  putValue?: number;
};

const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function optionReferenceMidpoint(contract?: OptionContractQuote): number | undefined {
  if (!contract || !nonnegative(contract.bid) || !nonnegative(contract.ask) || contract.bid > contract.ask) return undefined;
  return contract.bid + (contract.ask - contract.bid) / 2;
}

function metricValue(contract: OptionContractQuote | undefined, metric: OptionsDistributionMetric) {
  if (metric === "midpoint") return optionReferenceMidpoint(contract);
  const value = contract?.[metric];
  return nonnegative(value) && Number.isSafeInteger(value) ? value : undefined;
}

export function buildOptionsDistribution(snapshot: OptionsChainSnapshot, metric: OptionsDistributionMetric) {
  const strikes = new Map<number, StrikePoint>();
  for (const contract of snapshot.contracts) {
    if (!snapshot.expiration || contract.expiration !== snapshot.expiration || !nonnegative(contract.strike)) continue;
    const point = strikes.get(contract.strike) ?? { strike: contract.strike };
    point[contract.side] = contract;
    point[contract.side === "call" ? "callValue" : "putValue"] = metricValue(contract, metric);
    strikes.set(contract.strike, point);
  }
  const points = [...strikes.values()].sort((a, b) => a.strike - b.strike);
  const values = points.flatMap(point => [point.callValue, point.putValue].filter(nonnegative));
  const underlying = nonnegative(snapshot.underlyingPrice) ? snapshot.underlyingPrice : undefined;
  const extent = [...points.map(point => point.strike), ...(underlying === undefined ? [] : [underlying])];
  const minimum = extent.length ? Math.min(...extent) : 0;
  const maximum = extent.length ? Math.max(...extent) : 1;
  const padding = maximum > minimum ? (maximum - minimum) * 0.035 : Math.max(1, maximum * 0.035);
  return {
    points, underlying, missingCount: points.length * 2 - values.length, observedCount: values.length,
    xMinimum: Math.max(0, minimum - padding), xMaximum: maximum + padding,
    maximumValue: values.length ? Math.max(...values) : 0,
  };
}

function scaleCeiling(maximum: number, integer: boolean) {
  const desired = (maximum || 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(desired));
  const multiple = [1, 2, 5, 10].find(value => value * magnitude >= desired) ?? 10;
  const step = Math.max(integer ? 1 : Number.MIN_VALUE, multiple * magnitude);
  const count = Math.max(1, Math.ceil(maximum / step));
  return { maximum: step * count, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) };
}

// Product chart contract: compare call/put magnitude at each strike of one expiry.
// Counts use zero-based grouped bars; valid bid/ask midpoints use discrete markers.
// Numeric strike distances, every supplied strike, and missing values are retained.
export function OptionsDistributionChart({ snapshot, ja }: { snapshot: OptionsChainSnapshot; ja: boolean }) {
  const [metric, setMetric] = useState<OptionsDistributionMetric>("openInterest");
  const [selectedStrike, setSelectedStrike] = useState<number>();
  const [width, setWidth] = useState(900);
  const frame = useRef<HTMLDivElement>(null);
  const id = useId();
  const model = useMemo(() => buildOptionsDistribution(snapshot, metric), [snapshot, metric]);
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const measured = entries[0]?.contentRect.width;
      if (measured) setWidth(Math.max(280, Math.round(measured)));
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);

  const locale = ja ? "ja-JP" : "en-US";
  const number = (value: number | undefined, price = false) => nonnegative(value)
    ? new Intl.NumberFormat(locale, { minimumFractionDigits: price ? 2 : 0, maximumFractionDigits: price ? 3 : 0 }).format(value) : "—";
  const money = (value: number | undefined) => nonnegative(value) ? `$${number(value, true)}` : "—";
  const labels = {
    openInterest: ja ? "建玉" : "Open interest",
    volume: ja ? "出来高" : "Volume",
    midpoint: ja ? "参考価格" : "Reference price",
  };
  const isPrice = metric === "midpoint";
  const valueText = (value: number | undefined) => isPrice ? money(value) : number(value);
  const title = ja ? `権利行使価格別の${labels[metric]}` : `${labels[metric]} by strike`;
  const units = isPrice ? (ja ? "USD / 株 · 有効な買気配と売気配の中間値" : "USD / share · Midpoint of valid bid and ask") : (ja ? "契約数 · コールとプットを同じ満期で比較" : "Contracts · Calls and puts at the same expiration");
  const height = 350;
  const left = width < 480 ? 52 : 64;
  const right = 20;
  const top = 38;
  const bottom = 282;
  const plotWidth = width - left - right;
  const x = (strike: number) => left + (strike - model.xMinimum) / (model.xMaximum - model.xMinimum) * plotWidth;
  const yScale = scaleCeiling(model.maximumValue, !isPrice);
  const y = (value: number) => bottom - value / yScale.maximum * (bottom - top);
  const xTickCount = width < 480 ? 3 : width < 720 ? 4 : 6;
  const xTicks = Array.from({ length: xTickCount }, (_, index) => model.xMinimum + (model.xMaximum - model.xMinimum) * index / (xTickCount - 1));
  const distances = model.points.slice(1).map((point, index) => x(point.strike) - x(model.points[index].strike));
  const barWidth = Math.min(14, (distances.length ? Math.min(...distances) : plotWidth / 4) * 0.36);
  const barGap = Math.min(3, barWidth * 0.25);
  const defaultIndex = model.points.reduce((nearest, point, index) => model.underlying !== undefined && Math.abs(point.strike - model.underlying) < Math.abs(model.points[nearest].strike - model.underlying) ? index : nearest, 0);
  const found = model.points.findIndex(point => point.strike === selectedStrike);
  const selectedIndex = found >= 0 ? found : defaultIndex;
  const selected = model.points[selectedIndex];
  const selectByPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (!model.points.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - bounds.left) / bounds.width * width;
    const nearest = model.points.reduce((best, point) => Math.abs(x(point.strike) - position) < Math.abs(x(best.strike) - position) ? point : best);
    setSelectedStrike(nearest.strike);
  };
  const selectByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !model.points.length) return;
    let next = selectedIndex;
    if (event.key === "ArrowRight") next++;
    else if (event.key === "ArrowLeft") next--;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = model.points.length - 1;
    else return;
    event.preventDefault();
    setSelectedStrike(model.points[Math.max(0, Math.min(model.points.length - 1, next))].strike);
  };
  const tickText = (value: number) => new Intl.NumberFormat(locale, isPrice
    ? { maximumFractionDigits: 3 }
    : { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);

  return <section className="options-distribution" aria-labelledby={`${id}-heading`}>
    <div className="options-distribution-header">
      <div><h3 id={`${id}-heading`}>{title}</h3><p>{units}</p></div>
      <div className="options-distribution-controls" role="group" aria-label={ja ? "グラフの表示項目" : "Chart metric"}>
        {(["openInterest", "volume", "midpoint"] as const).map(value => <button type="button" key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{labels[value]}</button>)}
      </div>
    </div>
    <div className={`options-distribution-legend${isPrice ? " is-price" : ""}`}>
      <span><i className="options-distribution-call-key" aria-hidden="true" />{ja ? "コール（買う権利）" : "Call · right to buy"}</span>
      <span><i className="options-distribution-put-key" aria-hidden="true" />{ja ? "プット（売る権利）" : "Put · right to sell"}</span>
      {model.underlying !== undefined && <span><i className="options-distribution-underlying-key" aria-hidden="true" />{ja ? "原資産の最終価格" : "Underlying last price"} {money(model.underlying)}</span>}
    </div>
    <div ref={frame} className="options-distribution-frame">
      {!model.observedCount ? <p className="options-distribution-empty">{ja ? `この満期・範囲に${labels[metric]}の有効な値がありません。` : `No valid ${labels[metric].toLowerCase()} observations for this expiration and range.`}</p>
        : <div className="options-distribution-interaction" tabIndex={0} role="group" aria-label={ja ? `${title}。左右矢印キーで権利行使価格を選択できます。` : `${title}. Use left and right arrow keys to select a strike.`} aria-describedby={`${id}-help ${id}-detail`} onKeyDown={selectByKeyboard}>
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-svg-title ${id}-svg-desc`} onPointerMove={event => { if (event.pointerType !== "touch") selectByPointer(event); }} onPointerDown={selectByPointer}>
            <title id={`${id}-svg-title`}>{title}</title>
            <desc id={`${id}-svg-desc`}>{isPrice ? (ja ? "横軸は権利行使価格の数値間隔、縦軸はゼロ起点。参考価格をコールは丸、プットは輪郭の菱形で表示し、欠損は×で区別します。" : "Strike prices are positioned on a numeric horizontal axis; the vertical axis starts at zero. Call midpoints are circles and put midpoints are outlined diamonds. Crosses indicate missing data.") : (ja ? "横軸は権利行使価格の数値間隔、縦軸はゼロ起点。コールは塗り、プットは輪郭で区別。欠損は×、実測ゼロは基準線上の短線。" : "Strike prices are positioned on a numeric horizontal axis; the vertical axis starts at zero. Calls are filled; puts are outlined. A cross indicates missing data, while a short mark on the baseline indicates a quoted zero.")}</desc>
            {yScale.ticks.map(value => <g key={value} className="options-distribution-axis"><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={value === 0 ? "options-distribution-baseline" : "options-distribution-gridline"} /><text x={left - 10} y={y(value) + 4} textAnchor="end">{tickText(value)}</text></g>)}
            {xTicks.map((value, index) => <g key={index} className="options-distribution-axis"><line x1={x(value)} x2={x(value)} y1={bottom} y2={bottom + 5} /><text x={x(value)} y={bottom + 33} textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}>{new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}</text></g>)}
            <text className="options-distribution-axis-label" x={left} y={height - 7}>{ja ? "権利行使価格（USD）" : "Strike price (USD)"}</text>
            {model.underlying !== undefined && <g className="options-distribution-underlying"><line x1={x(model.underlying)} x2={x(model.underlying)} y1={top} y2={bottom} /><text x={x(model.underlying)} y={20} textAnchor={x(model.underlying) > width - 115 ? "end" : x(model.underlying) < left + 80 ? "start" : "middle"}>{ja ? "株価 " : "Stock "}{money(model.underlying)}</text></g>}
            {selected && <line className="options-distribution-selection" x1={x(selected.strike)} x2={x(selected.strike)} y1={top} y2={bottom} />}
            {model.points.map(point => <g key={point.strike} className="options-distribution-strike" data-strike={point.strike} transform={`translate(${x(point.strike)} 0)`}>
              {(["call", "put"] as const).map(side => {
                const value = side === "call" ? point.callValue : point.putValue;
                const offset = side === "call" ? -barWidth - barGap / 2 : barGap / 2;
                const center = offset + barWidth / 2;
                const className = `options-distribution-${side}${selected?.strike === point.strike ? " is-selected" : ""}`;
                return <g key={side}><title>{`${money(point.strike)} · ${side === "call" ? (ja ? "コール" : "Call") : (ja ? "プット" : "Put")} · ${labels[metric]} ${valueText(value)}`}</title>
                  {value === undefined ? <text className="options-distribution-missing" x={isPrice ? (side === "call" ? -4 : 4) : center} y={bottom + 15} textAnchor="middle">×</text>
                    : isPrice ? side === "call" ? <circle className={className} cx={0} cy={y(value)} r={3.5} /> : <path className={className} d={`M0 ${y(value) - 5} l5 5 l-5 5 l-5 -5 Z`} />
                    : value === 0 ? <line className={`${className} options-distribution-zero`} x1={offset} x2={offset + barWidth} y1={bottom} y2={bottom} />
                    : <rect className={className} x={offset} y={y(value)} width={barWidth} height={bottom - y(value)} />}
                </g>;
              })}
            </g>)}
          </svg>
        </div>}
    </div>
    {selected && <div className="options-distribution-detail" id={`${id}-detail`}>
      <label className="options-distribution-strike-select">{ja ? "権利行使価格" : "Strike price"}<select aria-label={ja ? "グラフで確認する権利行使価格" : "Strike to inspect on chart"} value={selected.strike} onChange={event => setSelectedStrike(Number(event.target.value))}>{model.points.map(point => <option key={point.strike} value={point.strike}>{money(point.strike)}</option>)}</select></label>
      <div className="options-distribution-detail-values" aria-live="polite" aria-atomic="true">
        {(["call", "put"] as const).map(side => <div className={`options-distribution-detail-${side}`} key={side}><span>{side === "call" ? (ja ? "コール" : "Call") : (ja ? "プット" : "Put")} · {labels[metric]}</span><strong>{valueText(side === "call" ? selected.callValue : selected.putValue)}</strong><small>{isPrice ? `${ja ? "買気配" : "Bid"} ${money(selected[side]?.bid)} / ${ja ? "売気配" : "Ask"} ${money(selected[side]?.ask)}` : `${ja ? "参考価格" : "Reference price"} ${money(optionReferenceMidpoint(selected[side]))}`}</small></div>)}
      </div>
    </div>}
    <p className="options-distribution-note" id={`${id}-help`}>{ja ? "グラフに触れるか、左右矢印キー・価格の選択欄で詳細を確認できます。" : "Hover or tap the chart, use left/right arrow keys, or select a strike to inspect both series."}</p>
    <p className="options-distribution-note">{isPrice ? (ja ? "参考価格は（買気配＋売気配）÷2。最終取引価格は使わず、売気配が買気配を下回る場合は欠損として扱います。約定可能な価格を保証するものではありません。" : "Reference price = (bid + ask) / 2. Last trades are excluded, and crossed quotes are treated as missing. The midpoint is not a guaranteed execution price.") : (ja ? "×・— は有効な値なし、基準線上の短線は0契約です。" : "× and — mean no valid observation; a short mark on the baseline means zero contracts.")}{model.missingCount ? ` ${ja ? `比較対象${model.points.length * 2}件のうち${model.missingCount}件に有効な値がありません。` : `${model.missingCount} of ${model.points.length * 2} compared observations have no valid value.`}` : ""}{snapshot.truncated ? ` ${ja ? "取得上限により、表示はチェーンの一部です。" : "This is a partial chain due to the retrieval limit."}` : ""}</p>
  </section>;
}
