export const PROVIDER_SCHEMA_VERSION = "unicorn.provider.v1" as const;
export const SYMBOL_SUMMARY_SCHEMA_VERSION = "unicorn.symbol-summary.v1" as const;
export const INSTRUMENT_SEARCH_SCHEMA_VERSION = "unicorn.instrument-search.v1" as const;
export const MARKET_BARS_SCHEMA_VERSION = "unicorn.market-bars.v1" as const;
export const MIN_MARKET_BAR_COUNT = 2 as const;
export const MAX_MARKET_BAR_COUNT = 10_000 as const;
export const SYMBOL_WORKSPACE_SCHEMA_VERSION = "unicorn.symbol-workspace.v1" as const;
export const ANALYST_RATING_HISTORY_SCHEMA_VERSION = "unicorn.analyst-rating-history.v1" as const;
export const WATCHLIST_AFTER_HOURS_SCHEMA_VERSION = "unicorn.watchlist-after-hours.v1" as const;
export const WATCHLIST_AFTER_HOURS_MAX_SYMBOLS = 50 as const;
export const WATCHLIST_QUOTES_SCHEMA_VERSION = "unicorn.watchlist-quotes.v1" as const;
export const WATCHLIST_QUOTES_MAX_SYMBOLS = 50 as const;

export const PROVIDER_CAPABILITIES = [
  "instrument.search",
  "instrument.identity",
  "market.quote",
  "market.bars",
  "market.synthetic_latest_close",
  "fundamentals.profile",
  "fundamentals.normalized",
  "fundamentals.earnings",
  "analyst.consensus",
  "analyst.ratings",
  "news.company",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];
export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export type ProviderManifest = Readonly<{
  schemaVersion: typeof PROVIDER_SCHEMA_VERSION;
  id: string;
  version: string;
  displayName: string;
  capabilities: readonly ProviderCapability[];
  markets: readonly "US"[];
  assetTypes: readonly ("common_stock" | "adr")[];
  requiredEnv: readonly string[];
}>;

export type DataProvenance = Readonly<{
  providerId: string;
  sourceId: string;
  asOf: string;
  ingestedAt: string;
  sourceUrl?: string;
  isStale?: boolean;
}>;

export type Instrument = Readonly<{
  instrumentId: string;
  symbol: string;
  name: string;
  assetType: "common_stock" | "adr";
  active: boolean;
  listingCountry: "US";
  exchange: string;
  exchangeMic: string;
  currency: "USD";
  sector?: string;
  industry?: string;
  /** Deployment-allowed HTTPS company-logo URL. */
  logoPath?: string;
  provenance: DataProvenance;
}>;

export type MarketSessionState = "pre_market" | "regular" | "after_hours" | "closed";

export type Quote = Readonly<{
  instrumentId: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  marketCap?: number;
  currency: "USD";
  marketState: MarketSessionState;
  delaySeconds: number;
  provenance: DataProvenance;
}>;

export type MarketBarInterval =
  | "1m"
  | "5m"
  | "15m"
  | "1h"
  | "4h"
  | "1d"
  | "1wk"
  | "1mo";
export type MarketBarRange = "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y" | "5y";

/**
 * Canonical chart-history request. `count` stays optional for external clients,
 * while Unicorn's chart shell explicitly requests the user's validated
 * candle-count preference (default 1,000, maximum `MAX_MARKET_BAR_COUNT`).
 * Other callers may request any supported window.
 */
export type MarketBarsRequest = Readonly<{
  range: MarketBarRange;
  interval: MarketBarInterval;
  count?: number;
}>;

export type MarketBar = Readonly<{
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjustedClose?: number;
}>;

export type MarketBars = Readonly<{
  instrumentId: string;
  interval: MarketBarInterval;
  range: MarketBarRange;
  adjustment: "raw" | "split_adjusted" | "split_and_dividend_adjusted";
  items: readonly MarketBar[];
  /** Effective upstream request size when the provider exposes it. */
  requestedCount?: number;
  /** Number of rows carried by this canonical bars value. */
  returnedCount?: number;
  provenance: DataProvenance;
}>;

