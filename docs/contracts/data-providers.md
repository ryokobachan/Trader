# Data Provider Contract

- Schema: `trader.provider.v1`
- Status: implemented contract
- Scope: active U.S.-listed common stocks and ADRs
- Developer guide: [`api/README.md`](../../api/README.md)

## Runtime model

Provider response bodies never reach React components directly. Each reviewed
adapter normalizes its upstream response into the canonical types in
[`provider-contracts.ts`](../../src/app/platform/provider-contracts.ts).

```ts
type ProviderRequestContext = {
  requestId: string;
  asOf?: string;
  signal?: AbortSignal;
  fresh?: boolean;
};

interface InstrumentProvider {
  searchUSStocks(
    request: InstrumentSearchRequest,
    context: ProviderRequestContext,
  ): Promise<readonly Instrument[]>;
  getUSStockBySymbol(
    symbol: string,
    context: ProviderRequestContext,
  ): Promise<Instrument | null>;
}

interface MarketDataProvider {
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

interface SyntheticMarketDataProvider {
  getLatestCloses(
    symbols: readonly string[],
    context: ProviderRequestContext,
  ): Promise<readonly SyntheticLatestClose[]>;
}

interface FundamentalsProvider {
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
  ): Promise<CompanyResearch | null>;
}

interface AnalystProvider {
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

interface NewsProvider {
  getCompanyNews(
    instrument: Instrument,
    context: ProviderRequestContext,
  ): Promise<readonly CompanyNewsItem[]>;
}
```

The TypeScript source is authoritative if this summary and the compiler ever
differ.

## Capabilities and configuration

The installed capabilities are:

```text
instrument.search
instrument.identity
market.quote
market.bars
market.synthetic_latest_close
fundamentals.profile
fundamentals.normalized
fundamentals.earnings
fundamentals.research
analyst.consensus
analyst.ratings
news.company
```

[`api/config.json`](../../api/config.json) selects registered provider IDs for
the `instrument`, `market`, `bars`, `profile`, `fundamentals`, `earnings`, `research`,
`analyst`, and `news` roles. Deployment environment variables override those
non-secret defaults. `npm run config:check` reports the effective role, source
file, and missing credential names without printing values.

Current adapters:

| ID | Implemented data | Credential policy |
|---|---|---|
| `mock` | deterministic search, quote, and bars fixtures | none |
| `yahoo` | search, quote, bars, profile, fundamentals, earnings, ownership/short interest, quarterly statements, dividends/splits, news | explicit personal-use compatibility opt-in |
| `tradingview` | financial scanner profile, FY financials and history, fiscal EPS/revenue consensus, float, Altman and Piotroski | no API key or financials sidecar; site-internal API availability and display terms apply |
| `google-finance-earnings` | dated EPS/revenue actuals and estimates from the website earnings RPC | no credential; independently validated `wKsYyb` JSON response |
| `benzinga` | Midas-compatible analyst consensus and rating history | optional token; applicable display rights remain required |
| `google-finance` | analyst consensus and ratings extracted from the Analysis-page `AF_initDataCallback` data array | no credential; applicable Google Finance access/display rights remain required |
| `google-finance-benzinga` | OR-union of Google Finance callback data and Benzinga analyst ratings, with firm-level current consensus | no Google credential; either surviving source returns partial coverage |
| `tipranks` | TipRanks Enterprise analyst consensus and rating history | `TIPRANKS_API_KEY`, `TIPRANKS_API_TOKEN`, and applicable display rights |
| `tradingview-websocket` | direct USD quotes, local chart bars, and fresh `{symbol}USDT.P` reference closes | authenticated sidecar for bars/local SSE; the hosted Worker uses the same guest quote websocket inside completed HTTPS long polls and a server-side scanner for snapshots; continuous ticks expire after 5m |

No adapter silently falls back to mock data. Missing optional roles produce an
explicit partial/missing state.

FMP is retired and cannot be selected in any role. Its credentials no longer
cross the provider environment boundary. The Midas development profile selects
Yahoo profiles/research, TradingView normalized financials, and Google Finance
dated earnings. The checked-in JSON retains deterministic mock market defaults
and leaves optional company-data roles disabled.

## Canonical rules

- Instrument search returns only active U.S. common stocks or ADRs.
- Instrument identity uses a stable `instrumentId`; ticker text alone is not a
  database key.
- Market prices are finite positive numbers. Missing values remain `null` or an
  absent field; providers do not invent zeroes.
- Bars are ordered, unique, UTC-normalized, and keep the requested interval and
  adjustment policy. The public bars route accepts 2–10,000 observations.
