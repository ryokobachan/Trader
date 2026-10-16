## Unified data access

The app, agents and other applications can discover all datasets at `GET /api/v1/data`, describe one at `/api/v1/data/:id/describe`, retrieve it at `/api/v1/data/:id`, and read OpenAPI at `/api/v1/data/openapi.json`. The same contract drives `trader data sources/describe/get/openapi`. See [data access](../docs/data-cli.md) for parameters, Python/JavaScript clients and migration details.

Shared 13F/X data is read independently from `TRADER_SHARED_DATA_ROOT` (the `develop/.data` root) by the authenticated helper through `GET /v1/shared-data/:id`. The consumer uses read-only SQLite transactions, validates publication bindings/schema, withholds pending 13F bundles, and returns bounded pages with provenance and warnings. There is no Midas fallback or database copy. Legacy institutional/X Midas endpoints return 410 with replacement links; only Ideas retains the old integration.

# Data API customization

This directory is the developer-owned boundary for external market-data
sources. It is intentionally separate from [`src/app/api`](../src/app/api),
which contains Trader's internal HTTP route handlers.

## Start here

1. Edit [`config.json`](./config.json).
2. Run `npm run config:check`.
3. Restart or rebuild Trader.

An existing provider switch is one JSON edit. For example:

```json
{
  "providers": {
    "instrument": "yahoo",
    "market": "tradingview-websocket",
    "bars": "tradingview-websocket",
    "profile": "yahoo",
    "fundamentals": "tradingview",
    "earnings": "tradingview",
    "research": "yahoo",
    "analyst": "google-finance-benzinga",
    "news": "yahoo"
  }
}
```

`config.json` is public and non-secret. It may contain only registered IDs and
UI ordering. Never put API keys, tokens, cookies, endpoint URLs, or local file
paths in it. Put secrets and reviewed endpoint overrides in `.env.local` or in
the hosted secret bindings.

Environment variables override the JSON for deployment-specific profiles.
`npm run dev:yahoo` and `npm run dev:midas` intentionally provide such
overrides; use `npm run dev -- --port 3001` when testing the JSON defaults.

## ID to implementation mapping

[`index.server.ts`](./index.server.ts) is the trusted static registry. JSON IDs
resolve to these reviewed files:

| ID | Main implementation | Upstream boundary |
|---|---|---|
| `mock` | [`mock/index.server.ts`](./mock/index.server.ts) | deterministic local fixtures |
| `yahoo` | [`yahoo/index.server.ts`](./yahoo/index.server.ts) | Yahoo-compatible search, chart, profile, financials, research and news endpoints |
| `tradingview` | [`tradingview/index.server.ts`](./tradingview/index.server.ts) | financial scanner plus quote WebSocket; FY/FQ statements, cash flows, dated earnings, fiscal-quarter consensus and valuation |
| `google-finance-earnings` | [`google-finance-earnings/index.server.ts`](./google-finance-earnings/index.server.ts) | Google Finance `wKsYyb` earnings RPC; actual release dates and EPS/revenue actuals/estimates |
| `benzinga` | [`benzinga/analyst.server.ts`](./benzinga/analyst.server.ts) | Benzinga ratings calendar |
| `google-finance` | [`google-finance/analyst.server.ts`](./google-finance/analyst.server.ts) | Google Finance Analysis-page callback data |
| `google-finance-benzinga` | [`google-finance-benzinga/index.server.ts`](./google-finance-benzinga/index.server.ts) | firm-level merge of Google Finance and Benzinga rating events |
| `tipranks` | [`tipranks/analyst.server.ts`](./tipranks/analyst.server.ts) | TipRanks Enterprise analyst-ratings REST API |
| `tradingview-websocket` | [`tradingview-websocket/index.server.ts`](./tradingview-websocket/index.server.ts) | authenticated Python sidecar for direct USD quotes, SSE streaming, chart bars, and optional synthetic references |

In the keyless local profile, Yahoo profile and earnings requests first use the
native normalized adapter. If Yahoo's anonymous cookie/crumb handshake is
throttled, the same authenticated loopback sidecar uses pinned `yfinance` and
returns only Trader's normalized profile and earnings fields. Raw Yahoo
payloads, cookies, and crumbs are never exposed to the browser.

