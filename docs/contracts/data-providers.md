# Data Provider Contract

- Version: `unicorn.provider.v1`
- Status: Phase 1 subset implemented; catalog／cache／SEC／Massive remain proposed
- Scope: U.S. listed equities only
- Project overview: [README](../../README.md)

## 1. Provider profile

The default OSS installation contains only deterministic synthetic fixtures. A deployment enables real providers explicitly.

| Capability | Recommended adapter | Credential | Role |
|---|---|---|---|
| Instrument master／search | Massive `reference/tickers` | `MASSIVE_API_KEY` | Complete active U.S. stock universe and identifiers |
| Chart bars／quote／corporate actions | Massive Stocks REST | `MASSIVE_API_KEY` | OHLCV, snapshot, split, dividend |
| Local chart bars | `tradingview-websocket` Python sidecar | No API key; optional loopback bearer token | Implemented for local development; bar source is independently selectable from quote data |
| Local search／identity／chart bars／quote／profile／fundamentals／earnings／news | Yahoo compatibility adapter | explicit personal-use opt-in | Implemented for local development; no redistribution claim |
| Reported fundamentals | SEC EDGAR `data.sec.gov` | No key; `SEC_EDGAR_USER_AGENT` required | PIT filing and XBRL facts |
| Normalized statements／ratios | FMP | `FMP_API_KEY` | Optional convenience adapter |
| Analyst ratings／targets | Benzinga Midas-compatible adapter | Optional `BENZINGA_API_TOKEN`／`BENZINGA_API_KEY` | Implemented; request and normalization follow Midas |
| Analyst estimates／targets | FMP or another licensed adapter | Provider-specific key | Developer-selectable alternative; never inferred from SEC data |
| Local normalized workspace | FMP | `FMP_API_KEY` plus usage-mode opt-in | Implemented BYOK adapter; display licence remains operator responsibility |
| Offline development | `mock` | None | Redistributable synthetic data |

Provider choice is not hard-coded in UI components. The developer installs adapters; the deployment enables them; a workspace may select priority only among enabled adapters.

## 2. Stable Core interfaces

Provider implementations conform to Core-owned interfaces and return canonical DTOs. Provider response shapes never leak into the frontend.

```ts
type ProviderCapability =
  | "instrument.search"
  | "instrument.identity"
  | "market.quote"
  | "market.bars"
  | "market.synthetic_latest_close"
  | "fundamentals.profile"
  | "fundamentals.normalized"
  | "fundamentals.earnings"
  | "analyst.consensus"
  | "analyst.ratings"
  | "news.company";

type ProviderRequestContext = {
  requestId: string;
  workspaceId: string;
  credentialRef: string;
  asOf?: string;
  deadlineMs: number;
};

interface InstrumentProvider {
  manifest(): ProviderManifest;
  syncUSUniverse(cursor?: string): Promise<InstrumentPage>;
  getInstrument(providerId: string, asOf?: string): Promise<InstrumentRecord>;
}

interface MarketDataProvider {
  manifest(): ProviderManifest;
  getQuotes(ids: string[], context: ProviderRequestContext): Promise<Quote[]>;
  getBars(request: BarsRequest, context: ProviderRequestContext): Promise<BarPage>;
  getCorporateActions(request: CorporateActionRequest, context: ProviderRequestContext): Promise<CorporateAction[]>;
}

interface FundamentalsProvider {
  manifest(): ProviderManifest;
  getReportedFacts(request: FactsRequest, context: ProviderRequestContext): Promise<ReportedFact[]>;
  getStatements?(request: StatementRequest, context: ProviderRequestContext): Promise<Statement[]>;
  getEstimates?(request: EstimateRequest, context: ProviderRequestContext): Promise<Estimate[]>;
}
```

`ProviderManifest` declares:

```text
id, package, version, capabilities[], markets[], asset_types[],
intervals[], max_history, delay_policy, adjustment_modes[],
auth_mode, required_env[], rate_limit, cache_ttl,
license_url, attribution, storage_allowed, redistribution_allowed
```

Core owns input validation, timeout, retry policy, provenance envelope, redaction, provider health, caching contract, and API error mapping. An adapter may not weaken these rules.

## 3. U.S. equity Instrument Master

Search must support any indexed active U.S.-listed common stock, not a hard-coded symbol list and not global instruments.

### Ingestion

1. The configured `InstrumentProvider` synchronizes the full universe on a schedule.
2. Records are normalized into the separate Catalog DB.
3. Search queries the local index; it does not call an external provider for every keystroke.
4. The API enforces `locale=us`, `market=stocks`, `active=true`, and a Core allow-list of `common_stock` and `adr`.
5. ETFs, funds, options, futures, forex, crypto, OTC, test issues, and non-U.S. listings are excluded from MVP results.
6. Delisted records remain addressable for historical runs but are not returned by default search.

