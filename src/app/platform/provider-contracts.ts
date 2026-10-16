export const PROVIDER_SCHEMA_VERSION = "trader.provider.v1" as const;
export const SYMBOL_SUMMARY_SCHEMA_VERSION = "trader.symbol-summary.v1" as const;
export const INSTRUMENT_SEARCH_SCHEMA_VERSION = "trader.instrument-search.v1" as const;
export const MARKET_BARS_SCHEMA_VERSION = "trader.market-bars.v1" as const;
export const MIN_MARKET_BAR_COUNT = 2 as const;
export const MAX_MARKET_BAR_COUNT = 10_000 as const;
export const SYMBOL_WORKSPACE_SCHEMA_VERSION = "trader.symbol-workspace.v1" as const;
export const ANALYST_RATING_HISTORY_SCHEMA_VERSION = "trader.analyst-rating-history.v1" as const;
export const WATCHLIST_AFTER_HOURS_SCHEMA_VERSION = "trader.watchlist-after-hours.v1" as const;
export const WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION = "trader.watchlist-after-hours-stream.v1" as const;
export const WATCHLIST_AFTER_HOURS_POLL_SCHEMA_VERSION = "trader.watchlist-after-hours-poll.v1" as const;
export const WATCHLIST_AFTER_HOURS_MAX_SYMBOLS = 50 as const;
export const WATCHLIST_QUOTES_SCHEMA_VERSION = "trader.watchlist-quotes.v1" as const;
export const WATCHLIST_QUOTES_MAX_SYMBOLS = 50 as const;
export const WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION = "trader.watchlist-quote-stream.v1" as const;

