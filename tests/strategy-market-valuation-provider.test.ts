import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  markSamplePortfolio,
  strategyMarketMark,
  type StrategyMarketMark,
} from "../src/app/features/strategy/market-valuation";
import type {
  MarketBar,
  MarketSessionState,
  Quote,
} from "../src/app/platform/provider-contracts";
import { samplePortfolioHoldingsForStrategy } from "../src/app/features/strategy/sample-portfolio";

function quote(marketState: MarketSessionState): Quote {
  return {
    instrumentId: "us-stock:AAPL",
    price: 250,
    change: 40,
    changePercent: 19.05,
    previousClose: 210,
    open: 220,
    high: 252,
    low: 218,
    volume: 100,
    currency: "USD",
    marketState,
    delaySeconds: 0,
    provenance: {
      providerId: "test",
      sourceId: "direct-usd:AAPL",
      asOf: "2026-08-10T17:30:00Z",
      ingestedAt: "2026-08-10T17:30:01Z",
    },
  };
}

const DAILY_BARS: readonly MarketBar[] = [
  { time: "2026-08-07T20:00:00Z", open: 205, high: 213, low: 204, close: 210, volume: 10 },
  { time: "2026-08-10T20:00:00Z", open: 220, high: 244, low: 218, close: 240, volume: 12 },
];

test("marks regular-session holdings with the direct USD quote", () => {
  const mark = strategyMarketMark(quote("regular"), DAILY_BARS);
  assert.deepEqual(mark, {
    price: 250,
    changePercent: 19.05,
    asOf: "2026-08-10T17:30:00Z",
    source: "regular_quote",
  });
});

test("marks after-hours and closed sessions with the newest completed daily close", () => {
  for (const state of ["after_hours", "closed"] as const) {
    const mark = strategyMarketMark(quote(state), [DAILY_BARS[1]!, DAILY_BARS[0]!]);
    assert.equal(mark?.price, 240, state);
    assert.equal(mark?.source, "completed_daily_close", state);
    assert.equal(mark?.asOf, "2026-08-10T20:00:00Z", state);
    assert.ok(Math.abs((mark?.changePercent ?? 0) - (240 / 210 - 1) * 100) < 1e-10);
    assert.notEqual(mark?.price, quote(state).price, "extended-hours Quote.price must be ignored");
    assert.notEqual(mark?.price, quote(state).previousClose, "Quote.previousClose is not today's close");
  }
});

test("pre-market ignores an in-progress current-day daily bar", () => {
  const livePremarketQuote: Quote = {
    ...quote("pre_market"),
    price: 313.06,
    previousClose: 312.5,
    provenance: {
      ...quote("pre_market").provenance,
      asOf: "2026-08-10T13:30:00Z",
    },
  };
  const bars: readonly MarketBar[] = [
    { time: "2026-08-06T13:30:00Z", open: 307, high: 312, low: 306, close: 310, volume: 9 },
    { time: "2026-08-07T13:30:00Z", open: 310, high: 315, low: 309, close: 313.33, volume: 10 },
    { time: "2026-08-10T13:30:00Z", open: 313.06, high: 313.06, low: 313.06, close: 313.06, volume: 0 },
  ];
  const observedAt = new Date("2026-08-10T11:31:00Z");

  const mark = strategyMarketMark(livePremarketQuote, bars, { observedAt });
  assert.equal(mark?.price, 313.33);
  assert.equal(mark?.source, "completed_daily_close");
  assert.equal(mark?.asOf, "2026-08-07T13:30:00Z");
  assert.ok(Math.abs((mark?.changePercent ?? 0) - (313.33 / 310 - 1) * 100) < 1e-10);
  assert.equal(
    strategyMarketMark(null, bars, { observedAt })?.price,
    313.33,
    "without a quote, the current New York trading date must still be excluded before the open",
  );
});

