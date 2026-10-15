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
    "fundamentals": "yahoo",
    "earnings": "yahoo",
    "analyst": "benzinga",
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
| `yahoo` | [`yahoo/index.server.ts`](./yahoo/index.server.ts) | Yahoo-compatible Search, Chart, Fundamentals and News endpoints |
| `fmp` | [`fmp/index.server.ts`](./fmp/index.server.ts) | FMP stable endpoints |
| `benzinga` | [`benzinga/analyst.server.ts`](./benzinga/analyst.server.ts) | Benzinga ratings calendar |
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
  index.server.ts          normalized provider implementation
stock-detail/
  ids.ts                   allowed metric and tab IDs
  metrics.ts               canonical data-to-view calculations
```

Thus, changing Yahoo balance-sheet fields starts in
[`yahoo/fundamentals/bs.ts`](./yahoo/fundamentals/bs.ts); changing chart access
starts in [`yahoo/chart.ts`](./yahoo/chart.ts).

For fields already normalized by a provider, visibility and order are controlled
only by `config.json`. The allowed stock-detail IDs and their view-model
calculations are colocated in [`stock-detail/ids.ts`](./stock-detail/ids.ts) and
[`stock-detail/metrics.ts`](./stock-detail/metrics.ts). A genuinely new vendor
field still needs an explicit canonical DTO addition so units and provenance
cannot be inferred incorrectly.

## Provider roles

| JSON role | UI data |
|---|---|
| `instrument` | U.S. stock search and symbol identity |
| `market` | current quote and watchlist price |
| `bars` | OHLCV chart candles |
| `profile` | company description and profile |
| `fundamentals` | normalized financial metrics |
| `earnings` | actual and estimated earnings |
| `analyst` | consensus and rating history |
| `news` | company news |

The UI calls only Trader routes such as `/api/v1/instruments/search`,
`/api/v1/symbols/:symbol/workspace`, `/api/v1/symbols/:symbol/bars`, and the
same-origin `/api/v1/watchlists/quotes/stream` SSE endpoint. Provider files
normalize vendor responses into the canonical DTOs in
[`src/app/platform/provider-contracts.ts`](../src/app/platform/provider-contracts.ts).
The quote snapshot advertises whether the selected market provider supports
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
websocket used by the local sidecar. It must never substitute an FMP or other direct USD
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