/** Latest one-minute close for the configured ticker-derived reference market. */
export type SyntheticLatestClose = Readonly<{
  /** Canonical U.S.-equity ticker supplied by the watchlist. */
  symbol: string;
  /** Exact resolved upstream identifier, for example `BITGET:OKLOUSDT.P`. */
  sourceSymbol: string;
  /** Null means none of the configured source candidates returned a usable bar. */
  close: number | null;
  currency: "USDT";
  source: string;
  /** Upstream bar timestamp; null when `close` is null. */
  updatedAt: string | null;
}>;

export type CompanyProfile = Readonly<{
  instrumentId: string;
  description?: string;
  website?: string;
  sector?: string;
  industry?: string;
  country?: string;
  city?: string;
  employees?: number;
  /** Canonical company-logo candidate; the UI applies its final URL allow-list. */
  logoUrl?: string;
  beta?: number;
  marketCap?: number;
  ipoDate?: string;
  provenance: DataProvenance;
}>;

export type FundamentalsSnapshot = Readonly<{
  instrumentId: string;
  currency: "USD";
  /** Provider reporting period or latest field-as-of date. */
  period?: string;
  /** Monetary totals are expressed in `currency`; per-share fields are USD/share. */
  revenue?: number;
  /** Growth, margin, return, and yield fields use decimal fractions (`0.15` = 15%). */
  revenueGrowth?: number;
  grossProfit?: number;
  operatingIncome?: number;
  ebitda?: number;
  netIncome?: number;
  eps?: number;
  epsGrowth?: number;
  /** Valuation multiples are expressed as ratios, except monetary enterprise value. */
  enterpriseValue?: number;
  trailingPe?: number;
  forwardPe?: number;
  pegRatio?: number;
  priceToBook?: number;
  priceToSales?: number;
  priceToFreeCashFlow?: number;
  enterpriseValueToRevenue?: number;
  enterpriseValueToEbitda?: number;
  earningsYield?: number;
  /** Profitability, efficiency, leverage, and liquidity ratios. */
  roe?: number;
  roa?: number;
  roic?: number;
  grossMargin?: number;
  operatingMargin?: number;
  ebitdaMargin?: number;
  netMargin?: number;
  freeCashFlowMargin?: number;
  assetTurnover?: number;
  interestCoverage?: number;
  /** Latest reported balance-sheet monetary totals. */
  cashAndShortTermInvestments?: number;
  totalAssets?: number;
  totalDebt?: number;
  netDebt?: number;
  shareholdersEquity?: number;
  /** Dividend values and cash-flow monetary totals. */
  dividendYield?: number;
  dividendPerShare?: number;
  payoutRatio?: number;
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  freeCashFlow?: number;
  freeCashFlowYield?: number;
  debtToEquity?: number;
  currentRatio?: number;
  quickRatio?: number;
  cashRatio?: number;
  /** Size-independent per-share values, expressed in USD/share. */
  revenuePerShare?: number;
  bookValuePerShare?: number;
  operatingCashFlowPerShare?: number;
  freeCashFlowPerShare?: number;
  provenance: DataProvenance;
}>;

export type EarningsEvent = Readonly<{
  reportDate: string;
  fiscalDateEnding?: string;
  epsActual?: number;
  epsEstimate?: number;
  revenueActual?: number;
  revenueEstimate?: number;
  provenance: DataProvenance;
}>;

export type AnalystConsensus = Readonly<{
  instrumentId: string;
  targetLow?: number;
  targetHigh?: number;
  targetConsensus?: number;
  targetMedian?: number;
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
  analystCount?: number;
  forwardEps?: number;
  forwardRevenue?: number;
  provenance: DataProvenance;
}>;

