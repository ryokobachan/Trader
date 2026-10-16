import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OptionContractQuote, OptionsChainSnapshot } from "../src/app/platform/options-contracts";
import { optionPriceReference } from "../src/app/features/stock-detail/options-price-reference";
import { OptionsPriceReference } from "../src/app/features/stock-detail/OptionsPriceReference";

const contracts: OptionContractQuote[] = [
  { contractId: "NBIS260911C00225000", side: "call", expiration: "2026-09-11", strike: 225, bid: 10.3, ask: 11, last: 99 },
  { contractId: "NBIS260911P00225000", side: "put", expiration: "2026-09-11", strike: 225, bid: 8.7, ask: 9.3 },
];
const snapshot: OptionsChainSnapshot = {
  symbol: "NBIS", currency: "USD", expiration: "2026-09-11", expirations: ["2026-09-11"], range: "near", contracts,
  source: "Nasdaq", sourceUrl: "https://www.nasdaq.com/market-activity/stocks/nbis/option-chain", greeksSourceUrl: "https://www.nasdaq.com/market-activity/stocks/nbis/option-chain/greeks",
  fetchedAt: "2026-09-05T10:00:00Z", underlyingPrice: 226.39, underlyingAsOf: "2026-09-03", truncated: false, greeksAvailable: false, impliedVolatilityAvailable: false,
};

test("straddle breakevens use the same strike and midpoint premium, not the stock or last price", () => {
  const result = optionPriceReference(snapshot);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.strike, 225);
  assert.equal(result.callMid, 10.65);
  assert.equal(result.putMid, 9);
  assert.equal(result.lower, 205.35);
  assert.equal(result.upper, 244.65);
});

test("missing nearest quotes never silently select a more distant or different-expiration pair", () => {
  const farther = contracts.map(c => ({ ...c, contractId: `${c.contractId}-far`, strike: 230 }));
  for (const change of [{ bid: undefined }, { bid: 0 }, { bid: 12, ask: 11 }, { bid: Number.NaN }]) {
    assert.deepEqual(optionPriceReference({ ...snapshot, contracts: [{ ...contracts[0], ...change }, contracts[1], ...farther] }), { status: "unavailable", reason: "quotes" });
  }
  assert.deepEqual(optionPriceReference({ ...snapshot, contracts: [contracts[0], { ...contracts[1], expiration: "2026-10-16" }] }), { status: "unavailable", reason: "quotes" });
});

test("reference rejects incomplete, expired, remote or missing underlying observations", () => {
  assert.deepEqual(optionPriceReference({ ...snapshot, isStale: true }), { status: "unavailable", reason: "stale" });
  assert.deepEqual(optionPriceReference({ ...snapshot, truncated: true }), { status: "unavailable", reason: "incomplete" });
  assert.deepEqual(optionPriceReference({ ...snapshot, underlyingPrice: undefined }), { status: "unavailable", reason: "underlying" });
  assert.deepEqual(optionPriceReference({ ...snapshot, fetchedAt: "2026-09-12T00:00:00Z" }), { status: "unavailable", reason: "expired" });
  assert.deepEqual(optionPriceReference({ ...snapshot, underlyingPrice: 300 }), { status: "unavailable", reason: "nearby" });
});

test("negative lower breakeven is absent instead of becoming a false zero-dollar bound", () => {
  const result = optionPriceReference({ ...snapshot, contracts: contracts.map(c => ({ ...c, bid: 120, ask: 125 })) });
  assert.equal(result.status, "available");
  if (result.status === "available") assert.equal(result.lower, null);
});

test("reference labels the calculation and quote-time limits without a probabilistic claim", () => {
  const html = renderToStaticMarkup(createElement(OptionsPriceReference, { snapshot, ja: true }));
  assert.match(html, /下側の損益分岐点/);
  assert.match(html, /予測範囲ではありません/);
  assert.match(html, /同じ時点の値かは確認できません/);
  assert.match(html, /205\.35/);
  assert.match(html, /optionseducation\.org/);
  assert.doesNotMatch(html, /68%|95%|予想上限|最悪の下値/);
});