export const PROVIDER_CAPABILITIES = [
  "instrument.search",
  "instrument.identity",
  "market.quote",
  "market.bars",
  "market.synthetic_latest_close",
  "fundamentals.profile",
  "fundamentals.normalized",
  "fundamentals.earnings",
  "fundamentals.research",
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
 * while Trader's chart shell explicitly requests the user's validated
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

/**
 * A continuous USDT perpetual tick must be no more than five minutes old to
 * be presented as current. Exactly five minutes remains usable; one
 * millisecond beyond the boundary does not.
 */
export const SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS = 5 * 60_000;
export const SYNTHETIC_LATEST_CLOSE_FUTURE_SKEW_MS = 60_000;

/** Latest price for the configured ticker-derived perpetual reference market. */
export type SyntheticLatestClose = Readonly<{
  /** Canonical U.S.-equity ticker supplied by the watchlist. */
  symbol: string;
  /** Exact resolved upstream identifier, for example `BITGET:OKLOUSDT.P`. */
  sourceSymbol: string;
  /** Null means no configured source returned a present, sufficiently fresh tick. */
  close: number | null;
  currency: "USDT";
  source: string;
  /** Upstream bar timestamp; null when `close` is null. */
  updatedAt: string | null;
}>;

/** Strict display boundary for ticker-derived continuous USDT perpetuals. */
export function isFreshSyntheticLatestClose(
  item: SyntheticLatestClose | null | undefined,
  observedAtMilliseconds = Date.now(),
  maximumAgeMilliseconds = SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS,
): item is SyntheticLatestClose & Readonly<{ close: number; updatedAt: string }> {
  if (
    !item
    || item.currency !== "USDT"
    || item.source !== "tradingview-websocket"
    || typeof item.close !== "number"
    || !Number.isFinite(item.close)
    || item.close <= 0
    || typeof item.updatedAt !== "string"
    || !Number.isFinite(observedAtMilliseconds)
    || !Number.isFinite(maximumAgeMilliseconds)
    || maximumAgeMilliseconds < 0
  ) return false;
  const updatedAtMilliseconds = Date.parse(item.updatedAt);
  if (!Number.isFinite(updatedAtMilliseconds)) return false;
  const ageMilliseconds = observedAtMilliseconds - updatedAtMilliseconds;
  return ageMilliseconds >= -SYNTHETIC_LATEST_CLOSE_FUTURE_SKEW_MS
    && ageMilliseconds <= maximumAgeMilliseconds;
}

export type CompanyProfile = Readonly<{
  localized?: Readonly<{ ja?: Readonly<{
    description?: string;
    descriptionProvenance?: DataProvenance;
    sector?: string;
    industry?: string;
    provenance: DataProvenance;
  }> }>;
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

export type ShareStructureSnapshot = Readonly<{
  /** Fraction of outstanding shares in the public float (`0.75` = 75%). */
  freeFloatRatio?: number;
  floatShares?: number;
  outstandingShares?: number;
  provenance: DataProvenance;
}>;

export type FinancialHealthSnapshot = Readonly<{
  altmanZScore?: number;
  altmanZScorePeriod?: string;
  /** Integer score in the canonical 0–9 range. */
  piotroskiScore?: number;
  piotroskiScorePeriod?: string;
  provenance: DataProvenance;
}>;

/** A source-labelled fiscal period; no dates are inferred from array positions. */
export type FinancialStatementPeriod = Readonly<{
  period: string;
  fiscalDateEnding?: string;
  currency: "USD";
  revenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  ebitda?: number;
  netIncome?: number;
  eps?: number;
  researchAndDevelopment?: number;
  sellingGeneralAndAdministrative?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  totalDebt?: number;
  netDebt?: number;
  shareholdersEquity?: number;
  cashAndShortTermInvestments?: number;
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  freeCashFlow?: number;
  investingCashFlow?: number;
  financingCashFlow?: number;
  provenance: DataProvenance;
}>;

/** Fiscal forecasts have a fiscal period, not an invented earnings release date. */
export type FundamentalFiscalForecast = Readonly<{
  period: string;
  reported: boolean;
  epsActual?: number;
  epsEstimate?: number;
  revenueActual?: number;
  revenueEstimate?: number;
  provenance: DataProvenance;
}>;

export type OwnershipSnapshot = Readonly<{
  /** Fractional ownership and short-interest percentages (0.2 = 20%). */
  insiderOwnership?: number;
  institutionalOwnership?: number;
  sharesShort?: number;
  sharesShortPriorMonth?: number;
  shortFloatRatio?: number;
  shortOutstandingRatio?: number;
  shortRatio?: number;
  shortInterestDate?: string;
  provenance: DataProvenance;
}>;

export type CorporateAction = Readonly<{
  id: string;
  type: "dividend" | "split";
  /** Source event date; dividends use the ex-dividend date. */
  date: string;
  amount?: number;
  currency?: "USD";
  numerator?: number;
  denominator?: number;
  provenance: DataProvenance;
}>;

export type CompanyResearch = Readonly<{
  instrumentId: string;
  ownership?: OwnershipSnapshot;
  quarterlyFinancials?: readonly FinancialStatementPeriod[];
  /** Annual CF retains its own fiscal periods and source. */
  annualCashFlows?: readonly FinancialStatementPeriod[];
  corporateActions: readonly CorporateAction[];
  /** Empty available datasets are distinct from failed upstream requests. */
  coverage: Readonly<{
    ownership: "available" | "unavailable";
    quarterlyFinancials: "available" | "unavailable";
    corporateActions: "available" | "unavailable";
  }>;
  provenance: DataProvenance;
}>;

export type FundamentalsSnapshot = Readonly<{
  valuationSources?: Readonly<Partial<Record<"trailingPe" | "forwardPe" | "pegRatio", Readonly<{
    provenance: DataProvenance;
    basis: "ttm" | "forward" | "growth-adjusted";
    status: "reported" | "calculated" | "not_reported";
    /** Explicit calculation inputs; no FY/TTM or adjusted/GAAP substitution. */
    calculation?: Readonly<{
      formula: string;
      inputs: Readonly<Record<string, number>>;
      earningsPeriod: "TTM" | "NTM";
      growthBasis?: "diluted-eps-ttm-yoy";
    }>;
  }>>>>;
  instrumentId: string;
  currency: "USD";
  /** Provider reporting period or latest field-as-of date. */
  period?: string;
  reportingBasis?: "annual" | "ttm";
  annualFinancials?: readonly FinancialStatementPeriod[];
  quarterlyFinancials?: readonly FinancialStatementPeriod[];
  fiscalForecasts?: readonly FundamentalFiscalForecast[];
  researchAndDevelopment?: number;
  sellingGeneralAndAdministrative?: number;
  totalLiabilities?: number;
  investingCashFlow?: number;
  financingCashFlow?: number;
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
  /** Supplemental datasets retain endpoint-level provenance and absence. */
  shareStructure?: ShareStructureSnapshot;
  financialHealth?: FinancialHealthSnapshot;
  provenance: DataProvenance;
}>;

export type EarningsEvent = Readonly<{
  reportDate: string;
  fiscalDateEnding?: string;
  fiscalPeriod?: string;
  epsBasis?: "earnings_display" | "statement";
  statementEPS?: number;
  epsActual?: number;
  epsEstimate?: number;
  revenueActual?: number;
  revenueEstimate?: number;
  provenance: DataProvenance;
}>;

export type AnalystRatingBucket = "strongBuy" | "buy" | "hold" | "sell" | "strongSell";

export type AnalystSourceCoverage = Readonly<{
  providerId: string;
  status: "available" | "unavailable";
  eventCount: number;
  firmCount: number;
  ratingCount: number;
  priceTargetCount: number;
  asOf?: string;
  dateFrom?: string;
  dateTo?: string;
  /** True when the upstream returned the configured maximum row count. */
  truncated?: boolean;
}>;

export type AnalystMergeCoverage = Readonly<{
  status: "complete" | "partial";
  /** True when the merged result itself was limited after source union/de-duplication. */
  truncated?: boolean;
  /** Firm-level consensus uses the latest observation in this calendar window. */
  lookbackMonths?: number;
  sources: readonly AnalystSourceCoverage[];
}>;

export type AnalystConsensusConstituent = Readonly<{
  /** Cross-provider stable firm identity used for de-duplication. */
  firmId: string;
  firm: string;
  analystName?: string;
  rating?: string;
  ratingBucket?: AnalystRatingBucket;
  priceTarget?: number;
  sourceEventDate: string;
  eventTime: string;
  /** Provider whose observation won the deterministic latest-event selection. */
  providerId: string;
  ratingProviderId?: string;
  priceTargetProviderId?: string;
  /** All providers that supplied an observation for this firm in the window. */
  sourceProviderIds: readonly string[];
  /** Same-day providers disagreed on one or more non-empty fields. */
  conflict?: boolean;
  conflictFields?: readonly ("rating" | "priceTarget")[];
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
  /** Backward-compatible alias of priceTargetCount for merged providers. */
  analystCount?: number;
  firmCount?: number;
  ratingCount?: number;
  priceTargetCount?: number;
  forwardEps?: number;
  forwardRevenue?: number;
  methodology?: "firm_latest_trailing_3_months";
  coverage?: AnalystMergeCoverage;
  sources?: readonly DataProvenance[];
  constituents?: readonly AnalystConsensusConstituent[];
  provenance: DataProvenance;
}>;

/**
 * One normalized analyst-rating event. The field names intentionally mirror
 * the durable Midas event model without exposing a provider response body.
 */
export type AnalystRatingEvent = Readonly<{
  eventId: string;
  instrumentId: string;
  providerId?: string;
  ratingProviderId?: string;
  priceTargetProviderId?: string;
  sourceProviderIds?: readonly string[];
  sourceConflict?: boolean;
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
  /** Cross-provider identity; provider-local firmId remains untouched. */
  canonicalFirmId?: string;
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
  /** TipRanks analyst credibility fields; distinct from a stock Smart Score. */
  analystStarRating?: number;
  analystRank?: number;
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
  /**
   * Provider-local firm/day operations retained for deterministic consensus
   * reconstruction. `items` remains the de-duplicated display history.
   */
  consensusItems?: readonly AnalystRatingEvent[];
  /** Rolling calendar window used when rebuilding this provider's consensus. */
  consensusLookbackMonths?: number;
  coverage?: AnalystMergeCoverage;
  sources?: readonly DataProvenance[];
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
  signal?: AbortSignal;
  /** Bypass provider-owned result caches for an explicit user refresh. */
  fresh?: boolean;
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
  getQuotes?(
    instruments: readonly Instrument[],
    context: ProviderRequestContext,
  ): Promise<readonly Quote[]>;
  getQuoteStream?(
    instruments: readonly Instrument[],
    context: ProviderRequestContext,
  ): Promise<ReadableStream<Quote>>;
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
  getLatestCloseStream?(
    symbols: readonly string[],
    context: ProviderRequestContext,
  ): Promise<ReadableStream<SyntheticLatestClose>>;
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
  getResearch?(
    instrument: Instrument,
    context: ProviderRequestContext,
    options?: Readonly<{ financialStatements?: boolean }>,
  ): Promise<CompanyResearch | null>;
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
  dataMode: "fixture" | "provider";
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
  /** False when this provider supports snapshot polling but no realtime transport. */
  streamSupported?: boolean;
  /** Present only when a configured sidecar exposes a realtime stream. */
  streamTransport?: "websocket" | "sse";
  /** A normal HTTPS request can wait server-side for the next TradingView tick. */
  longPollSupported?: boolean;
  asOf: string;
}>;

export type WatchlistAfterHoursPollCursor = Readonly<{
  symbol: string;
  sourceSymbol: string;
  close: number;
  updatedAt: string;
}>;

export type WatchlistAfterHoursPollResponse = Readonly<{
  schemaVersion: typeof WATCHLIST_AFTER_HOURS_POLL_SCHEMA_VERSION;
  items: readonly SyntheticLatestClose[];
  timedOut: boolean;
  asOf: string;
}>;

export type WatchlistAfterHoursStreamMessage = Readonly<{
  schemaVersion: typeof WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION;
  type: "quote";
  item: SyntheticLatestClose;
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
  /** Fixture responses must never be merged into live quote UI state. */
  dataMode: "fixture" | "provider";
  /** False when the selected market provider supports snapshots but not SSE. */
  streamSupported?: boolean;
  /** A normal HTTPS request can wait server-side for the next TradingView quote. */
  longPollSupported?: boolean;
  asOf: string;
}>;

export type WatchlistQuoteStreamMessage = Readonly<{
  schemaVersion: typeof WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION;
  type: "quote";
  symbol: string;
  quote: Quote;
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
  research?: CompanyResearch | null;
  selectedProviders: Readonly<{
    instrument: string;
    market: string;
    profile?: string;
    fundamentals?: string;
    earnings?: string;
    analyst?: string;
    news?: string;
    research?: string;
  }>;
  dataMode: "fixture" | "provider";
  status: "complete" | "partial";
  warnings: readonly string[];
  asOf: string;
}>;