- Rates use decimal ratios in canonical DTOs; presentation converts them to
  percentages exactly once.
- Every returned dataset carries provider provenance and observation time.
- TradingView statement totals and profitability/liquidity ratios use explicit
  annual source fields; valuation multiples preserve their trailing or forward
  definition. Altman Z is labeled TTM and Piotroski is labeled FY. Source ratios
  can use different income adjustments, so they are not recalculated from a
  differently defined statement field.
- `annualFinancials` uses source fiscal-year labels and only aligned arrays.
  `fiscalForecasts` uses source fiscal periods and reported flags. Future periods
  have estimates only; no fiscal period is manufactured into an earnings date.
- `EarningsEvent.reportDate` comes from the earnings provider's release timestamp.
  Adjusted earnings EPS and diluted statement EPS remain separate values.
- Canonical statement money is USD; listing currency alone does not prove an
  ADR's reporting currency. Unsupported reporting currency remains unavailable.
- `CompanyResearch` preserves independent ownership, quarterly-statement and
  corporate-action coverage. Quarterly statement dates and short-interest dates
  remain source dates, distinct from ingestion time. Missing fields remain absent.
- The Google Finance adapter parses literal callback data without evaluating
  inline JavaScript, validates listing identity, and fails closed when the
  undocumented callback shape changes.
- The Google Finance+Benzinga composite preserves a surviving source as partial
  coverage for any one-source failure; it fails only when both sources fail.
  Standalone provider configuration and contract errors continue to fail closed.
- API keys, cookies, sidecar tokens, credential-bearing URLs, and raw response bodies do
  not appear in browser bundles, logs, provenance, or public errors.
- Website-internal APIs can change without a supported public API contract.
  Bounded caches, deadlines, listing/schema checks, and per-source coverage protect
  the application; successful retrieval does not establish redistribution rights.

## HTTP boundary

Standalone research also exposes `GET /api/v1/research/sources` and
`GET /api/v1/research/sources/:sourceId`. These independent adapters normalize
SEC filings/facts/Form 4, FINRA volume, USAspending awards, FRED and CNN data
into `DirectSourceDataset`, without changing stock-provider roles or requiring
Midas. See [direct research scope](../midas-data-source-comparison.md).

UI code calls Trader's internal routes, not vendors:

```text
GET  /api/v1/instruments/search
GET  /api/v1/symbols/:symbol/workspace
GET  /api/v1/symbols/:symbol/bars
GET  /api/v1/symbols/:symbol/analyst-ratings
GET  /api/v1/symbols/:symbol/logo
GET  /api/v1/watchlists/quotes/stream?symbols=AAPL,NVDA
POST /api/v1/watchlists/quotes
GET  /api/v1/watchlists/after-hours/stream?symbols=AAPL,NVDA
POST /api/v1/watchlists/after-hours
```

The root [`api/`](../../api) directory contains outbound vendor adapters.
`src/app/api/` contains these inbound Trader HTTP routes; the two directories
serve different purposes.

The logo route resolves the public TradingView `logoid` server-side and permits
only the reviewed `s3-symbol-logo.tradingview.com` image origin. The UI never
constructs an arbitrary vendor URL from a symbol or untrusted profile field.

## Adding a provider

1. Implement `api/<provider-id>/index.server.ts` against the interfaces above.
2. Register it statically in [`api/index.server.ts`](../../api/index.server.ts).
3. Declare allowed roles in [`api/provider-roles.ts`](../../api/provider-roles.ts).
4. Add required environment-variable names to
   [`api/environment.ts`](../../api/environment.ts); values remain in ignored
   `.env.local` or hosted secrets.
5. Select the ID in `api/config.json` and add contract tests.

JSON never supplies a module path, endpoint, credential name, formatter,
formula, or executable expression.

## New data domains and UI

Adding fields already represented by canonical DTOs can stay within `api/` and
`api/config.json`. A genuinely new domain such as an options chain also needs a
versioned canonical contract and a UI module. Keep provider access under
`api/<provider>/` and presentation under [`extensions/`](../../extensions);
see [`extensions/README.md`](../../extensions/README.md). Options data should be
loaded only when its panel opens rather than added to every symbol workspace.

## Conformance checks

Every adapter must test its manifest, capabilities, missing credentials,
timeouts, non-2xx responses, malformed data, partial data, time normalization,
symbol validation, provenance, and secret redaction. The client build is also
checked to ensure server-only adapter code and credential names do not leak.

Provider access and redistribution terms are separate from the Apache-2.0 code
license. Operators are responsible for their chosen upstream agreements.
