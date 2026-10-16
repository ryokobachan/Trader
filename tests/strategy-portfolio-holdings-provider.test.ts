import assert from "node:assert/strict";
import test from "node:test";

import {
  derivePortfolioHoldingLots,
  type StrategyHoldingTransaction,
} from "../src/app/features/strategy/transaction-holdings";

function transaction(
  input: Partial<StrategyHoldingTransaction>
    & Pick<StrategyHoldingTransaction, "transactionId" | "date" | "symbol" | "side">,
): StrategyHoldingTransaction {
  return {
    shares: 1,
    price: 10,
    fee: 0,
    ...input,
  };
}

test("applies transactions by ascending date and transaction ID without mutating the ledger", () => {
  const ledger = [
    transaction({
      transactionId: "b-same-day-buy",
      date: "2026-01-02",
      symbol: "AAPL",
      side: "buy",
      shares: 5,
      price: 20,
      fee: 5,
    }),
    transaction({
      transactionId: "a-same-day-sell",
      date: "2026-01-02",
      symbol: "AAPL",
      side: "sell",
      shares: 10,
    }),
    transaction({
      transactionId: "initial-buy",
      date: "2026-01-01",
      symbol: "AAPL",
      side: "buy",
      shares: 10,
      price: 10,
    }),
  ] as const;
  const originalOrder = ledger.map(({ transactionId }) => transactionId);

  assert.deepEqual(derivePortfolioHoldingLots(ledger), [
    {
      ticker: "AAPL",
      shares: 5,
      average: 21,
      beta: null,
      rsi: null,
      performance1M: null,
      technicalRating: null,
    },
  ]);
  assert.deepEqual(ledger.map(({ transactionId }) => transactionId), originalOrder);
});

test("closes a same-day lot when createdAt places the buy before the sell", () => {
  const holdings = derivePortfolioHoldingLots([
    transaction({
      transactionId: "a-sell-id-sorts-first",
      date: "2026-01-02",
      createdAt: "2026-01-02T10:00:00.000Z",
      symbol: "AAPL",
      side: "sell",
      shares: 5,
    }),
    transaction({
      transactionId: "z-buy-id-sorts-last",
      date: "2026-01-02",
      createdAt: "2026-01-02T09:00:00.000Z",
      symbol: "AAPL",
      side: "buy",
      shares: 5,
      price: 100,
      fee: 5,
    }),
  ], { includeClosed: true });

  assert.equal(holdings[0]?.shares, 0);
  assert.equal(holdings[0]?.average, 101);
});

test("reopens a same-day lot when createdAt places the sell before the buy", () => {
  const holdings = derivePortfolioHoldingLots([
    transaction({
      transactionId: "initial-buy",
      date: "2026-01-01",
      createdAt: "2026-01-01T09:00:00.000Z",
      symbol: "MSFT",
      side: "buy",
      shares: 5,
      price: 100,
    }),
    transaction({
      transactionId: "a-buy-id-sorts-first",
      date: "2026-01-02",
      createdAt: "2026-01-02T10:00:00.000Z",
      symbol: "MSFT",
      side: "buy",
      shares: 2,
      price: 200,
      fee: 2,
    }),
    transaction({
      transactionId: "z-sell-id-sorts-last",
      date: "2026-01-02",
      createdAt: "2026-01-02T09:00:00.000Z",
      symbol: "MSFT",
      side: "sell",
      shares: 5,
    }),
  ]);

  assert.equal(holdings[0]?.shares, 2);
  assert.equal(holdings[0]?.average, 201);
});