The Yahoo implementation is divided by the part a developer usually changes:

```text
yahoo/
  chart.ts                 chart endpoint
  search.ts                search endpoint, exchanges, popular symbols
  fundamentals/
    income.ts              income-statement field list
    bs.ts                  balance-sheet field list
    cash-flow.ts           cash-flow field list
    valuation.ts           valuation field list
    profile.ts             profile/quote-summary modules
  earnings.server.ts       earnings history client
  research.server.ts       ownership/short interest, dated quarters, dividends/splits
  index.server.ts          normalized provider implementation
stock-detail/
  ids.ts                   allowed metric and tab IDs
  metrics.ts               canonical data-to-view calculations
```

Thus, changing Yahoo balance-sheet fields starts in
[`yahoo/fundamentals/bs.ts`](./yahoo/fundamentals/bs.ts); changing chart access
starts in [`yahoo/chart.ts`](./yahoo/chart.ts).

Options research uses dedicated routes rather than the stock-price provider
roles. [`options/chartexchange-history.server.ts`](./options/chartexchange-history.server.ts)
is the default contract-history adapter for public daily OHLC, volume and open
interest. It needs no credential and reads the public historical table. The
`/api/v1/symbols/:symbol/options/prices` route accepts a validated `contractId`
and an optional `source=chartexchange|yahoo`; Yahoo remains an explicit price and
volume alternative. Sources are never merged automatically. Source dates,
missing values, coverage and the unverified OI publication basis are preserved.
See [`docs/options-history.md`](../docs/options-history.md) for limits and exports.

For fields already normalized by a provider, visibility and order are controlled
only by `config.json`. The allowed stock-detail IDs and their view-model
calculations are colocated in [`stock-detail/ids.ts`](./stock-detail/ids.ts) and
[`stock-detail/metrics.ts`](./stock-detail/metrics.ts). A genuinely new vendor
field still needs an explicit canonical DTO addition so units and provenance
cannot be inferred incorrectly.

## Provider roles

Standalone research datasets use `direct-sources/` and
`/api/v1/research/sources/:sourceId`, separately from the stock provider roles.
SEC filings/facts/Form 4, FINRA short-sale volume, USAspending, FRED and CNN
can be fetched from the Data sources page without a Midas API dependency.
See [comparison, API and limits](../docs/midas-data-source-comparison.md).

| JSON role | UI data |
|---|---|
| `instrument` | U.S. stock search and symbol identity |
| `market` | current quote and watchlist price |
| `bars` | OHLCV chart candles |
| `profile` | company description and profile |
| `fundamentals` | normalized financial metrics |
| `earnings` | actual and estimated earnings |
| `research` | ownership/short interest, dated quarterly statements, dividends and splits |
| `analyst` | consensus and rating history |
| `news` | company news |

The UI calls only Trader routes such as `/api/v1/instruments/search`,
`/api/v1/symbols/:symbol/workspace`, `/api/v1/symbols/:symbol/bars`, and the
same-origin `/api/v1/watchlists/quotes/stream` SSE endpoint. Provider files
normalize vendor responses into the canonical DTOs in
[`src/app/platform/provider-contracts.ts`](../src/app/platform/provider-contracts.ts).

### TradingView financials and complementary company research

The `tradingview` provider sends a fixed column list to
`https://scanner.tradingview.com/america/scan`. It resolves the instrument's
known U.S. exchange/MIC and validates the exact returned listing and column
count. Financial statements must have both USD listing currency and USD
reporting currency. It never relabels an ADR's foreign reporting currency as USD.
Scanner snapshots need no API key. Full financial histories and dated earnings
use Trader's authenticated Python helper and a bounded TradingView quote
WebSocket session. The local profile selects TradingView for both fundamentals
and earnings.

Top-level revenue, income, cash flow, profitability and liquidity metrics use
explicit FY columns. Valuation multiples preserve their TTM/forward definitions.
The provider converts percentage-point fields to canonical fractions once;
monetary amounts stay in dollars and expenses/cash outflows keep their source
signs. Altman Z has a TTM label and Piotroski an annual label. Source-calculated
ratios are retained because adjusted and unadjusted income definitions can differ.

