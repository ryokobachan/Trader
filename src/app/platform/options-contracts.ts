export type OptionContractQuote = Readonly<{
  contractId: string;
  side: "call" | "put";
  expiration: string;
  strike: number;
  last?: number;
  bid?: number;
  ask?: number;
  change?: number;
  volume?: number;
  openInterest?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}>;

export type OptionsChainSnapshot = Readonly<{
  symbol: string;
  currency: "USD";
  expiration: string | null;
  expirations: readonly string[];
  range: "near" | "all";
  contracts: readonly OptionContractQuote[];
  source: "Nasdaq";
  sourceUrl: string;
  greeksSourceUrl: string;
  fetchedAt: string;
  /** Kept separate from retrieval time and the underlying stock's last trade. */
  optionQuoteAsOf?: string;
  underlyingPrice?: number;
  underlyingAsOf?: string;
  isStale?: boolean;
  truncated: boolean;
  /** Coverage of the selected expiration and near/all filter, not a forecast price range. */
  coverage?: Readonly<{
    strikeMin?: number;
    strikeMax?: number;
    strikeCount: number;
    contractCount: number;
    /** Nasdaq counts expiration-heading rows as well as paired call/put strike rows. */
    fetchedRows: number;
    sourceTotalRows?: number;
    /** All rows reported by Nasdaq for this expiration and range were retrieved. */
    complete: boolean;
  }>;
  greeksAvailable: boolean;
  /** Nasdaq currently returns unusable zero IV values; no IV is inferred. */
  impliedVolatilityAvailable: false;
}>;