/**
 * One normalized analyst-rating event. The field names intentionally mirror
 * the durable Midas event model without exposing a provider response body.
 */
export type AnalystRatingEvent = Readonly<{
  eventId: string;
  instrumentId: string;
  symbol: string;
  companyName?: string;
  exchange?: string;
  currency?: string;
  cusip?: string;
  isin?: string;
  analystFirm?: string;
  analystName?: string;
  analystId?: string;
  firmId?: string;
  action?: string;
  actionCompany?: string;
  actionPriceTarget?: string;
  rating?: string;
  ratingCurrent?: string;
  ratingPrior?: string;
  priceTarget?: number;
  previousPriceTarget?: number;
  adjustedPriceTarget?: number;
  adjustedPreviousPriceTarget?: number;
  /** Adjusted target when supplied by the provider, otherwise priceTarget. */
  effectivePriceTarget?: number;
  priceTargetPercentChange?: number;
  importance?: number;
  smartScore?: number;
  overallSuccessRate?: number;
  totalRatings?: number;
  sourceEventDate: string;
  eventTime: string;
  updatedAt?: string;
}>;

export type AnalystRatingHistoryRequest = Readonly<{
  dateFrom: string;
  dateTo: string;
  pageSize?: number;
}>;

export type AnalystRatingHistory = Readonly<{
  instrumentId: string;
  symbol: string;
  dateFrom: string;
  dateTo: string;
  pageSize: number;
  items: readonly AnalystRatingEvent[];
  provenance: DataProvenance;
}>;

export type CompanyNewsItem = Readonly<{
  id: string;
  instrumentId: string;
  title: string;
  summary?: string;
  url: string;
  publisher: string;
  publishedAt: string;
  imageUrl?: string;
  provenance: DataProvenance;
}>;

export type InstrumentSearchRequest = Readonly<{
  query: string;
  limit?: number;
}>;

export type ProviderRequestContext = Readonly<{
  requestId: string;
  asOf?: string;
}>;

export interface InstrumentProvider {
  searchUSStocks(
    request: InstrumentSearchRequest,
    context: ProviderRequestContext,
  ): Promise<readonly Instrument[]>;
  getUSStockBySymbol(
    symbol: string,
    context: ProviderRequestContext,
  ): Promise<Instrument | null>;
}

export interface MarketDataProvider {
  getQuote(
    instrument: Instrument,
    context: ProviderRequestContext,
  ): Promise<Quote | null>;
  getBars?(
    instrument: Instrument,
    request: MarketBarsRequest,
    context: ProviderRequestContext,
  ): Promise<MarketBars | null>;
}

export interface SyntheticMarketDataProvider {
  getLatestCloses(
    symbols: readonly string[],
    context: ProviderRequestContext,
  ): Promise<readonly SyntheticLatestClose[]>;
}

export interface FundamentalsProvider {
  getProfile(
    instrument: Instrument,
    context: ProviderRequestContext,
  ): Promise<CompanyProfile | null>;
  getFundamentals(
    instrument: Instrument,
    context: ProviderRequestContext,
  ): Promise<FundamentalsSnapshot | null>;
  getEarnings(
    instrument: Instrument,
    context: ProviderRequestContext,
  ): Promise<readonly EarningsEvent[]>;
}

export interface AnalystProvider {
  getConsensus(
    instrument: Instrument,
    context: ProviderRequestContext,
  ): Promise<AnalystConsensus | null>;
  getRatingHistory?(
    instrument: Instrument,
    request: AnalystRatingHistoryRequest,
    context: ProviderRequestContext,
  ): Promise<AnalystRatingHistory>;
}

export interface NewsProvider {
  getCompanyNews(
    instrument: Instrument,
    context: ProviderRequestContext,
  ): Promise<readonly CompanyNewsItem[]>;
}

