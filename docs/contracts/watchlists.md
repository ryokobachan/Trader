# Watchlist API contract

- Schema: `trader.watchlists.v1`
- Storage: App OLTP D1 binding `DB`
- Owner adapter: stable Sites `oai-authenticated-user-id`; anonymous
  `local-workspace` fallback is accepted only on a loopback request URL

Market prices, bars, fundamentals, and provider payloads are not stored in this
database. Items keep only an instrument reference and display metadata needed
to restore a user's list.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/watchlists` | List all watchlists with ordered items |
| `POST` | `/api/v1/watchlists` | Create with `{ "name": string }` |
| `PATCH` | `/api/v1/watchlists/:watchlistId` | Rename with `{ "name": string }` |
| `DELETE` | `/api/v1/watchlists/:watchlistId` | Delete a list when at least one other list remains |
| `GET` | `/api/v1/watchlists/:watchlistId/items` | Read ordered items |
| `POST` | `/api/v1/watchlists/:watchlistId/items` | Add or idempotently refresh an instrument |
| `DELETE` | `/api/v1/watchlists/:watchlistId/items/:itemId` | Remove one item |
| `PATCH` | `/api/v1/watchlists/:watchlistId/items/reorder` | Replace the complete item order |
| `GET` | `/api/v1/watchlists/quotes/stream?symbols=AAPL,NVDA` | Stream direct-listing USD quotes over same-origin SSE |
| `POST` | `/api/v1/watchlists/quotes` | Batch-fetch current quotes without persisting provider data |
| `POST` | `/api/v1/watchlists/quotes/poll` | Wait over ordinary HTTPS for the next direct-listing USD quote |
| `GET` | `/api/v1/watchlists/after-hours/stream?symbols=AAPL,NVDA` | Stream ticker-derived USDT perpetual reference prices |
| `POST` | `/api/v1/watchlists/after-hours` | Batch-fetch ticker-derived USDT perpetual closes |
| `POST` | `/api/v1/watchlists/after-hours/poll` | Wait over ordinary HTTPS for the next changed USDT perpetual close |

The add-item body is:

```json
{
  "instrumentId": "us_xnas_aapl",
  "symbol": "AAPL",
  "displayName": "Apple Inc.",
  "exchange": "NASDAQ",
  "logoUrl": "/api/v1/symbols/AAPL/logo"
}
```

`instrumentId` and `symbol` are required. A reorder request uses
`{ "itemIds": ["id-1", "id-2"] }` and must include every current item exactly
once. A stale order returns `409 watchlist_order_conflict` so the client can
reload rather than overwrite another change.

## Initialization and durability

The first `GET` creates `Main Watchlist` and seeds AAPL, NVDA, MSFT,
and TSLA in one atomic D1 batch. Initialization runs only when the owner has no
watchlist; deliberately removing every item never triggers reseeding. Every
subsequent mutation batches its audit event with the write. The last remaining
list cannot be deleted (`409 last_watchlist_required`). When the default list is
deleted, the next ordered list is promoted to default in the same D1 batch. A
successful delete response includes `deletedId` and the safe
`nextWatchlistId` the client should activate.

The replacement check is part of the conditional `DELETE` statement. If two
requests race to delete the final two lists, exactly one succeeds; the failed
delete cannot append an audit event or promote a stale default.

Responses use `Cache-Control: private, no-store` and expose `X-Request-Id`.
Errors use `{ "error": { "code", "message" }, "requestId" }` and do not expose
database or provider details. Persisted and watchlist-provider routes return
`401 authentication_required` on a non-loopback request without a Sites user ID.

## Current quote stream and snapshot fallback

When a configured local sidecar is available, the primary browser path is
`GET /api/v1/watchlists/quotes/stream` with one
comma-separated `symbols` query value. It accepts 1–50 unique canonical
U.S.-equity tickers and emits `trader.watchlist-quote-stream.v1` quote events.
The market data provider adapter maps each resolved instrument MIC to its direct USD
listing (for example `NASDAQ:AAPL`). A process-wide sidecar broker shares one
reconnecting upstream websocket session and replays subscriptions instead of
opening one market data provider connection per browser or watchlist row. Trader's
same-origin server route forwards normalized quotes as SSE; the browser never
receives the sidecar URL or bearer token.

The stream is considered healthy only after the first valid quote, not merely
after the HTTP connection opens. If no valid quote arrives within the liveness
window, or if SSE disconnects, the browser keeps the last good value and uses
`POST /api/v1/watchlists/quotes` every 15 seconds as a snapshot fallback. It
reconnects immediately after focus, visibility, or network connectivity returns
and closes the stream while the tab is hidden.

On Sites, where the authenticated frontend does not preserve downstream
WebSocket/SSE frames, the browser instead keeps exactly one ordinary HTTPS
`POST /api/v1/watchlists/quotes/poll` request open. The Worker opens the same
market data provider guest quote session for the direct USD listing IDs, waits up to 20
seconds for a price or observation-time change, returns one completed JSON
response, and the browser immediately issues the next request. Snapshot polling
continues every 15 seconds only as a safety fallback. Each held request is
aborted while the tab is hidden or its symbol set changes.

