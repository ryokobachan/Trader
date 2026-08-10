# Strategy portfolio transaction API contract

- Schema: `unicorn.strategy-portfolio-transactions.v1`
- Storage: App OLTP D1 binding `DB`
- Owner adapter: stable Sites `oai-authenticated-user-id`; anonymous
  `local-workspace` fallback is accepted only on a loopback request URL

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/strategy-portfolios/:strategyId/transactions` | Return the strategy's transactions in reverse date order |
| `POST` | `/api/v1/strategy-portfolios/:strategyId/transactions` | Persist one transaction and its audit event |
| `GET` | `/api/v1/strategy-portfolios/:strategyId/transactions/:transactionId` | Return one transaction |
| `PATCH` | `/api/v1/strategy-portfolios/:strategyId/transactions/:transactionId` | Replace one transaction's canonical fields |
| `DELETE` | `/api/v1/strategy-portfolios/:strategyId/transactions/:transactionId` | Delete one transaction and retain an audit marker |

The canonical POST body is:

```json
{
  "transactionId": "optional-client-idempotency-id",
  "date": "2026-08-09",
  "symbol": "AAPL",
  "side": "buy",
  "shares": 10,
  "price": 231.41,
  "fee": 0
}
```

`transactionId` is optional; the server creates a UUID when omitted. Repeating
the same ID and payload returns the existing row with HTTP 200. Reusing an ID
with different content returns `409 transaction_id_conflict`. New rows return
HTTP 201.

The canonical `side` values are `buy`, `sell`, and `dividend`. Japanese UI
labels map as follows:

| API | UI |
|---|---|
| `buy` | 買付 |
| `sell` | 売却 |
| `dividend` | 配当 |

`date` must be a real `YYYY-MM-DD` calendar date. `shares` must be greater than
zero; `price` and `fee` must be finite, non-negative numbers. Symbols are stored
as normalized uppercase display references, not as market-data records.

PATCH accepts the same canonical fields as POST except `transactionId`, which
comes only from the path, and requires the exact optimistic-lock token returned
by the latest GET:

```json
{
  "date": "2026-08-09",
  "symbol": "AAPL",
  "side": "buy",
  "shares": 10,
  "price": 232.25,
  "fee": 0,
  "expectedUpdatedAt": "2026-08-10T04:05:06.789Z"
}
```

The guarded D1 update matches `owner_id`, `strategy_id`, `transaction_id`, and
the old `updated_at`. A stale token returns `409 transaction_changed`; a row
that no longer exists returns `404 transaction_not_found`. Clients must re-read
after either response and must not retry a stale edit automatically. DELETE is
idempotent after a successful deletion and returns `deleted: false` on a replay.

## Read and idempotency behavior

GET is always read-only. A new strategy starts with an empty transaction list;
no demo data is installed implicitly. Public demo fixtures under `strategies/`
are source examples only.

POST uses the composite `(ownerId, strategyId, transactionId)` idempotency
boundary. Concurrent requests with the same ID and payload create one row and
one audit event; one response is 201 and replays return 200. If the content
differs, the API returns `409 transaction_id_conflict`.

Unknown, deleted, or inactive strategy IDs return `404 strategy_not_found`
before a transaction mutation. Both built-in and owner-scoped custom strategy
IDs are supported while active.

Every query includes the request-scoped `owner_id`. A non-loopback request
without a Sites user ID returns `401 authentication_required` before D1 is
accessed. Chart bars, quotes, fundamentals, provider raw responses, and
backtest result blobs remain outside D1.