export type ProviderAdapter = Readonly<{
  manifest: ProviderManifest;
  instrument?: InstrumentProvider;
  market?: MarketDataProvider;
  syntheticMarket?: SyntheticMarketDataProvider;
  fundamentals?: FundamentalsProvider;
  analyst?: AnalystProvider;
  news?: NewsProvider;
}>;

export type ProviderRegistration = Readonly<{
  manifest: ProviderManifest;
  create: (env: ProviderEnvironment) => ProviderAdapter;
}>;

export type SymbolSummary = Readonly<{
  schemaVersion: typeof SYMBOL_SUMMARY_SCHEMA_VERSION;
  instrument: Instrument;
  quote: Quote;
  selectedProviders: Readonly<{
    instrument: string;
    market: string;
  }>;
  asOf: string;
}>;

export type InstrumentSearchResponse = Readonly<{
  schemaVersion: typeof INSTRUMENT_SEARCH_SCHEMA_VERSION;
  query: string;
  items: readonly Instrument[];
  selectedProvider: string;
  dataMode: "fixture" | "provider";
  scope: Readonly<{
    market: "US";
    activeOnly: true;
    assetTypes: readonly ["common_stock", "adr"];
  }>;
}>;

export type MarketBarsResponse = Readonly<{
  schemaVersion: typeof MARKET_BARS_SCHEMA_VERSION;
  instrument: Instrument;
  bars: MarketBars;
  /** Explicit client count, or the provider's effective default when known. */
  requestedCount: number | null;
  /** Number of canonical bars actually returned in this response. */
  returnedCount: number;
  selectedProviders: Readonly<{
    instrument: string;
    market: string;
  }>;
  dataMode: "fixture" | "provider";
  asOf: string;
}>;

export type AnalystRatingHistoryResponse = Readonly<{
  schemaVersion: typeof ANALYST_RATING_HISTORY_SCHEMA_VERSION;
  instrument: Instrument;
  history: AnalystRatingHistory;
  selectedProviders: Readonly<{
    instrument: string;
    analyst: string;
  }>;
  dataMode: "fixture" | "provider";
  asOf: string;
}>;

export type WatchlistAfterHoursResponse = Readonly<{
  schemaVersion: typeof WATCHLIST_AFTER_HOURS_SCHEMA_VERSION;
  /** First exchange in the ordered resolution list; retained for v1 clients. */
  exchange: string;
  /** Ordered source-exchange candidates used to resolve each ticker. */
  exchanges?: readonly string[];
  items: readonly SyntheticLatestClose[];
  selectedProvider: string;
  asOf: string;
}>;

export type WatchlistQuoteItem = Readonly<{
  symbol: string;
  /** Null when the requested ticker is not a supported active U.S. equity. */
  instrument: Instrument | null;
  /** Null when no strictly positive, finite current quote is available. */
  quote: Quote | null;
}>;

export type WatchlistQuotesResponse = Readonly<{
  schemaVersion: typeof WATCHLIST_QUOTES_SCHEMA_VERSION;
  items: readonly WatchlistQuoteItem[];
  selectedProviders: Readonly<{
    instrument: string;
    market: string;
  }>;
  asOf: string;
}>;

export type SymbolWorkspace = Readonly<{
  schemaVersion: typeof SYMBOL_WORKSPACE_SCHEMA_VERSION;
  instrument: Instrument;
  quote: Quote;
  profile: CompanyProfile | null;
  fundamentals: FundamentalsSnapshot | null;
  earnings: readonly EarningsEvent[];
  analyst: AnalystConsensus | null;
  news: readonly CompanyNewsItem[];
  selectedProviders: Readonly<{
    instrument: string;
    market: string;
    profile?: string;
    fundamentals?: string;
    earnings?: string;
    analyst?: string;
    news?: string;
  }>;
  dataMode: "fixture" | "provider";
  status: "complete" | "partial";
  warnings: readonly string[];
  asOf: string;
}>;