`annualFinancials` joins available revenue, gross profit, EBITDA, net income,
diluted EPS, assets, debt and free-cash-flow histories to explicit fiscal years.
Array length mismatches are omitted rather than shifted. `fiscalForecasts`
joins EPS/revenue records on explicit fiscal periods and reported flags; future
rows cannot carry actuals. These forecasts are fiscal-quarter EPS/revenue
consensus, not annual forecasts. The financial-history adapter obtains up to
40 explicit FY/FQ labels with 19 statement measures, including operating,
investing and financing cash flow. Earnings uses a separate, explicitly matching
fiscal-period/release-date axis; AAPL live validation returned 20 annual periods,
32 quarters and eight dated earnings events. Source-reported and statement EPS
remain distinct. The optional `google-finance-earnings` role obtains dated earnings from the website's
`batchexecute` endpoint, parses only the observed `wKsYyb` JSON envelope, and
keeps reported EPS definitions separate from financial-statement EPS.

The optional Yahoo `research` role reads quote-summary ownership and short
interest, nine quarterly financial series, and chart dividend/split events.
Quarterly rows retain the source's period-ending date; calendar quarters are
not invented as fiscal labels. It requests six years of statement history,
returns up to 24 available quarters, and bounds corporate actions to five years.
Each dataset has its own provenance and coverage state so one failed source
does not erase the others. These are aggregate ownership/short-interest fields,
not raw SEC filings or a FINRA dataset.

When fundamentals uses TradingView, the runtime requests Yahoo ownership and
corporate actions without its financial timeseries. The financial arrays are
supplied by TradingView, with independent coverage/provenance and no silent
Yahoo statement fallback. Google Finance earnings remains explicitly selectable.
PER, forward PER and PEG prefer TradingView's own positive reported values.
Missing multiples can be derived from the same scanner response: close / diluted
EPS TTM, close / estimated EPS NTM, and a separately labeled historical PEG using
TTM diluted-EPS YoY percentage growth. Formula, inputs and period are returned;
missing or nonpositive earnings/growth are not turned into a multiple.
StockAnalysis/TwelveData valuation fallback requests and code are removed.

The financial scanner caches at most 200 symbols for 15 minutes by default
(configurable up to one hour), deduplicates concurrent callers, and caps both
request duration and response size. The `.env.example` explicitly selects a
one-hour financial cache. These site-internal endpoints are not guaranteed
public API contracts; availability and schemas can change independently.
No browser scraping or paid-page bypass is used by these implemented adapters.

### Python TA-Lib indicators

`GET /api/v1/indicators` returns the 129-function calculation catalog;
`POST /api/v1/indicators/calculate` accepts canonical OHLCV and up to eight
indicator specifications. `GET /api/v1/symbols/:symbol/technicals` fetches bars
through the selected Trader provider and calculates the requested functions,
retaining bar adjustment, warnings, coverage metadata, provenance and data mode.
The CLI exposes `technical-indicators` and `technicals`.

Calculations use Python TA-Lib in Trader's authenticated helper, with no Midas
or external indicator API. Requests are bounded to 10,000 ordered unique bars,
eight functions, 3 MB input and two concurrent helper calculations. Only named
TA-Lib functions and validated numeric parameters/OHLCV input mappings are
accepted. Initial lookback rows and non-finite outputs remain null; no future
bars, interpolation or implicit adjustedClose substitution is used. Results
include the exact input time labels, effective parameters and engine version.
The stock technicals screen adds a searchable library with parameter edits and
history charts. Existing TypeScript chart indicators and the 26-indicator
rating retain their established calculation policy.

FMP is retired: its provider ID is absent from the registry and role allow-lists,
its adapter is removed, and `FMP_*` values are excluded from provider environment
forwarding. Existing overrides selecting that retired ID fail as unknown providers.

### Google Finance + Benzinga analyst consensus

The `google-finance` adapter fetches the English Analysis-page HTML and extracts
the `data` array passed to `AF_initDataCallback`. It parses only literal JSON
arrays and never evaluates the page's inline JavaScript. It validates the
requested symbol and exchange against the page's instrument data, then maps the
analyst rows into Trader's canonical events. Select the composite provider to
merge those events with Benzinga:

```dotenv
TRADER_ANALYST_PROVIDER=google-finance-benzinga
```