Canonical instrument fields:

```text
instrument_id, symbol, name, canonical_type, active,
listing_country=US, domicile_country?, locale=us, primary_exchange_mic,
currency=USD, cik?, composite_figi?, share_class_figi?,
provider_ids{}, valid_from, valid_to?, source_updated_at,
logo{}, provenance_hash
```

The public search endpoint is:

```http
GET /api/v1/instruments/search?q=apple&limit=20&cursor=...
```

- A normalized prefix match on symbol ranks before a name token match.
- Empty queries return recent/popular U.S. equities, not the entire table.
- Results always include `instrument_id`; watchlists and strategies store that ID rather than treating ticker as immutable.
- Symbols with punctuation such as `BRK.B` are normalized without losing the provider representation.

### Provider mapping

Massive's current adapter maps:

- universe: `GET /v3/reference/tickers` with `market=stocks`, `active=true`; retain only response records with `locale=us` and version-mapped common-stock／ADR types
- detail: `GET /v3/reference/tickers/{ticker}`
- pagination: follow `next_url` while retaining server-side authentication

An optional no-key bootstrap adapter may combine SEC `company_tickers_exchange.json` with Nasdaq Trader symbol directory data. It is a separate adapter with its own terms and conformance tests, not a silent fallback.

The Provider SDK stores Massive's ticker-type catalog and maps provider code `CS` to Core `common_stock`; ADR codes are included only when explicitly mapped by the installed adapter version. Unknown types fail closed rather than appearing as stocks.

## 4. Chart market data

`BarsRequest` fields:

```text
instrument_id, interval, from, to, session,
adjustment, sort=asc, page_size, as_of?
```

Canonical `Bar` fields:

```text
instrument_id, interval, bar_start, bar_end,
open, high, low, close, volume, vwap?, trade_count?,
session, adjustment, is_final, currency, timezone,
provider, source_record_id, available_at, ingested_at,
provenance_hash
```

Rules:

- All storage timestamps are UTC; exchange timezone is metadata.
- `is_final=false` distinguishes a developing bar from a closed bar.
- Empty intervals remain missing; Core does not manufacture zero-volume bars unless the caller requests calendar filling.
- `raw`, `split_adjusted`, and `total_return_adjusted` are distinct datasets.
- Indicator and backtest requests declare the adjustment mode and session; they cannot mix modes.
- API responses include delay and entitlement metadata.

The Phase 1 HTTP boundary is
`GET /api/v1/symbols/:symbol/bars?range=…&interval=…&count=…`. `count` is
optional and accepts an integer from 2 through 10,000. Omitting it preserves
the adapter interval／range defaults for external clients; Unicorn's interactive
chart explicitly requests the validated user preference (default 1,000,
maximum 10,000) for every interval. Responses expose
`requestedCount` and `returnedCount`, and the canonical route never returns
more than the explicit count or the platform ceiling. The local TradingView
adapter may be given a lower deployment ceiling with
`UNICORN_TRADINGVIEW_MAX_CANDLES`, but it can never exceed 10,000.

Massive mapping:

- bars: `GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}`
- quote snapshot: `GET /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}`
- splits: `GET /stocks/v1/splits`
- dividends: `GET /stocks/v1/dividends`

API keys are sent by server-side `Authorization: Bearer` where supported. They are never placed in browser requests, logs, errors, share URLs, or analytics events.

## 5. Fundamentals

Reported facts and normalized financial statements are separate capabilities.

Canonical `ReportedFact`:

```text
instrument_id, cik, taxonomy, concept, label,
value, unit, period_start?, period_end, instant?,
fiscal_year?, fiscal_period?, form, accession_number,
filed_at, accepted_at?, available_at, frame?,
is_amendment, source_url, provider, provenance_hash
```

Canonical `StatementLine`:

```text
instrument_id, statement, line_item, value, unit, currency,
period_type, period_start?, period_end, fiscal_year,
fiscal_period, reported_or_normalized, source_fact_ids[],
calculation_policy?, available_at, provider, provenance_hash
```

SEC adapter mapping:

- submissions: `https://data.sec.gov/submissions/CIK##########.json`
- company facts: `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`
- bulk sync: SEC nightly `companyfacts.zip` and `submissions.zip`
- authentication: no API key
- required client identification: `SEC_EDGAR_USER_AGENT`
- limiter: deployment default 8 requests／second and never above SEC guidance
- browser calls are prohibited because `data.sec.gov` does not provide CORS for this use

