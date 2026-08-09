# Strategy preference API contract

- Schema: `unicorn.strategy-preferences.v1`
- Storage: App OLTP D1 binding `DB`
- Owner adapter: stable Sites `oai-authenticated-user-id`; anonymous
  `local-workspace` fallback is accepted only on a loopback request URL
- Catalog source: immutable `SAMPLE_STRATEGY_DEFINITIONS`

This API stores only owner-specific presentation overrides and soft-delete
tombstones. It never rewrites the deployment-owned sample definition, strategy
portfolio transactions, market data, or backtest artifacts.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/strategy-preferences` | List the current owner's overrides and tombstones |
| `PATCH` | `/api/v1/strategy-preferences/:strategyId` | Upsert `name` and/or `headline` overrides |
| `DELETE` | `/api/v1/strategy-preferences/:strategyId` | Soft-delete one visible built-in strategy |

PATCH accepts at least one of these fields and rejects all other fields:

```json
{
  "name": "Technology Core",
  "headline": "Hold a customized equal-weight technology basket."
}
```

`name` is 1–120 characters and `headline` is 1–500 characters after Unicode
normalization and trimming. DELETE returns both `deletedId` and the persisted
`preference` tombstone. Repeating DELETE is idempotent and returns the same
tombstone.

The client merges each returned override into its locale-specific built-in
record and hides records with `isDeleted: true`. Rows absent from GET use the
unmodified built-in definition. GET filters out rows for IDs no longer present
in the current deployment catalog.

## Safety and ownership

- Every query is scoped by the server-owned `owner_id`; requests cannot choose an owner.
- A non-loopback request without a Sites user ID fails closed with
  `401 authentication_required` before D1 is accessed.
- IDs must exist in `SAMPLE_STRATEGY_DEFINITIONS`; unknown IDs return
  `404 strategy_not_found` before D1 is accessed.
- Editing a tombstoned strategy returns `409 strategy_deleted`. Restoration is
  intentionally not part of version 1.
- Deleting the final visible strategy returns `409 last_visible_strategy`.
- Mutations append owner-scoped `strategy_preference` audit events.
- Responses are `private, no-store`, include `X-Request-Id`, and use
  `{ "error": { "code", "message" }, "requestId" }` for failures.

The composite `(owner_id, strategy_id)` primary key is the upsert boundary. The
schema constrains override lengths and requires every stored row to contain an
override or tombstone. Market prices, bars, fundamentals, provider payloads,
and strategy transaction rows remain in their dedicated stores.