The current-quote snapshot response includes an explicit `dataMode` of
`provider` or `fixture`, determined by the selected instrument and market
providers. If either role uses the mock provider, the whole response is
`fixture`; only production providers in both roles return `provider`. The browser merges quote values and market-session
observations only from `provider` responses, so mock prices cannot appear as
live watchlist data. The response also includes `streamSupported`. The browser
opens or reconnects the current-quote EventSource only when `dataMode` is
`provider` and `streamSupported` is `true`; the SSE route rejects fixture
providers as well. When the completed snapshot advertises
`longPollSupported`, the browser uses the HTTPS wait path instead of creating
an unsupported stream. This does not select or alter the separate
`{TICKER}USDT.P` reference-price source below.

The non-persistent snapshot body is `{ "symbols": ["AAPL", "NVDA"] }` and has
the same 1–50-symbol limit. A batch-capable adapter performs one upstream
snapshot request for the complete watchlist; otherwise Trader uses bounded
per-symbol concurrency. Cached instrument identities, a short snapshot cache,
and in-flight coalescing prevent adjacent tabs from duplicating vendor work.

Only finite positive, non-older USD quotes replace the last known value. Neither
websocket transport nor SSE is an exchange real-time guarantee: market closure,
market data provider entitlements, and provider delay can leave a valid price unchanged.
Current quotes are not written into the transactional watchlist database. A
hosted Sites runtime must use an externally reachable HTTPS sidecar with a
server-side bearer token; it cannot connect to `127.0.0.1` on a developer Mac.

## Reference-price stream and snapshot fallback

`GET /api/v1/watchlists/after-hours/stream` accepts the same comma-separated,
1–50-symbol boundary as the current-quote stream. It emits
`trader.watchlist-after-hours-stream.v1` quote messages. The local sidecar
opens the market data provider guest quote websocket,
derive every `{TICKER}USDT.P` candidate from the server-owned exchange order,
and use the same auth/session/field/subscription/heartbeat protocol. Browser
input therefore cannot select a raw market data provider source. The local sidecar can
share that upstream session with direct USD listings.

On Sites, the browser uses one ordinary HTTPS
`POST /api/v1/watchlists/after-hours/poll` request because the frontend does
not preserve downstream realtime frames. The Worker opens the same guest quote
session internally, waits for the next changed canonical `{TICKER}USDT.P`
value or a 20-second timeout, returns completed JSON, and closes the upstream
socket. The browser immediately repeats successful requests and backs off only
after an error. This changes the browser transport only; source IDs, exchange
order, USDT contract validation, and UI presentation remain unchanged.

The first configured exchange with a usable tick wins within the current
freshness cohort. For each ticker, a candidate that is five minutes or more
behind that snapshot's freshest candidate is not considered usable, so a stale
higher-priority venue cannot mask a clearly newer lower-priority venue. Because
these contracts trade continuously, a tick older than five minutes is never
presented as current. Exactly five minutes remains usable; after that boundary
the snapshot returns `close: null` and an SSE/client-held value is cleared.
Removing the
reference stream removes only its ref-counted symbols and does not close the
direct-listing stream. The browser should ignore older `updatedAt` values,
retain a last good value only until that same five-minute boundary, and use the
POST endpoint below as its reconnect fallback. A transient network failure
therefore cannot leave an old USDT.P value displayed indefinitely.

The non-persistent reference-price request is `{ "symbols": ["AAPL", "NVDA"] }`
and accepts 1–50 unique canonical U.S.-equity tickers. When the market data provider
sidecar URL is configured, the API makes one authenticated sidecar call. In a
Worker runtime without a sidecar URL, the snapshot endpoint uses one
server-side market data provider crypto-scanner request for the same ordered candidates,
while the HTTPS long-poll endpoint opens the same market data provider quote websocket
used locally. The hosted snapshot advertises long-poll support instead of SSE.
Neither path is selected by
the ordinary equity `market` provider, and neither may silently substitute a
direct USD equity quote. The browser never chooses a raw market data provider source or
performs one upstream request per watchlist row.
Response schema
`trader.watchlist-after-hours.v1` includes `source`, the exact `sourceSymbol`,
and `updatedAt` on every item. A missing `{TICKER}USDT.P` contract is represented
as `close: null`; clients render it as `-`. These reference values are market
data and are not written into the transactional watchlist database. They are
synthetic USDT perpetual reference values, not the direct USD equity quotes
delivered by the current-quote stream and snapshot endpoints. The canonical
currency remains `USDT`; a UI label of `USD` is presentation copy, not a change
to the upstream contract or source symbol.
Snapshot-only clients poll every 15 seconds, accept only non-older upstream
timestamps, and prune values independently when their five-minute lifetime
expires.
