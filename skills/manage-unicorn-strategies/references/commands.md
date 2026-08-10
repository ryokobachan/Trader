# Unicorn strategy CLI payloads

All commands return JSON. The default API is `http://localhost:3001`; override it with `UNICORN_BASE_URL` or the global `--base-url` option.

## Discovery and comparison

`list` fetches the owner-scoped strategy collection once, then applies these read-only filters locally:

| Option | Meaning |
|---|---|
| `--query <text>` | Case-insensitive substring search across ID, name, headline, category, and source labels |
| `--origin built_in\|custom` | Exact origin |
| `--family portfolio2\|rule\|research` | Exact strategy family |
| `--status pinned\|research` | Exact status |
| `--provenance <value>` | Exact performance provenance |
| `--category <text>` | Case-insensitive exact category |
| `--source <text>` | Case-insensitive exact source label |
| `--sort <field>` | `id`, `name`, `candidateAt`, `updatedAt`, or a performance field |
| `--order asc\|desc` | Direction; requires `--sort` |
| `--limit 1..1000` | Maximum returned matches |

Performance sort fields are `netReturn`, `maxDrawdown`, `recoveryFactor`, `sharpe`, `forwardReturn`, `winRate`, `trades`, `symbols`, and `cash`. Null values sort last in both directions. The response adds `selection` with total, matched, and returned counts while preserving the API strategy records.

Compare two to twenty registered IDs:

```bash
npm run strategy -- compare sample.a sample.b --sort sharpe --order desc
```

The comparison response groups IDs by provenance and reports `execution: "not_run"`. It is a structured view of stored metadata, not a backtest, rule engine, candidate generator, or parameter search. Do not rank incompatible methodologies merely because their numeric fields share a name.

## Strategy create payload

Required fields:

```json
{
  "name": "AAPL trend research",
  "headline": "Research a 50/200-day moving-average rule on AAPL."
}
```

Optional fields include `family`, `status`, `category`, `sourceLabels`, `audit`, and `performance`. Use only fields accepted by the current API; unknown fields fail closed.

Within `performance`, `cash` means a percentage allocation. For built-in
`illustrative_catalog` records, `trades` and `symbols` describe the sample and
do not equal the number of persisted transaction rows.

## Strategy edit payload

Include the current version returned by `get`:

```json
{
  "expectedVersion": 3,
  "name": "AAPL trend research v2",
  "headline": "Updated research description."
}
```

Send only fields that should change. Do not copy server-owned timestamps or owner information into the payload.

## Transaction create payload

```json
{
  "date": "2026-08-10",
  "symbol": "AAPL",
  "side": "buy",
  "shares": 10,
  "price": 313.3,
  "fee": 0
}
```

Supported sides are `buy`, `sell`, and `dividend`. The server normalizes symbols to uppercase. Shares must be positive; price and fee must be non-negative finite numbers.

For idempotent creation, an optional `transactionId` may be supplied. Do not reuse an ID with a different payload.

## Transaction edit payload

Read the transaction immediately before editing and preserve its exact
`updatedAt` value:

```json
{
  "date": "2026-08-10",
  "symbol": "AAPL",
  "side": "buy",
  "shares": 10,
  "price": 314.25,
  "fee": 0,
  "expectedUpdatedAt": "2026-08-10T04:05:06.789Z"
}
```

The CLI also accepts that token as `--updated-at <value>`. Missing tokens fail
before the request; stale tokens return `409 transaction_changed`. Re-read and
review the concurrent change rather than retrying with a newer token blindly.

## Includes

`get <strategy-id> --include transactions,performance` requests aggregate related data. `performance get` is a shorthand for the performance view. Missing metrics remain `null`; never fill them from assumptions.
