# Data Provider Contract

- Schema: `unicorn.provider.v1`
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
analyst.consensus
analyst.ratings
news.company
```

[`api/config.json`](../../api/config.json) selects registered provider IDs for
the `instrument`, `market`, `bars`, `profile`, `fundamentals`, `earnings`,
`analyst`, and `news` roles. Deployment environment variables override those
non-secret defaults. `npm run config:check` reports the effective role, source
file, and missing credential names without printing values.

Current adapters:

| ID | Implemented data | Credential policy |
|---|---|---|
| `mock` | deterministic search, quote, and bars fixtures | none |
| `yahoo` | search, quote, bars, profile, fundamentals, earnings, news | explicit personal-use compatibility opt-in |
| `fmp` | search, quote, bars, company data, analyst data, news | `FMP_API_KEY` and applicable display rights |
| `benzinga` | Midas-compatible analyst consensus and rating history | optional token; applicable display rights remain required |
| `tradingview-websocket` | local chart bars and synthetic reference closes | authenticated loopback sidecar |

No adapter silently falls back to mock data. Missing optional roles produce an
explicit partial/missing state.

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
- Optional upstream failures may yield a partial workspace, but configuration,
  credential, validation, and contract errors fail closed.
- API keys, cookies, sidecar tokens, raw upstream URLs, and response bodies do
  not appear in browser bundles, logs, provenance, or public errors.

## HTTP boundary

UI code calls Unicorn's internal routes, not vendors:

```text
GET  /api/v1/instruments/search
GET  /api/v1/symbols/:symbol/workspace
GET  /api/v1/symbols/:symbol/bars
GET  /api/v1/symbols/:symbol/analyst-ratings
POST /api/v1/watchlists/quotes
POST /api/v1/watchlists/after-hours
```

The root [`api/`](../../api) directory contains outbound vendor adapters.
`src/app/api/` contains these inbound Unicorn HTTP routes; the two directories
serve different purposes.

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
