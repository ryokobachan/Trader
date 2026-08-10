# Watchlist API contract

- Schema: `unicorn.watchlists.v1`
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
| `GET` | `/api/v1/watchlists/after-hours/stream?symbols=AAPL,NVDA` | Stream ticker-derived USDT perpetual reference prices |
| `POST` | `/api/v1/watchlists/after-hours` | Batch-fetch ticker-derived USDT perpetual closes |

The add-item body is:

```json
{
  "instrumentId": "us_xnas_aapl",
  "symbol": "AAPL",
  "displayName": "Apple Inc.",
  "exchange": "NASDAQ",
  "logoUrl": "https://financialmodelingprep.com/image-stock/AAPL.png"
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

The primary browser path is `GET /api/v1/watchlists/quotes/stream` with one
comma-separated `symbols` query value. It accepts 1–50 unique canonical
U.S.-equity tickers and emits `unicorn.watchlist-quote-stream.v1` quote events.
The TradingView adapter maps each resolved instrument MIC to its direct USD
listing (for example `NASDAQ:AAPL`). A process-wide sidecar broker shares one
reconnecting upstream websocket session and replays subscriptions instead of
opening one TradingView connection per browser or watchlist row. Unicorn's
same-origin server route forwards normalized quotes as SSE; the browser never
receives the sidecar URL or bearer token.

The stream is considered healthy only after the first valid quote, not merely
after the HTTP connection opens. If no valid quote arrives within the liveness
window, or if SSE disconnects, the browser keeps the last good value and uses
`POST /api/v1/watchlists/quotes` every 15 seconds as a snapshot fallback. It
reconnects immediately after focus, visibility, or network connectivity returns
and closes the stream while the tab is hidden.

The non-persistent snapshot body is `{ "symbols": ["AAPL", "NVDA"] }` and has
the same 1–50-symbol limit. A batch-capable adapter performs one upstream
snapshot request for the complete watchlist; otherwise Unicorn uses bounded
per-symbol concurrency. Cached instrument identities, a short snapshot cache,
and in-flight coalescing prevent adjacent tabs from duplicating vendor work.

Only finite positive, non-older USD quotes replace the last known value. Neither
websocket transport nor SSE is an exchange real-time guarantee: market closure,
TradingView entitlements, and provider delay can leave a valid price unchanged.
Current quotes are not written into the transactional watchlist database. A
hosted Sites runtime must use an externally reachable HTTPS sidecar with a
server-side bearer token; it cannot connect to `127.0.0.1` on a developer Mac.

## Reference-price stream and snapshot fallback

`GET /api/v1/watchlists/after-hours/stream` accepts the same comma-separated,
1–50-symbol boundary as the current-quote stream. It emits
`unicorn.watchlist-after-hours-stream.v1` quote messages. The sidecar derives
all `{TICKER}USDT.P` candidates from its server-owned exchange order and adds
them to the same process-wide TradingView quote websocket used by direct USD
listings. Browser input therefore cannot select a raw TradingView source.

The first configured exchange with a usable tick wins; a lower-priority source
is used until a higher-priority source becomes available. Removing the
reference stream removes only its ref-counted symbols and does not close the
direct-listing stream. The browser should ignore older `updatedAt` values,
retain the last good value, and use the POST endpoint below as its reconnect
fallback.

The non-persistent reference-price request is `{ "symbols": ["AAPL", "NVDA"] }`
and accepts 1–50 unique canonical U.S.-equity tickers. The API makes one
loopback call to the configured TradingView sidecar, so the browser never
performs one request per watchlist row. Response schema
`unicorn.watchlist-after-hours.v1` includes `source`, the exact `sourceSymbol`,
and `updatedAt` on every item. A missing `{TICKER}USDT.P` contract is represented
as `close: null`; clients render it as `-`. These reference values are market
data and are not written into the transactional watchlist database. They are
synthetic USDT perpetual reference values, not the direct USD equity quotes
delivered by the current-quote stream and snapshot endpoints. The canonical
currency remains `USDT`; a UI label of `USD` is presentation copy, not a change
to the upstream contract or source symbol.
