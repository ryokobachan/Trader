import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OptionContractQuote, OptionsChainSnapshot } from "../src/app/platform/options-contracts";
import { buildOptionsDistribution, optionReferenceMidpoint, OptionsDistributionChart } from "../src/app/features/stock-detail/OptionsDistributionChart";

function contract(strike: number, side: "call" | "put", values: Partial<OptionContractQuote> = {}): OptionContractQuote {
  return { contractId: `MU260909${side[0].toUpperCase()}${strike}`, expiration: "2026-09-09", strike, side, ...values };
}

function snapshot(contracts: OptionContractQuote[], fields: Partial<OptionsChainSnapshot> = {}): OptionsChainSnapshot {
  return {
    symbol: "MU", currency: "USD", expiration: "2026-09-09", expirations: ["2026-09-09"], range: "near", contracts,
    source: "Nasdaq", sourceUrl: "https://www.nasdaq.com/market-activity/stocks/mu/option-chain",
    greeksSourceUrl: "https://www.nasdaq.com/market-activity/stocks/mu/option-chain/greeks", fetchedAt: "2026-09-05T12:00:00.000Z",
    truncated: false, greeksAvailable: false, impliedVolatilityAvailable: false, ...fields,
  };
}

test("distribution compares calls and puts from the selected expiry without replacing missing counts by zero", () => {
  const source = snapshot([
    contract(105, "put", { openInterest: 0, volume: 8 }),
    contract(100, "call", { openInterest: 20, volume: 0 }),
    contract(105, "call", { volume: 5 }),
    contract(500, "call", { expiration: "2026-09-11", openInterest: 999 }),
  ]);
  const oi = buildOptionsDistribution(source, "openInterest");
  assert.deepEqual(oi.points.map(point => point.strike), [100, 105]);
  assert.deepEqual(oi.points.map(point => [point.callValue, point.putValue]), [[20, undefined], [undefined, 0]]);
  assert.equal(oi.observedCount, 2); assert.equal(oi.missingCount, 2); assert.equal(oi.maximumValue, 20);
  const volume = buildOptionsDistribution(source, "volume");
  assert.deepEqual(volume.points.map(point => [point.callValue, point.putValue]), [[0, undefined], [5, 8]]);
  assert.equal(volume.observedCount, 3); assert.equal(volume.maximumValue, 8);
});

test("reference price requires ordered finite nonnegative bid and ask and never substitutes the last trade", () => {
  assert.ok(Math.abs(optionReferenceMidpoint(contract(100, "call", { bid: 1.2, ask: 1.4, last: 99 }))! - 1.3) < 1e-12);
  assert.equal(optionReferenceMidpoint(contract(100, "call", { bid: 0, ask: 0, last: 99 })), 0);
  assert.equal(optionReferenceMidpoint(contract(100, "call", { bid: 0, ask: 0.01 })), 0.005);
  for (const fields of [{ last: 10 }, { bid: 1 }, { ask: 1 }, { bid: -1, ask: 2 }, { bid: 2, ask: 1 }, { bid: NaN, ask: 2 }, { bid: 1, ask: Infinity }]) {
    assert.equal(optionReferenceMidpoint(contract(100, "call", fields)), undefined);
  }
  const model = buildOptionsDistribution(snapshot([contract(100, "call", { bid: 1, ask: 3, last: 99 }), contract(100, "put", { bid: 3, ask: 1, last: 22 })]), "midpoint");
  assert.equal(model.points[0].callValue, 2); assert.equal(model.points[0].putValue, undefined);
  assert.equal(model.maximumValue, 2); assert.equal(model.missingCount, 1);
});

test("distribution retains outlying strikes and includes the underlying price on the numeric axis", () => {
  const source = snapshot([contract(90, "call", { openInterest: 10 }), contract(100, "put", { openInterest: 20 }), contract(2000, "call", { openInterest: 5 })], { underlyingPrice: 2500, truncated: true });
  const model = buildOptionsDistribution(source, "openInterest");
  assert.deepEqual(model.points.map(point => point.strike), [90, 100, 2000]);
  assert.ok(model.xMinimum <= 90); assert.ok(model.xMaximum >= 2500);
  assert.equal(model.underlying, 2500);
  const html = renderToStaticMarkup(createElement(OptionsDistributionChart, { snapshot: source, ja: true }));
  assert.match(html, /data-strike="2000"/);
  assert.match(html, /株価 \$2,500\.00/);
  assert.match(html, /表示はチェーンの一部/);
});

test("rendered strike positions preserve numeric distance and positive bars share a zero baseline", () => {
  const source = snapshot([contract(90, "call", { openInterest: 10 }), contract(100, "call", { openInterest: 20 }), contract(200, "call", { openInterest: 30 })]);
  const html = renderToStaticMarkup(createElement(OptionsDistributionChart, { snapshot: source, ja: false }));
  const positions = [...html.matchAll(/data-strike="(\d+)" transform="translate\(([\d.]+) 0\)"/g)].map(match => Number(match[2]));
  assert.equal(positions.length, 3);
  assert.ok(Math.abs((positions[2] - positions[1]) / (positions[1] - positions[0]) - 10) < 1e-10);
  const bars = [...html.matchAll(/<rect class="options-distribution-call[^\"]*" x="[^"]+" y="([\d.]+)" width="[^"]+" height="([\d.]+)"/g)];
  assert.equal(bars.length, 3);
  const bottoms = bars.map(match => Number(match[1]) + Number(match[2]));
  assert.ok(bottoms.every(value => Math.abs(value - bottoms[0]) < 1e-10));
  assert.ok(Math.abs(Number(bars[1][2]) - Number(bars[0][2]) * 2) < 1e-10);
  assert.match(html, /tabindex="0" role="group"/);
  assert.match(html, /left and right arrow keys/);
  assert.match(html, /aria-label="Strike to inspect on chart"/);
});

test("quoted zero receives a baseline mark while unavailable counts receive missing markers", () => {
  const html = renderToStaticMarkup(createElement(OptionsDistributionChart, { snapshot: snapshot([contract(100, "call", { openInterest: 0 }), contract(100, "put")]), ja: true }));
  assert.match(html, /options-distribution-call[^\"]* options-distribution-zero/);
  assert.match(html, /options-distribution-missing/);
  assert.match(html, /コール · 建玉<\/span><strong>0<\/strong>/);
  assert.match(html, /プット · 建玉<\/span><strong>—<\/strong>/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("invalid and absent observations produce a clear empty state without plotting another expiry", () => {
  const source = snapshot([
    contract(100, "call", { openInterest: -1 }), contract(100, "put", { openInterest: 1.5 }),
    contract(NaN, "call", { openInterest: 10 }), contract(100, "call", { expiration: "2026-09-11", openInterest: 30 }),
  ]);
  const model = buildOptionsDistribution(source, "openInterest");
  assert.equal(model.observedCount, 0);
  assert.equal(model.points.length, 1);
  const html = renderToStaticMarkup(createElement(OptionsDistributionChart, { snapshot: source, ja: true }));
  assert.match(html, /建玉の有効な値がありません/);
  assert.doesNotMatch(html, /<svg|NaN|Infinity/);
  assert.deepEqual(buildOptionsDistribution({ ...source, expiration: null }, "openInterest").points, []);
});
