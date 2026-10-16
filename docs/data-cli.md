# Trader data access

Trader has one read interface for the app, AI agents and other applications.
The versioned catalog defines dataset IDs, parameters, input/result classification,
source, history limits and paths to native data/provenance. The CLI, HTTP API and
Data screen use this same definition. Retrieval does not run a backtest, collect
new X/13F source material, or save option datasets.

## Start and discover

The user-owned local server normally runs at `http://localhost:3001`.
Reuse it. For a separate installation, install repository dependencies and use
`npm run dev:tradingview`; it starts the authenticated Python helper and the app
using Trader's own `.env.local`. Midas is not required. The older `dev:midas`
launcher name is a compatibility alias for this standalone profile.

```sh
./bin/trader data sources
./bin/trader data sources --category input
./bin/trader data sources --category result
./bin/trader data sources --subject macro
./bin/trader data sources --backtest usable
./bin/trader data describe institutional-holdings
./bin/trader data openapi
```

`sources`, `describe` and `openapi` work without a running server. Categories are
`input`, `result`, `snapshot`, `metadata`. Backtest suitability is `usable`,
`conditional`, `analysis-only`, `result-only`, `not-applicable`. Discovery is a
capability description, not proof of current provider availability.

## Get data

```sh
./bin/trader data get bars --symbol AAPL --interval 1d --range 5y --count 1000
./bin/trader data get technicals --symbol AAPL --indicators RSI,MACD,MFI --count 500
./bin/trader data get financials --symbol AAPL
./bin/trader data get analyst-ratings --symbol AAPL --from 2026-01-01 --to 2026-06-30
./bin/trader data get corporate-actions --symbol AAPL
./bin/trader data get fred --series UNRATE --date 2026-06-30
./bin/trader data get sec-facts --symbol AAPL --date 2026-06-30
./bin/trader data get finra-short-volume --symbol AAPL --date 2026-09-04
./bin/trader data get institutional-filings --institution 1067983 --limit 10
./bin/trader data get institutional-holdings --institution 1067983 --symbol AAPL --period 2026-06-30 --limit 50
./bin/trader data get x-mentions --symbol AAPL --from 2026-08-01 --to 2026-08-31 --limit 50
./bin/trader data get x-author-strategies --limit 10
./bin/trader data get strategy-list
./bin/trader data get strategy-equity --strategy portfolio-golden-cross
./bin/trader data get strategy-holdings --strategy portfolio-golden-cross
```

Dates in examples are explicit requested periods, not guaranteed coverage.
`from`/`to` are inclusive source event dates. The catalog describes which event
field each dataset uses. `date` in FRED selects a publication vintage; SEC uses a
filing-date cutoff; FINRA requires the exact trading date. These are distinct
contracts and are not silently translated into one another.

Commands print the original JSON to stdout. Errors are JSON on stderr with exit
code 1 for API/network errors or 2 for invalid arguments. Exit 0 can mean partial
or empty data. No output is automatically saved. `--base-url` overrides
`TRADER_BASE_URL` (default `http://localhost:3001`); `--timeout-ms` defaults to
60000, maximum 120000. Run `./bin/trader data describe <id>` for every supported
parameter and native response path. Existing `trader strategy` commands remain
separate; no strategy mutation is exposed under `data`.

Options retain exact identity and explicit source semantics:

```sh
./bin/trader data get options-history --symbol NBIS --contract NBIS270115C00200000 --from 2026-01-01 --to 2026-03-31
./bin/trader data get options-history --symbol NBIS --expiration 2026-04-17 --side put --strike 89
```

Contract OR the complete expiration/side/strike tuple is required. Expired
contracts do not require a current chain. No saving, date shifting, filling,
implicit provider switching, historical-chain reconstruction or retention
guarantee is added. OI availability time remains unverified.

## Independent shared finance store

The authenticated Trader Python helper reads these existing producer-owned
files directly with SQLite `mode=ro`, `query_only`, a read transaction and a query
deadline. It never copies the DB, migrates its schema, creates indexes or starts
the producers.

```text
develop/.data/finance/13f/state/producer.sqlite
develop/.data/finance/x/state/producer.sqlite
```

`TRADER_SHARED_DATA_ROOT` is the `.data` directory, not a database path or the
`finance` subdirectory. Source development defaults to the sibling `.data`.
A packaged desktop helper needs this environment setting for its store location.
The helper module is included in desktop packaging; rebuilding/installing the
packaged desktop application is a separate operation.

| Dataset | Contents | Role |
|---|---|---|
| institutional-filings | 13F submission metadata, periods, acceptance, amendments | Input, conditional |
| institutional-holdings | Filing-level positions, shares, USD values, symbols | Input, conditional |
| institutional-managers | Observed popular-manager directory | Directory; not historical universe |
| x-posts | Raw posts, source, publication/ingestion times | Historical analysis |
| x-mentions | Symbol mentions, extraction and current judgment versions | Historical analysis |
| x-prices | Stored daily price rows with source/update time | Price input, conditional |
| x-mention-outcomes | Post-entry outcomes, costs and strategy versions | Results |
| x-author-scores | Currently retained author-score versions | Results |
| x-author-strategies | Author shadow-strategy run results | Results |
| x-accounts | Stored account directory | Directory |

