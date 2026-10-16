import { DIRECT_SOURCES } from "../../api/direct-sources/catalog";

export type DataParameter = Readonly<{
  type: "text" | "symbol" | "date" | "integer" | "choice" | "flag" | "datetime";
  description: string;
  required?: boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
  query?: string;
  pattern?: string;
  maxLength?: number;
}>;
export type DataDefinition = Readonly<{
  id: string;
  description: string;
  path: string;
  parameters: Readonly<Record<string, DataParameter>>;
  source: string;
  history: string;
  response: string;
  notes: readonly string[];
  fixedQuery?: Readonly<Record<string, string>>;
  credential?: string | null;
  deprecated?: boolean;
  replacement?: string;
  category?: DataCategory;
  subject?: DataSubject;
  timeShape?: string;
  backtest?: BacktestUse;
  metadataPaths?: Readonly<Record<string, readonly string[]>>;
}>;
export type DataCategory = "input" | "result" | "snapshot" | "metadata";
export type DataSubject = "symbol" | "macro" | "option-contract" | "institution" | "account" | "strategy" | "system";
export type BacktestUse = "usable" | "conditional" | "analysis-only" | "result-only" | "not-applicable";

const symbol: DataParameter = { type: "symbol", required: true, description: "US stock ticker, for example NBIS." };
const date = (description: string): DataParameter => ({ type: "date", description });
const text = (description: string): DataParameter => ({ type: "text", description });
const choice = (values: string[], description: string): DataParameter => ({ type: "choice", values, description });
const fresh: DataParameter = { type: "flag", description: "Ask the configured provider to refresh instead of using its memory cache." };
const workspaceNotes = ["Read status, warnings, coverage and per-section provenance; partial responses may omit data.", "Financial period ends are not publication timestamps. Current revisions are not a point-in-time archive."];

const sharedInputs: Readonly<Record<string, readonly string[]>> = {
  "institutional-filings": ["institution", "accession", "period", "from", "to", "asOf"],
  "institutional-holdings": ["institution", "accession", "period", "symbol", "from", "to", "asOf"],
  "institutional-managers": ["institution"],
  "x-posts": ["account", "symbol", "from", "to", "asOf"],
  "x-mentions": ["account", "symbol", "from", "to", "asOf"],
  "x-mention-outcomes": ["account", "symbol", "horizonDays", "strategy", "from", "to", "asOf"],
  "x-author-scores": ["account", "symbol", "horizonDays", "from", "to", "asOf"],
  "x-author-strategies": ["account", "horizonDays", "strategy", "from", "to", "asOf"],
  "x-accounts": ["account"],
  "x-prices": ["symbol", "from", "to", "asOf"],
};
export const SHARED_DATASET_IDS = Object.keys(sharedInputs);
function sharedParameters(id: string): Record<string, DataParameter> {
  const dateBasis = id.startsWith("institutional-") ? "filing_date" : id === "x-mention-outcomes" ? "entry_at" : id === "x-author-scores" || id === "x-author-strategies" ? "updated_at (current result version)" : id === "x-prices" ? "trade_date" : "published_at";
  const all: Record<string, DataParameter> = {
    symbol: { type: "symbol", pattern: "^[A-Z0-9.^:/_-]{1,32}$", required: id === "x-prices", description: "Stored instrument symbol; required for x-prices." },
    institution: { ...text("Institution SEC CIK (1–10 digits)."), pattern: "^[0-9]{1,10}$" },
    accession: { ...text("Exact SEC accession number."), pattern: "^[0-9]{10}-[0-9]{2}-[0-9]{6}$" },
    account: { ...text("X handle, with optional @."), pattern: "^@?[A-Za-z0-9_]{1,15}$" },
    period: date("Exact 13F report period end, YYYY-MM-DD; not publication date."),
    from: date(`Inclusive ${dateBasis} start date.`), to: date(`Inclusive ${dateBasis} end date.`),
    asOf: { type: "datetime", description: "Conservative known-at cutoff, zoned ISO datetime. Filters currently stored versions; does not reconstruct previous versions." },
    horizonDays: { type: "integer", min: 1, max: 366, description: "Exact recorded outcome horizon in days." },
    strategy: { ...text("Exact recorded strategy identifier."), pattern: "^[A-Za-z0-9_.:-]{1,120}$" },
  };
  return Object.fromEntries([...sharedInputs[id].map(key => [key, all[key]]),
    ["limit", { type: "integer", min: 1, max: 1000, description: "Page size, default 100; maximum 1000." }],
    ["cursor", { ...text("Opaque nextCursor from the same dataset/filter response."), pattern: "^[A-Za-z0-9_-]+$", maxLength: 2048 }],
  ]);
}

