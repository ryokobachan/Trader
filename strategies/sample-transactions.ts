/**
 * Explicit public demo fixture. Reads never install these rows automatically.
 * Transactions created in the UI or CLI stay in D1 and are never written back
 * into this source file.
 */
export const SAMPLE_STRATEGY_TRANSACTIONS = [
  { date: "2026-08-07", symbol: "NVDA", side: "buy", shares: 40, price: 178.22, fee: 0 },
  { date: "2026-08-05", symbol: "AAPL", side: "buy", shares: 25, price: 226.04, fee: 0 },
  { date: "2026-08-01", symbol: "MSFT", side: "dividend", shares: 92, price: 0.83, fee: 0 },
  { date: "2026-07-28", symbol: "TSLA", side: "sell", shares: 18, price: 318.12, fee: 1.25 },
  { date: "2026-07-18", symbol: "AAPL", side: "dividend", shares: 210, price: 0.26, fee: 0 },
] as const;
