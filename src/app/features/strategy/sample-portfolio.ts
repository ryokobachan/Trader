export type PortfolioHoldingLot = Readonly<{
  ticker: string;
  shares: number;
  average: number;
  beta: number | null;
  rsi: number | null;
  performance1M: number | null;
  technicalRating: "強い買い" | "買い" | "中立" | "売り" | "強い売り" | null;
}>;

export type SamplePortfolioHolding = Readonly<PortfolioHoldingLot & {
  value: number;
  allocation: number;
  daily: number;
  unrealized: number;
}>;

/** Illustrative holdings used only by the built-in sample strategy screens. */
export const SAMPLE_PORTFOLIO_HOLDINGS: readonly SamplePortfolioHolding[] = Object.freeze([
  { ticker: "NVDA", shares: 320, average: 142.18, value: 58486, allocation: 23.5, daily: 2.31, unrealized: 12989, beta: 1.66, rsi: 64.2, performance1M: 12.8, technicalRating: "強い買い" },
  { ticker: "AAPL", shares: 210, average: 198.74, value: 48596, allocation: 19.5, daily: 1.84, unrealized: 6861, beta: 1.18, rsi: 58.7, performance1M: 7.4, technicalRating: "買い" },
  { ticker: "MSFT", shares: 92, average: 421.1, value: 47590, allocation: 19.1, daily: 0.72, unrealized: 8849, beta: 0.94, rsi: 55.1, performance1M: 4.9, technicalRating: "買い" },
  { ticker: "TSLA", shares: 118, average: 289.43, value: 40078, allocation: 16.1, daily: -1.47, unrealized: 5925, beta: 2.14, rsi: 47.8, performance1M: -3.6, technicalRating: "中立" },
]);

const AAPL_ONLY_HOLDINGS = Object.freeze(
  SAMPLE_PORTFOLIO_HOLDINGS.filter((holding) => holding.ticker === "AAPL"),
);

/**
 * Return only the illustrative lots that belong to a visible built-in sample.
 * Unknown/custom strategies intentionally receive no fabricated holdings.
 */
export function samplePortfolioHoldingsForStrategy(
  strategyId: string,
): readonly SamplePortfolioHolding[] {
  if (strategyId === "sample.aapl-sma-50-200.v1") return AAPL_ONLY_HOLDINGS;
  if (
    strategyId === "sample.tech-leaders-equal-weight.v1"
    || strategyId === "sample.rsi-14-mean-reversion.v1"
  ) return SAMPLE_PORTFOLIO_HOLDINGS;
  return Object.freeze([]);
}