The composite fetches constituent rating events from both vendors, keeps the
latest event per canonical firm in the trailing three calendar months, and only
then recalculates low, average, median, and high. It never averages two vendor
aggregates. On the same day, a non-empty rating or target can fill the other
source's missing field; conflicting non-empty values deterministically prefer
Google Finance and are exposed through `constituents[].conflictFields`. A newer-day
no-target event remains a tombstone instead of reviving an older target.
`ratingCount` and `priceTargetCount` are separate, while legacy `analystCount`
remains the target count. Any one-source failure returns the surviving source
with partial coverage; only a both-source failure is an upstream error.
Merged history is an OR-union: source-exclusive events and conflicting values
remain visible, while only compatible same-firm/day/analyst mirrors are folded.
It also exposes separate
provider-local `consensusItems`, so UI recalculation does not lose a secondary
source operation that supplied one field of a merged row.

Parsed Google Finance callback data is held only in a transient one-hour
in-process cache by default; raw HTML is discarded. The callback key and
undocumented array positions may change;
shape and identity validation therefore fail closed instead of returning a
plausible empty result. Confirm access, caching, display, and redistribution
rights under the applicable Google Finance and Benzinga terms before enabling
this provider outside an authorized deployment. The separately registered
`tipranks` adapter remains available for licensed TipRanks Enterprise access.

For market quotes, the quote snapshot advertises whether the selected provider supports
that SSE contract. On Sites it instead advertises the ordinary HTTPS long-poll
route, which waits inside the Worker for the same guest websocket quote and
returns a completed JSON response without relying on downstream SSE framing.

For current prices, the TradingView adapter derives a direct USD listing from
the resolved instrument MIC (for example `NASDAQ:AAPL`) and talks to the
process-wide Python websocket broker. It does not use `{symbol}USDT.P` for the
equity quote. The latter remains a separate perpetual reference price served by
the snapshot route `/api/v1/watchlists/after-hours` and the same-origin SSE
route `/api/v1/watchlists/after-hours/stream`. Its canonical provider currency
stays `USDT` even when product copy presents the reference value as a
USD-equivalent comparison.

USDT.P is treated as a continuous market: an upstream tick is current through
the exact five-minute age boundary and becomes unavailable immediately after
it. Both the sidecar stream/snapshot and hosted scanner snapshot return a null
close for stale values; the browser independently expires a retained value, so
a reconnect failure cannot keep an old price on screen.

Reference-price routing is deliberately independent from the ordinary equity
`market` provider. With a configured sidecar URL, snapshots and SSE use the
sidecar. Without one, the snapshot route resolves the same server-derived,
ordered `{EXCHANGE}:{symbol}USDT.P` candidates through TradingView's crypto
scanner and the HTTPS long-poll route opens the same guest TradingView quote
websocket used by the local sidecar. It must never substitute a direct USD
aftermarket price.

Keep `TRADER_TRADINGVIEW_SIDECAR_TOKEN` server-side. Local development may use
loopback HTTP. An external sidecar must use HTTPS plus a bearer token. Hosted
Sites can use the server-side scanner snapshot fallback and Worker-native
TradingView websocket long polling without a sidecar. The browser must never connect to
either upstream directly.

## Add a provider

Adding a new provider remains an explicit, reviewed code change:

1. Add `api/<provider-id>/index.server.ts` with a manifest and adapter.
2. Add one static import/entry to [`api/index.server.ts`](./index.server.ts).
3. Add its allowed roles to [`provider-roles.ts`](./provider-roles.ts).
4. If credentials are required, add only their environment names to
   [`environment.ts`](./environment.ts).
5. Select the ID in [`config.json`](./config.json), add contract tests, and run
   `npm run config:check`.

The registry is deliberately static. Do not use a JSON-derived dynamic import:
that would weaken path, bundling, and server-only security boundaries.

## What JSON does not control

Formulas, units, provenance rules, network allow-lists, licensing policy, and
vendor-response parsing remain reviewed code. The optional synthetic reference
close uses the TradingView sidecar, while company-logo policy lives in
[`src/app/platform/company-logo.ts`](../src/app/platform/company-logo.ts).
The local `/api/v1/symbols/:symbol/logo` route resolves TradingView's `logoid`
server-side and redirects only to the reviewed TradingView symbol-logo origin.
Unknown or malformed logos remain unavailable.
