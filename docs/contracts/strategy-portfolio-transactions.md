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

## First-read initialization

The first GET for each known built-in `(ownerId, strategyId)` atomically seeds
five U.S.-equity sample transactions and writes a versioned audit marker.
Unknown or retired catalog IDs return `404 strategy_not_found` before D1 is
accessed. Later reads never
infer initialization from an empty result, so a future delete/import workflow
can intentionally leave a portfolio empty without the fixture returning.
Concurrent first reads use deterministic seed IDs and the same audit marker,
preventing duplicate rows.

Every query includes the request-scoped `owner_id`. A non-loopback request
without a Sites user ID returns `401 authentication_required` before D1 is
accessed. Chart bars, quotes, fundamentals, provider raw responses, and
backtest result blobs remain outside D1.
