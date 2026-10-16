# Unified strategy API contract

- Schema: `trader.strategies.v1`
- Storage: validated deployment-owned packages plus owner-scoped D1 custom strategies and package preferences
- Owner adapter: stable Sites `oai-authenticated-user-id`; loopback-only `local-workspace` fallback

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/strategies?locale=en|ja` | List visible built-in and custom strategies |
| `POST` | `/api/v1/strategies` | Create an owner-scoped custom strategy |
| `GET` | `/api/v1/strategies/:strategyId` | Read one strategy; optional `include=transactions,performance` |
| `PATCH` | `/api/v1/strategies/:strategyId` | Edit a strategy |
| `DELETE` | `/api/v1/strategies/:strategyId?expectedVersion=N` | Soft-delete a strategy |

Custom edits require the current positive `expectedVersion`; custom deletes
carry it in the query. A stale value returns `409 version_conflict`. Built-in
edits support only `name` and `headline` and are stored as preferences rather
than rewriting the source package. Package definitions are discovered from
`strategies/<strategy-id>/` and embedded in the server bundle during the build.

Create requires `name` and `headline`. Optional fields are `strategyId`,
`family`, `status`, `candidateAt`, `category`, `sourceLabels`, `audit`, and
`performance`. Unknown fields fail closed. Definitions have strict length,
count, finite-number, and identifier limits before they reach D1.

## Performance provenance

Every record contains a performance object whose numeric values may be null.

| Provenance | Meaning |
|---|---|
| `backtest_artifact` | Metrics recorded by the package's validated backtest result snapshot |
| `illustrative_catalog` | Deployment-owned sample values; not a verified backtest |
| `user_supplied` | Values entered by a user or agent; not independently verified |
| `transaction_snapshot` | Exact facts derived from the stored ledger; currently trade and distinct-symbol counts only |
| `unavailable` | No supported value is available |

The API never infers returns, Sharpe, or drawdown from transactions alone.
`cash` is a percentage allocation. A package with no recorded run uses
`unavailable` and null metrics; values are never copied from another strategy.
An executed package must also contain a matching `run.json` with the data,
source, runtime, configuration, code, and runner hashes used to produce the
performance and transaction snapshots. A missing or mismatched run record
fails package validation during development and build.
An executed package may additionally include `equity.json` with the matching
run identity, initial portfolio value, and aligned daily strategy/benchmark
values. When present, its final values and total returns must reconcile with
`run.json` and `performance.json`; when absent, clients show no measured chart
rather than generating an illustrative replacement.

## Safety

- Every query is scoped by the server-owned owner ID.
- Hosted anonymous requests fail before D1 access.
- Custom deletes are soft, versioned, and audited.
- Responses are `private, no-store` and carry `X-Request-Id`.
- API reads and owner mutations never modify files under `strategies/`.