const DEFINITIONS: readonly DataDefinition[] = [
  {
    id: "quote", description: "Current stock quote and instrument identity.", path: "/api/v1/symbols/:symbol/summary",
    parameters: { symbol }, source: "Configured Trader instrument and market providers", history: "Current quote only",
    response: "Native SymbolSummary JSON: instrument, quote, selectedProviders, dataMode, asOf.", notes: ["dataMode=fixture is sample data, not a live observation."],
  },
  {
    id: "bars", description: "Stock OHLCV history.", path: "/api/v1/symbols/:symbol/bars",
    parameters: { symbol, range: choice(["1d", "5d", "1mo", "3mo", "6mo", "1y", "5y"], "Requested lookback; default 1y."), interval: choice(["1m", "5m", "15m", "1h", "4h", "1d", "1wk", "1mo"], "Bar interval; default 1d."), count: { type: "integer", min: 2, max: 10000, description: "Maximum newest bars to return." }, fresh },
    source: "Configured Trader bars provider", history: "Provider-dependent lookback and intervals",
    response: "Native MarketBarsResponse JSON: instrument, bars.items, bars.provenance, requestedCount, returnedCount, dataMode.",
    notes: ["Requested lookback/count does not guarantee complete history. Inspect returned bars and provenance."],
  },
  ...["workspace", "financials", "profile", "fundamentals", "earnings", "analyst", "news", "research"].map(id => ({
    id, description: id === "workspace" ? "All available stock detail sections." : `Stock detail ${id} section.`,
    path: "/api/v1/symbols/:symbol/workspace", parameters: { symbol, fresh }, source: "Configured Trader providers; preserved per-section provenance",
    history: id === "financials" || id === "research" || id === "earnings" ? "Reported periods retained by the source; not original publication-time versions" : "Current response; source may include dated records",
    response: "Native SymbolWorkspace JSON: instrument, quote, profile, fundamentals, earnings, analyst, news, research, selectedProviders, dataMode, status, warnings.",
    notes: workspaceNotes, ...(id === "workspace" ? {} : { fixedQuery: { section: id } }),
  })),
  {
    id: "options-chain", description: "Current calls and puts for one expiration, all strikes by default.", path: "/api/v1/symbols/:symbol/options",
    parameters: { symbol, expiration: date("Expiration, YYYY-MM-DD; default nearest available."), range: choice(["all", "near"], "Strike coverage; default all.") },
    source: "Nasdaq", history: "Current chain only; this endpoint does not replay a historical chain",
    response: "OptionsChainSnapshot: contracts, expiration, expirations, coverage, source, sourceUrl, fetchedAt, underlyingAsOf, optional optionQuoteAsOf.",
    notes: ["No automatic option archive. Retrieval time is not quote time.", "Check coverage.complete and truncated; missing values are not zero.", "Open interest and prices can have different reference times."],
  },
  {
    id: "options-history", description: "External daily history for one option contract, including expired contracts.", path: "/api/v1/symbols/:symbol/options/prices",
    parameters: {
      symbol, contract: { ...text("Exact OCC ID, e.g. NBIS270115C00200000. Supply this OR expiration + side + strike."), query: "contractId" },
      expiration: date("Contract expiration, including expired dates; use with side and strike instead of contract."),
      side: choice(["call", "put"], "Use with expiration and strike."), strike: text("Positive strike with at most 3 decimal places; use with expiration and side."),
      source: choice(["chartexchange", "yahoo"], "Default chartexchange (OHLCV + open interest); yahoo is OHLCV only."),
      from: date("Inclusive source-labelled start date; optional."), to: date("Inclusive source-labelled end date; optional."),
    },
    source: "ChartExchange (default) or explicit Yahoo Finance", history: "ChartExchange: all retained rows within bounded limits; Yahoo: requested 1y",
    response: "OptionsPriceHistory: contractId, expiration, side, strike, items[{date,time?,open?,high?,low?,close?,volume?,openInterest?}], source, sourceUrl, fetchedAt, sourceAsOf, coverage. With from/to: requestWindow and filteredCoverage describe the returned subset; coverage still describes the unfiltered source result.",
    notes: ["Requires contract OR the complete expiration/side/strike tuple; current-chain availability is not required.", "No automatic saving, date shifting, interpolation, source fallback, or full historical-chain reconstruction.", "Availability is controlled by the source; arbitrary dates and indefinite retention are not guaranteed.", "Date-only ChartExchange rows have no time; OI balance/publication timing is unverified. Not point-in-time backtest input.", "from/to filter items only. Source metadata (including Yahoo latestOptionPrice and sourceAsOf) is not a quote as of the requested end date.", "Missing values remain absent. Empty filtered results mean no returned observations in the requested window, not zero trading.", "Historical IV, Greeks and bid/ask are not included. Providers can disagree on OHLCV."],
  },
  ...DIRECT_SOURCES.map(source => {
    const parameters: Record<string, DataParameter> = {};
    for (const input of source.inputs) {
      parameters[input] = input === "symbol" ? { ...symbol, required: !source.id.startsWith("sec-") }
        : input === "date" ? date(source.id === "fred" ? "Vintage reference date (latest revisions if omitted)." : source.id.startsWith("sec-") ? "Filing-date cutoff; does not promise complete historical filings." : "Requested session date.")
        : text(input === "series" ? "FRED series ID; default DGS10." : "Recipient business name.");
      if (source.id === "finra-short-volume" && input === "date" || input === "recipient") parameters[input] = { ...parameters[input], required: true };
    }
    if (source.id.startsWith("sec-")) parameters.cik = text("SEC CIK (1–10 digits); symbol or CIK required.");
    return {
      id: source.id, description: source.description, path: `/api/v1/research/sources/${source.id}`, parameters,
      source: source.name, credential: source.credential, history: source.description,
      response: "DirectSourceDataset: sourceId, sourceName, sourceUrl, fetchedAt, columns, rows, coverage, notes.",
      notes: ["Inspect coverage and notes; missing observations and partial data are not zero.", "Credentials/contact settings, when needed, belong to the Trader server; the CLI does not load or print them."],
    };
  }),
  {
    id: "technical-indicators", description: "Available Python TA-Lib functions, default parameters, inputs and warm-up periods.",
    path: "/api/v1/indicators", parameters: {}, source: "Trader Python TA-Lib", history: "Calculation definitions, no external observations",
    response: "TA-Lib catalog: indicators, engine version, limits.", notes: ["Requires the configured Trader Python helper with TA-Lib installed."],
  },
  {
    id: "technicals", description: "Python TA-Lib indicator histories calculated from Trader OHLCV.",
    path: "/api/v1/symbols/:symbol/technicals",
    parameters: { symbol, indicators: text("Comma-separated TA-Lib IDs, max 8; default RSI,MACD,ADX,CCI,MFI,BBANDS."),
      parameters: text('JSON parameters keyed by indicator ID, e.g. {"RSI":{"timeperiod":21}}.'),
      range: choice(["1d", "5d", "1mo", "3mo", "6mo", "1y", "5y"], "Requested price history, default 1y."),
      interval: choice(["1m", "5m", "15m", "1h", "4h", "1d", "1wk", "1mo"], "Bar interval, default 1d."),
      count: { type: "integer", min: 2, max: 10000, description: "Maximum input bars, default 500." }, fresh },
    source: "Configured Trader OHLCV provider → Python TA-Lib", history: "Computed series aligned to source bars; warm-up nulls retained",
    response: "TA-Lib results: times, results[].series[].values, parameters, inputs, lookback, version, source provenance and dataMode.",
    notes: ["No external precomputed indicators or automatic saving. Periods count input bars.", "Candlestick values indicate detected patterns, not probabilities. This does not execute a backtest."],
  },
  {
    id: "source-status", description: "Server-side configuration status for direct research sources (no credential values).",
    path: "/api/v1/research/sources", parameters: {}, source: "Trader", history: "Current configuration",
    response: "sources[{id,name,inputs,credential,configured,...}]", notes: ["configured does not guarantee that the upstream service is currently reachable."],
  },
  ...SHARED_DATASET_IDS.map(id => ({
    id, description: ({ "institutional-filings": "Published 13F filing events.", "institutional-holdings": "Published 13F holding rows by filing and report period.", "institutional-managers": "Observed popular-manager directory; not a complete historical institution universe.", "x-posts": "Stored X posts with source publication dates.", "x-mentions": "Recorded stock mentions in X posts.", "x-mention-outcomes": "Recorded post-mention returns and outcome observations.", "x-author-scores": "Saved author performance and scores.", "x-author-strategies": "Saved author strategy comparison results.", "x-accounts": "Accounts present in the stored X data.", "x-prices": "Stored X research instrument price observations." } as Record<string, string>)[id],
    path: `/api/v1/data/${id}`, parameters: sharedParameters(id),
    source: "Trader read-only access to the shared develop/.data producer store; no Midas service",
    history: "Producer-retained records; publication revision and stored version timestamps are preserved",
    response: "trader.shared-data.v1: dataset, rows, columns, source, provenance, coverage, pagination {limit,nextCursor}.",
    category: (["x-mention-outcomes", "x-author-scores", "x-author-strategies"].includes(id) ? "result" : ["institutional-managers", "x-accounts"].includes(id) ? "metadata" : "input") as DataCategory,
    subject: (id.startsWith("institutional-") ? "institution" : id === "x-prices" ? "symbol" : "account") as DataSubject,
    backtest: (["x-mention-outcomes", "x-author-scores", "x-author-strategies"].includes(id) ? "result-only" : ["institutional-managers", "x-accounts"].includes(id) ? "not-applicable" : id.startsWith("institutional-") || id === "x-prices" ? "conditional" : "analysis-only") as BacktestUse,
    timeShape: id === "institutional-holdings" ? "reported-period-end" : id === "x-prices" ? "time-series" : "dated-events",
    metadataPaths: { data: ["rows"], provenance: ["source", "provenance"], coverage: ["coverage", "pagination"], warnings: ["warnings"] },
    notes: ["Read-only access; requests do not collect data or modify the shared database.", "asOf conservatively filters currently stored records by known-at timestamps. This is not a complete historical-version archive.", "Rows use storage order, not chronological order; sort by their source date for analysis. Follow pagination.nextCursor with identical filters even when rows is empty; missing observations remain missing.", ...(id === "x-posts" ? ["symbol matches raw stored symbols; use x-mentions for classified stock mentions."] : []), ...(["x-author-scores", "x-author-strategies"].includes(id) ? ["from/to select current result versions by updated_at; they do not provide a historical score timeline."] : [])],
  })),
  {
    id: "midas-data-sources", description: "Deprecated alias for the independent Trader data catalog.",
    path: "/api/v1/midas/data-sources", parameters: {}, category: "metadata", subject: "system", deprecated: true, replacement: "data sources",
    source: "Trader", history: "Current capability definitions", response: "trader.data-catalog.v1, same as data sources.",
    notes: ["Compatibility command name only. No Midas request is made; use data sources or GET /api/v1/data."],
  },
  {
    id: "corporate-actions", description: "Dated dividends and stock splits (research envelope; ownership values are current).",
    path: "/api/v1/symbols/:symbol/workspace", parameters: { symbol, fresh }, fixedQuery: { section: "research" },
    source: "Yahoo Finance", history: "Requested 5 years of dated events; source-dependent coverage",
    response: "Native SymbolWorkspace; research.corporateActions contains dividends and splits.",
    notes: ["Event dates are not publication or cash payment timestamps. Avoid double counting adjustments already present in prices."],
  },
  {
    id: "analyst-ratings", description: "Historical analyst rating and target-price changes.",
    path: "/api/v1/symbols/:symbol/analyst-ratings",
    parameters: { symbol, from: { ...date("Inclusive event start date; default 900 days ago."), query: "date_from" }, to: { ...date("Inclusive event end date; default today in New York."), query: "date_to" }, limit: { type: "integer", min: 1, max: 1000, query: "pagesize", description: "Maximum events, default 1000." }, fresh },
    source: "Configured analyst history provider (Google Finance + Benzinga)", history: "Requested date window up to 3650 days; limited to source coverage",
    response: "Native AnalystRatingHistoryResponse: instrument, history, selectedProviders, dataMode, asOf.",
    notes: ["Current revised records do not guarantee the exact original publication-time version."],
  },
  {
    id: "strategy-list", description: "Saved strategy records and comparison metrics.", path: "/api/v1/strategies",
    parameters: { locale: choice(["en", "ja"], "Labels locale; default en.") }, source: "Trader saved strategy packages and owner-scoped strategy store",
    history: "Saved comparison results, not market input", response: "Native StrategiesResponse: schemaVersion, ownerId, strategies.",
    notes: ["Read performance.provenance; illustrative data and user-supplied metrics are not verified backtests."],
  },
  ...["strategy", "strategy-transactions", "strategy-performance", "strategy-equity", "strategy-holdings"].map(id => ({
    id, description: id === "strategy" ? "Saved strategy detail." : id === "strategy-transactions" ? "Saved strategy trade ledger." : id === "strategy-performance" ? "Saved strategy performance metrics." : id === "strategy-equity" ? "Saved backtest equity curve, run context and end positions." : "Current long-only ledger quantities and cost, valued with current source quotes when available.",
    path: id === "strategy-transactions" ? "/api/v1/strategy-portfolios/:strategy/transactions" : id === "strategy-equity" || id === "strategy-holdings" ? `/api/v1/data/${id}` : "/api/v1/strategies/:strategy",
    parameters: { strategy: { type: "text" as const, required: true, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", description: "Exact strategy ID from strategy-list." }, locale: choice(["en", "ja"], "Labels locale; default en.") },
    ...(id === "strategy-performance" ? { fixedQuery: { include: "performance" } } : {}),
    source: "Trader saved strategy packages and owner-scoped ledger", history: id === "strategy-holdings" ? "Current ledger snapshot and source quote times" : "Saved execution period; no backtest is executed",
    response: id === "strategy-transactions" ? "Native StrategyPortfolioTransactionsResponse: ownerId, strategyId, transactions." : id === "strategy-equity" || id === "strategy-holdings" ? "Trader strategy result JSON with availability, provenance and warnings." : "Native StrategyDetailResponse: strategy, optional performance, ownerId.",
    notes: ["Result data is for strategy comparison, not a new backtest's market input.", ...(id === "strategy-holdings" ? ["Backtest packages return end-of-backtest holdings separately from current live ledger holdings. Missing marks stay null."] : [])],
  })),
];

const INPUT_USE: Readonly<Record<string, BacktestUse>> = {
  bars: "usable", technicals: "usable", "corporate-actions": "conditional", fred: "conditional", "sec-facts": "conditional", "sec-filings": "conditional", "sec-insiders": "conditional", "finra-short-volume": "conditional", "options-history": "conditional",
  financials: "analysis-only", research: "analysis-only", earnings: "analysis-only", "analyst-ratings": "analysis-only", news: "analysis-only", usaspending: "analysis-only",
};
function metadataPaths(id: string): Readonly<Record<string, readonly string[]>> {
  if (id === "technical-indicators") return { data: ["indicators"], provenance: ["engine", "version"], coverage: ["limits"] };
  if (id === "source-status") return { data: ["sources"], provenance: ["sources"] };
  if (id === "midas-data-sources") return { data: ["datasets"], provenance: ["schemaVersion"], warnings: ["notes"] };
  if (id === "financials") return { data: ["fundamentals.annualFinancials", "fundamentals.quarterlyFinancials", "research.quarterlyFinancials", "research.annualCashFlows", "earnings"], provenance: ["fundamentals.provenance", "research.provenance", "selectedProviders"], time: ["asOf"], dataMode: ["dataMode"], coverage: ["status", "research.coverage"], warnings: ["warnings"] };
  if (id === "research") return { data: ["research.quarterlyFinancials", "research.annualCashFlows", "research.corporateActions"], provenance: ["research.provenance", "selectedProviders"], dataMode: ["dataMode"], coverage: ["status", "research.coverage"], warnings: ["warnings"] };
  if (id === "options-chain") return { data: ["contracts"], provenance: ["source", "sourceUrl"], time: ["fetchedAt", "underlyingAsOf", "optionQuoteAsOf"], coverage: ["coverage"] };
  if (id === "bars") return { data: ["bars.items"], provenance: ["bars.provenance"], dataMode: ["dataMode"], coverage: ["requestedCount", "returnedCount"] };
  if (id === "technicals") return { data: ["results"], provenance: ["inputBars.provenance"], dataMode: ["dataMode"], time: ["times"], coverage: ["barCount"] };
  if (id === "options-history") return { data: ["items"], provenance: ["source", "sourceUrl"], time: ["fetchedAt", "sourceAsOf"], coverage: ["coverage", "filteredCoverage"], warnings: ["openInterestDateBasis"] };
  if (DIRECT_SOURCES.some(item => item.id === id)) return { data: ["rows"], provenance: ["sourceName", "sourceUrl"], time: ["fetchedAt"], coverage: ["coverage"], warnings: ["notes"] };
  if (id === "analyst-ratings") return { data: ["history.items"], provenance: ["history.provenance", "selectedProviders"], dataMode: ["dataMode"], time: ["asOf"] };
  if (id.startsWith("strategy")) return { data: [id === "strategy-transactions" ? "transactions" : id === "strategy-list" ? "strategies" : id === "strategy-equity" ? "equity.points" : id === "strategy-holdings" ? "holdings" : "strategy"], provenance: ["strategy.performance.provenance", "provenance"], warnings: ["warnings"] };
  return { data: [id === "corporate-actions" ? "research.corporateActions" : id === "financials" ? "research.quarterlyFinancials" : id], provenance: ["selectedProviders", `${id}.provenance`], dataMode: ["dataMode"], time: ["asOf"], coverage: ["status"], warnings: ["warnings"] };
}
export const DATA_CATALOG: readonly DataDefinition[] = DEFINITIONS.map(definition => ({
  ...definition,
  category: definition.category ?? (definition.id.startsWith("strategy") ? "result" : INPUT_USE[definition.id] ? "input" : ["technical-indicators", "source-status"].includes(definition.id) ? "metadata" : "snapshot"),
  subject: definition.subject ?? (definition.id.startsWith("strategy") ? "strategy" : ["fred", "cnn-fear-greed"].includes(definition.id) ? "macro" : definition.id.startsWith("options-") ? "option-contract" : ["source-status", "technical-indicators"].includes(definition.id) ? "system" : "symbol"),
  backtest: definition.backtest ?? (definition.id.startsWith("strategy") ? "result-only" : INPUT_USE[definition.id] ?? "not-applicable"),
  timeShape: definition.timeShape ?? (definition.id === "bars" || definition.id === "technicals" || definition.id === "fred" || definition.id === "options-history" ? "time-series" : ["financials", "research", "sec-facts", "earnings"].includes(definition.id) ? "fiscal-periods" : INPUT_USE[definition.id] ? "dated-events" : definition.id.startsWith("strategy") ? "saved-result" : "latest"),
  metadataPaths: definition.metadataPaths ?? metadataPaths(definition.id),
}));

export const DATA_CATALOG_VERSION = "trader.data-catalog.v1";