FMP optional mapping:

- profile: `GET /stable/profile?symbol={symbol}`
- income statement: `GET /stable/income-statement?symbol={symbol}`
- balance sheet: `GET /stable/balance-sheet-statement?symbol={symbol}`
- cash flow: `GET /stable/cash-flow-statement?symbol={symbol}`
- estimates: `GET /stable/analyst-estimates?symbol={symbol}`
- authentication: the current stable FMP API uses a server-side `apikey` query parameter built with `URLSearchParams`; the complete URL, key, and upstream body are redacted from errors and logs

FMP-derived ratios and estimates must retain `provider=fmp`; they must not be labeled as SEC values. Display／redistribution requires the deployment's applicable FMP agreement.

Benzinga analyst mapping follows Midas' `benzinga_analyst_ratings.py` contract:

- endpoint: `https://www.benzinga.com/api-next/calendar/ratings`
- request: `pagesize`, `fields`, `parameters[date_from]`, `parameters[date_to]`, and `parameters[tickers]`
- fields include analyst／firm identity, current／prior rating and price target, adjusted target fields, and `ratings_accuracy` values
- token resolution: `BENZINGA_API_TOKEN`, then the legacy `BENZINGA_API_KEY` alias
- request header: `User-Agent: midas/benzinga-analyst-ratings`
- timestamps are normalized using the New York market timezone before conversion to canonical UTC values
- adjusted target values take precedence when available; consensus uses the latest usable event per analyst／firm identity

The current website endpoint also receives `symbols` and `pageSize` aliases so its live ticker filter and page size match the Midas-form request. These aliases are adapter compatibility details and do not change the canonical DTO.

### Fundamental metric registry

Which values appear in a screen is configurable, but the meaning of a metric ID is versioned and not user-editable.

```ts
type FundamentalMetricDefinition = {
  id: string;                 // e.g. fundamentals.revenue
  version: string;
  statement?: "income" | "balance" | "cashflow";
  periodTypes: Array<"FY" | "FQ" | "TTM" | "instant">;
  unit: "currency" | "shares" | "ratio" | "count";
  sourceConcepts: string[];   // XBRL concepts or normalized provider fields
  calculationPolicy?: string;
  requiredCapabilities: ProviderCapability[];
};
```

MVP registry:

| Module | Metric IDs |
|---|---|
| Company | name, description, primary exchange, sector／industry, employees, shares outstanding, market cap |
| Income | revenue, gross profit, operating income, net income, diluted EPS |
| Balance | cash, total assets, current assets／liabilities, total debt, stockholders' equity |
| Cash flow | operating cash flow, capital expenditure, free cash flow |
| Growth | revenue YoY, EPS YoY, FCF YoY |
| Valuation | P／E, P／B, P／S, EV／EBITDA, FCF yield |
| Quality | gross／operating／net margin, ROE, ROIC, debt／equity |
| Shareholder return | dividend per share, dividend yield, buyback amount |
| Analyst | target mean／median／high／low, buy／hold／sell counts, last revision |

- Reported statement values prefer SEC facts and keep accession／concept lineage.
- TTM and locally calculated ratios identify `calculation_policy` and all input fact IDs.
- Provider-normalized FMP values use a separate definition version and are never silently substituted for a SEC-derived metric.
- End users may choose visible metric IDs and ordering. Developers may add a new versioned metric definition. Neither may redefine an existing metric ID in place.

## 6. Configuration and credentials

`.env` chooses deployment defaults and contains single-user/self-hosted secrets. It is not a per-user preferences database.

Non-secret frontend module registration lives in [`app/unicorn.config.ts`](../../app/unicorn.config.ts). Provider selection and secrets remain server-side `.env` values; [`.env.example`](../../.env.example) is the executable configuration reference.

```text
UNICORN_INSTRUMENT_PROVIDER
UNICORN_MARKET_PROVIDER
UNICORN_BARS_PROVIDER
UNICORN_PROFILE_PROVIDER
UNICORN_FUNDAMENTALS_PROVIDER
UNICORN_EARNINGS_PROVIDER
UNICORN_ANALYST_PROVIDER
UNICORN_NEWS_PROVIDER
UNICORN_USAGE_MODE
UNICORN_ENABLE_YAHOO_COMPAT
UNICORN_TRADINGVIEW_SIDECAR_URL
UNICORN_TRADINGVIEW_SIDECAR_TOKEN
UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS
UNICORN_TRADINGVIEW_MAX_CANDLES
UNICORN_ALLOW_RESTRICTED_PUBLIC_DISPLAY
MASSIVE_API_KEY
FMP_API_KEY
BENZINGA_API_TOKEN
BENZINGA_API_KEY
BENZINGA_TIMEOUT_SECONDS
BENZINGA_ANALYST_RATINGS_ENDPOINT
BENZINGA_ANALYST_RATINGS_DISABLED
SEC_EDGAR_USER_AGENT
```

