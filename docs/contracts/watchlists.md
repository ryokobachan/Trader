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
| `POST` | `/api/v1/watchlists/quotes` | Batch-fetch current quotes without persisting provider data |
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

## Reference close batch

The non-persistent reference-price request is `{ "symbols": ["AAPL", "NVDA"] }`
and accepts 1–50 unique canonical U.S.-equity tickers. The API makes one
loopback call to the configured TradingView sidecar, so the browser never
performs one request per watchlist row. Response schema
`unicorn.watchlist-after-hours.v1` includes `source`, the exact `sourceSymbol`,
and `updatedAt` on every item. A missing `{TICKER}USDT.P` contract is represented
as `close: null`; clients render it as `-`. These reference values are market
data and are not written into the transactional watchlist database.