13F validates its in-DB publication manifest against a succeeded producer run,
slot, domain binding and schema digest. Pending accession bundles are withheld.
X validates `current.json` against the succeeded run/slot and schema contract.
This validates the published contract, not a rerun of all producer quality tests.

Both stores are **mutable live WAL databases**. `provenance.revision` is a
publication marker, not an immutable historical snapshot. Each page has its own
read transaction. A revision change during pagination returns HTTP 409; consumers
must explicitly restart instead of combining revisions. Updates within a live
publication are still possible. `asOf` conservatively filters the versions
currently retained using source availability, ingestion and update timestamps;
it does not recover overwritten versions or certify historical completeness.
13F amendments remain separate, and period end is not disclosure time.

Shared responses preserve `rows`, `columns`, `source`, `provenance`, `coverage`,
`pagination` and `warnings`. **Follow `pagination.nextCursor` even when a page has
zero rows.** Sparse filters can need multiple bounded scan windows. Pagination is
in storage row order, not chronological order. Sort the retrieved observations
by their event dates before analysis. Prefer institution/accession filters for
large 13F holdings queries; a symbol-only query has no source index.

```sh
./bin/trader data get x-mentions --symbol AAPL --limit 50 --cursor '<nextCursor from the previous response>'
```

Keep filters unchanged. Changing the dataset or filters invalidates the cursor.
Max page size is 1000; the reader also enforces scan, time and byte limits.
Current X classifications, outcomes and author scores must not be treated as
signals known at an older post's publication time.

## HTTP and embedded access

```text
GET /api/v1/data?category=input
GET /api/v1/data/<dataset>/describe
GET /api/v1/data/<dataset>?<parameters>
GET /api/v1/data/openapi.json
```

```sh
curl 'http://localhost:3001/api/v1/data/institutional-holdings?institution=1067983&symbol=AAPL&limit=50'
```

The canonical API dispatches in-process to existing provider handlers; it does
not make a loopback HTTP request to itself. Native response contracts, status,
coverage, errors and owner authorization are preserved. Responses add
`X-Trader-Dataset`, `X-Trader-Catalog-Version`, `X-Request-Id` and a
`Link: rel="describedby"` header. The catalog's `parameterSchema` and OpenAPI 3.1
support other apps; `metadataPaths` locates arrays/provenance in each native body.
Trader server code can call `getDataResponse(request, dataset)` from
`api/data/route.server.ts` with the original request's owner/auth context.

Provider secrets remain server-side. The helper only accepts fixed dataset IDs
and known filters through authenticated endpoints; callers cannot supply SQL or
filesystem paths. No wildcard cross-origin access or public deployment is added.
Other local applications can use the HTTP API; a separate browser origin needs
its own server proxy or an explicitly configured access layer.

Historical packaged strategy positions are labelled `basis=backtest_end`.
Ledger-backed positions use `basis=current_ledger`; missing marks stay null and
have coverage metadata. A package's final positions are not relabelled current.
The old Midas institutional/X response schemas cannot be recreated from raw 13F
holdings: those endpoints return HTTP 410 with replacement dataset links.
`midas-data-sources` is a deprecated alias for the local catalog. The previously
excluded Ideas feature retains its legacy integration and is outside this data
foundation.

## Local MCP clients

Four read-only stdio MCP servers live under `mcp/`: Market, 13F, X Finance
and Strategy. Market bundles the upstream handlers and its Python helper and
runs on another Mac without Trader; it requires Node.js, Python and the pinned
Python dependencies. The other three are local-only clients of this Mac's canonical
Trader HTTP API. The distributed folders contain only text, with no special
Codex config file and no npm installation at runtime. See [Trader MCP](mcp.md)
for setup through Codex, tool boundaries and status semantics.

## Python / JavaScript

Both clients have no runtime dependencies, return native JSON, reject redirects,
limit response bytes and bound page iteration. They do not collect or save data.

```sh
python3 -m pip install ./clients/python
```

```python
from trader_data import TraderDataClient

client = TraderDataClient()
print(client.sources(category="input"))
print(client.describe("institutional-holdings"))
page = client.get("institutional-holdings", institution="1067983", symbol="AAPL", limit=50)

# Explicit limit; raises page_limit if more pages remain rather than silently truncating.
for page in client.iter_pages("x-mentions", symbol="AAPL", limit=100, max_pages=10):
    print(page["rows"], page["coverage"], page["provenance"])
```

```js
import { TraderDataClient } from './clients/javascript/trader-data.mjs';
const client = new TraderDataClient({ baseUrl: 'http://localhost:3001' });
const data = await client.get('bars', { symbol: 'AAPL', interval: '1d', count: 500 });
for await (const page of client.pages('x-mentions', { symbol: 'AAPL' }, { maxPages: 10 })) {
  console.log(page.rows, page.coverage, page.provenance);
}
```

Use an absolute import path from another project, or install `clients/javascript`
as a local `@trader/data-client` dependency. Python can also use
`PYTHONPATH=/absolute/path/to/Trader/clients/python` without installation.

See [investment data inventory](data-inventory.ja.md) for input/result suitability.