- Only `.env.example` is committed.
- Secret variables never use a `NEXT_PUBLIC_` prefix.
- Startup validates all `required_env` values for enabled adapters and reports variable names, never values.
- A workspace stores provider IDs, priority, and `credential_ref`; it does not store plaintext keys.
- Multi-user Bring Your Own Key uses a SecretStore adapter. The operational DB stores only an opaque reference and masked suffix.
- Environment credentials are the deployment default and cannot be read back through an API.

### Local TradingView websocket boundary

`tradingview-websocket` is a CPython package and cannot execute inside the
Vinext Cloudflare Worker. Unicorn therefore keeps it behind
`services/tradingview_sidecar.py` and the canonical `MarketDataProvider`
contract. `UNICORN_BARS_PROVIDER=tradingview-websocket` affects chart OHLCV
only; `UNICORN_MARKET_PROVIDER` continues to select quote/snapshot data.

The local launcher binds the sidecar to `127.0.0.1`, generates an ephemeral
Bearer token, enforces a per-fetch child-process timeout, and maps canonical
intervals to TradingView series resolutions. An operator who exposes a remote
sidecar must use HTTPS, authentication, and independently verify access,
display, retention, and redistribution rights. The open-source default remains
the synthetic `mock` provider and no hosted Cloudflare deployment implicitly
falls back to this sidecar.

The same boundary implements `POST /v1/latest-closes` for the watchlist's
optional reference column. One bounded request accepts at most 50 canonical
U.S. tickers and resolves `{EXCHANGE}:{TICKER}USDT.P` through the ordered,
server-owned exchange list in `UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES`. The
default is `BINANCE,BITGET,KUCOIN,MEXC`, so AAPL can resolve to Binance while
OKLO resolves to Bitget without a UI-specific mapping. Each item returns its
exact `sourceSymbol`, latest one-minute close, and upstream timestamp.
Unsupported or empty contracts return `close=null` and `updatedAt=null`; the
adapter never copies or estimates the U.S. cash-equity price. Symbols travel in
the JSON body, the loopback bearer token stays in the Authorization header, and
neither is written to sidecar logs.

## 7. Developer extension boundary

Developer-customizable:

- install or implement Provider packages
- map provider fields to canonical DTOs
- declare capability, entitlement, rate, cache, and licensing metadata
- register providers in server configuration
- provide SecretStore and storage adapters

Runtime user-configurable:

- choose priority among installed/authorized providers
- choose data delay／adjustment where the provider supports it
- choose visible modules and refresh behavior
- supply an encrypted workspace credential when the deployment permits BYOK

Not customizable by adapters or end users:

- U.S.-equity-only search scope for the MVP
- canonical units, UTC storage, Instrument ID rules
- provenance and PIT fields
- secret redaction, SSRF protection, tenant authorization
- error schema and fallback disclosure
- redistribution checks

## 8. Provider conformance suite

Every adapter must pass:

- capability manifest and missing credential startup tests
- arbitrary active U.S. symbol search plus punctuation and delisted cases
- pagination, 429 retry, timeout, 5xx, malformed body, and partial response
- UTC and exchange-time conversion around DST
- split／dividend adjustment and missing-bar cases
- SEC amendment, multiple units, duplicated XBRL facts, fiscal-year boundary, PIT availability
- no secret in logs, traces, Problem Details, or client bundles
- license metadata and fallback disclosure

## 9. Official references

- Massive Stocks API: <https://massive.com/docs/rest/stocks>
- Massive REST authentication: <https://massive.com/docs/rest/quickstart>
- Massive custom OHLC bars: <https://massive.com/docs/rest/stocks/aggregates/custom-bars>
- Massive ticker reference: <https://massive.com/docs/rest/stocks/tickers/all-tickers>
- SEC EDGAR data APIs: <https://www.sec.gov/search-filings/edgar-application-programming-interfaces>
- SEC company ticker／exchange mapping: <https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data>
- FMP developer documentation: <https://site.financialmodelingprep.com/developer/docs>
- Benzinga API documentation: <https://docs.benzinga.com/introduction/introduction>
- Nasdaq Trader symbol directory definitions: <https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs>