test("pre-market treats UTC-midnight daily bars as their explicit session date", () => {
  const livePremarketQuote: Quote = {
    ...quote("pre_market"),
    price: 313.06,
    provenance: {
      ...quote("pre_market").provenance,
      asOf: "2026-08-10T12:00:00Z",
    },
  };
  const bars: readonly MarketBar[] = [
    { time: "2026-08-06T00:00:00.000Z", open: 307, high: 312, low: 306, close: 310, volume: 9 },
    { time: "2026-08-07T00:00:00.000Z", open: 310, high: 315, low: 309, close: 313.33, volume: 10 },
    { time: "2026-08-10T00:00:00.000Z", open: 313.06, high: 313.06, low: 313.06, close: 313.06, volume: 0 },
  ];

  const mark = strategyMarketMark(livePremarketQuote, bars, {
    observedAt: new Date("2026-08-10T12:05:00Z"),
  });

  assert.equal(mark?.price, 313.33);
  assert.equal(mark?.asOf, "2026-08-07T00:00:00.000Z");
  assert.ok(Math.abs((mark?.changePercent ?? 0) - (313.33 / 310 - 1) * 100) < 1e-10);
});

test("does not fall back to an extended-hours quote when daily bars are unavailable", () => {
  assert.equal(strategyMarketMark(quote("after_hours"), []), null);
  assert.equal(strategyMarketMark(quote("closed"), []), null);
});

test("revalues sample lots exactly without manufacturing performance metrics", () => {
  const marks: Readonly<Record<string, StrategyMarketMark>> = {
    AAPL: { price: 240, changePercent: 2, asOf: "2026-08-10T20:00:00Z", source: "completed_daily_close" },
    MSFT: { price: 500, changePercent: -1, asOf: "2026-08-10T20:00:00Z", source: "completed_daily_close" },
  };
  const portfolio = markSamplePortfolio([
    { ticker: "AAPL", shares: 10, average: 200, value: 0, allocation: 0, daily: 0, unrealized: 0, beta: 1, rsi: 50, performance1M: 0, technicalRating: "中立" },
    { ticker: "MSFT", shares: 2, average: 450, value: 0, allocation: 0, daily: 0, unrealized: 0, beta: 1, rsi: 50, performance1M: 0, technicalRating: "中立" },
  ], marks, 20);

  assert.equal(portfolio.complete, true);
  assert.equal(portfolio.holdingsValue, 3_400);
  assert.equal(portfolio.unrealizedGain, 500);
  assert.equal(portfolio.holdings[0]?.value, 2_400);
  assert.equal(portfolio.holdings[0]?.unrealized, 400);
  assert.ok(Math.abs((portfolio.holdings[0]?.allocation ?? 0) - 2_400 / 3_400 * 80) < 1e-10);
});

test("does not attach the shared four-stock fixture to unrelated strategies", () => {
  assert.deepEqual(
    samplePortfolioHoldingsForStrategy("sample.aapl-sma-50-200.v1").map(({ ticker }) => ticker),
    ["AAPL"],
  );
  assert.equal(samplePortfolioHoldingsForStrategy("custom.agent-strategy.v1").length, 0);
});

test("StrategyHome loads direct quotes and daily bars without the USDT after-hours route", async () => {
  const source = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const strategyStart = source.indexOf("function StrategyHome(");
  const strategyEnd = source.indexOf("function WatchlistPanel(", strategyStart);
  const strategySource = source.slice(strategyStart, strategyEnd);

  assert.match(strategySource, /fetch\(`\/api\/v1\/watchlists\/quotes\$\{strategyRefreshVersion > 0 \? "\?fresh=1" : ""\}`/);
  assert.match(strategySource, /bars\?range=5d&interval=1d&count=3/);
  assert.match(strategySource, /Promise\.all\(\[quoteRequest, barsRequest\]\)/);
  assert.match(strategySource, /quoteResult\.payload\?\.dataMode === "provider"/);
  assert.match(strategySource, /payload\.dataMode === "provider" \? payload\.bars\.items : \[\]/);
  assert.doesNotMatch(strategySource, /watchlists\/after-hours|USDT|afterHoursBySymbol/);
  assert.match(strategySource, /return markedPortfolio\.complete/);
  assert.doesNotMatch(
    strategySource,
    /PORTFOLIO_HOLDINGS\.reduce\(\(sum, holding\) => sum \+ holding\.unrealized/,
  );
});