test("includes buy fees in moving average cost and preserves it across a partial sale", () => {
  const holdings = derivePortfolioHoldingLots([
    transaction({
      transactionId: "buy-1",
      date: "2026-01-01",
      symbol: "MSFT",
      side: "buy",
      shares: 10,
      price: 100,
      fee: 10,
    }),
    transaction({
      transactionId: "buy-2",
      date: "2026-01-02",
      symbol: "MSFT",
      side: "buy",
      shares: 10,
      price: 200,
    }),
    transaction({
      transactionId: "dividend",
      date: "2026-01-03",
      symbol: "MSFT",
      side: "dividend",
      shares: 999,
      price: 5,
    }),
    transaction({
      transactionId: "sell",
      date: "2026-01-04",
      symbol: "MSFT",
      side: "sell",
      shares: 5,
      price: 300,
      fee: 100,
    }),
  ]);

  assert.equal(holdings[0]?.shares, 15);
  assert.equal(holdings[0]?.average, 150.5);
});

test("omits closed lots by default and can include them explicitly", () => {
  const ledger = [
    transaction({
      transactionId: "buy",
      date: "2026-01-01",
      symbol: "NVDA",
      side: "buy",
      shares: 3,
      price: 100,
      fee: 3,
    }),
    transaction({
      transactionId: "sell",
      date: "2026-01-02",
      symbol: "NVDA",
      side: "sell",
      shares: 3,
    }),
  ];

  assert.deepEqual(derivePortfolioHoldingLots(ledger), []);
  assert.deepEqual(derivePortfolioHoldingLots(ledger, { includeClosed: true }), [
    {
      ticker: "NVDA",
      shares: 0,
      average: 101,
      beta: null,
      rsi: null,
      performance1M: null,
      technicalRating: null,
    },
  ]);
});

test("resets acquisition cost when a previously closed lot is reopened", () => {
  const holdings = derivePortfolioHoldingLots([
    transaction({
      transactionId: "old-buy",
      date: "2026-01-01",
      symbol: "NVDA",
      side: "buy",
      shares: 2,
      price: 100,
      fee: 2,
    }),
    transaction({
      transactionId: "close",
      date: "2026-01-02",
      symbol: "NVDA",
      side: "sell",
      shares: 2,
    }),
    transaction({
      transactionId: "new-buy",
      date: "2026-01-03",
      symbol: "NVDA",
      side: "buy",
      shares: 4,
      price: 50,
      fee: 4,
    }),
  ]);

  assert.equal(holdings[0]?.shares, 4);
  assert.equal(holdings[0]?.average, 51);
});

test("clamps oversold and floating-point-close lots without carrying a short position", () => {
  const holdings = derivePortfolioHoldingLots([
    transaction({
      transactionId: "fractional-buy",
      date: "2026-01-01",
      symbol: "AAPL",
      side: "buy",
      shares: 0.3,
    }),
    transaction({
      transactionId: "fractional-sell-1",
      date: "2026-01-02",
      symbol: "AAPL",
      side: "sell",
      shares: 0.1,
    }),
    transaction({
      transactionId: "fractional-sell-2",
      date: "2026-01-03",
      symbol: "AAPL",
      side: "sell",
      shares: 0.2,
    }),
    transaction({
      transactionId: "oversell-without-position",
      date: "2026-01-01",
      symbol: "TSLA",
      side: "sell",
      shares: 100,
    }),
    transaction({
      transactionId: "fresh-buy-after-oversell",
      date: "2026-01-02",
      symbol: "TSLA",
      side: "buy",
      shares: 2,
      price: 40,
      fee: 2,
    }),
  ]);

  assert.deepEqual(holdings.map(({ ticker, shares, average }) => ({ ticker, shares, average })), [
    { ticker: "TSLA", shares: 2, average: 41 },
  ]);
});

test("does not invent analytical metrics for derived holdings", () => {
  const holdings = derivePortfolioHoldingLots([
    transaction({
      transactionId: "buy",
      date: "2026-01-01",
      symbol: "GOOGL",
      side: "buy",
    }),
  ]);

  assert.deepEqual(holdings[0], {
    ticker: "GOOGL",
    shares: 1,
    average: 10,
    beta: null,
    rsi: null,
    performance1M: null,
    technicalRating: null,
  });
});
