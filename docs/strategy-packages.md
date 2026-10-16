# Strategy packages

`strategies/` is the source of truth for deployment-owned strategies. Its
direct children are strategy directories; shared application TypeScript does
not belong there.

Each strategy directory has this compact, exportable layout:

```text
strategies/<strategy-id>/
├── config.json
├── equity.json          # daily value series after a successful current runner run
├── main.py
├── performance.json
├── run.json             # only after a successful run
├── transactions.json
└── src/
```

`config.json` contains the stable ID, localized catalog presentation, Python
entrypoint, required market data, parameters, and backtest assumptions. The
directory name must exactly match `config.json.id`, and the entrypoint is
`main.py:generate`.

`performance.json` and `transactions.json` are the latest read-only run
snapshot bundled with the strategy. Both files identify the strategy and
version. A successful run also writes `run.json`, which records the exact
universe and date bounds, provider and data hash, effective parameters, source
hashes, runtime versions, execution summary, benchmark comparison, and known
limitations. Until a backtest has run, `run.json` is absent, performance uses
`unavailable`, every metric is `null`, and transactions is empty. Do not copy
illustrative metrics from a different strategy.

Current runner versions also write `equity.json`: the initial portfolio value
and the aligned daily strategy/benchmark values used by Trader's measured
asset and monthly-return charts. It carries the same run identity and is
validated against the final value and return in the compact artifacts. Older
executed packages without this optional series remain readable, but Trader
does not invent a chart for them.

`run.json.execution.finalPositions` is the required end-of-run holdings
snapshot as of `run.data.end`. Each row records the symbol, remaining shares,
fee-adjusted average cost, closing mark, market value, portfolio allocation,
and unrealized PnL. The runner derives these values from the same VectorBT
portfolio as the performance artifact and rejects a run unless final assets,
per-symbol asset values, open-trade size and PnL, cash, and final portfolio
value reconcile. These recorded marks must not be replaced with current market
quotes when presenting historical backtest holdings.

The package transaction snapshot is read-only in Trader. Owner-edited
portfolio transactions remain in D1 and are a separate ledger; reads never
seed either source into the other.

`transactions.json` stores filled orders in chronological VectorBT execution
order. This preserves the shared-cash `sellThenBuy` sequence within a bar, so
the artifact can be replayed without inventing temporary borrowing. Trader
displays the snapshot newest first and reverses that execution order within the
same date.

Before development and builds, Trader validates the direct child directories
and generates the bundled catalog used by Cloudflare and the desktop app. Run
`npm run strategies:generate` after changing a package while another process is
already running.

Run a package from the repository's shared VectorBT runtime:

```bash
python3 -m venv venv
venv/bin/python -m pip install -r requirements-strategy.txt
npm run strategy:backtest -- portfolio-golden-cross \
  --symbols AAPL,MSFT,AMZN,GOOGL,JPM,XOM,JNJ,WMT,CAT,NEE \
  --start 2016-01-01 --end 2026-01-01 --write
```

`--end` is exclusive. Without `--write`, the command calculates and prints the
summary without replacing package artifacts. Each invocation runs one package
in a separate Python process so package-local `main.py` and `src/` modules do
not collide.

The runner is for trusted local strategy code only. It imports and executes
`main.py` as Python under the current operating-system user; it is process
isolated for module naming, but it is not a filesystem, network, or resource
sandbox. The launcher forwards only an allowlist of operating-system and Python
runtime environment variables, and the Yahoo provider does not load `.env`, but
those measures do not make an untrusted strategy safe. Inspect externally
received ZIP contents before importing or running them. Any service that runs
third-party strategies must add a real sandbox with a credential-free
environment, restricted filesystem and network access, and resource limits.

The `trader-vectorbt-v1` profile fails closed on unknown execution fields. Its
strategy parameters are numeric `integer` or `number` definitions whose default
must satisfy every declared inclusive or exclusive bound.

## Selection and data boundary

The strategy contract does not prescribe a screening or allocation formula.
`main.py:generate(data, parameters, context)` receives named, aligned
date-by-symbol panels and returns a date-by-symbol `target_weights` panel.
On an explicit row, zero exits a symbol and a positive fraction selects its
target portfolio allocation; an all-`NaN` row means no new rebalance decision.
Rules may live anywhere under the package and may combine every panel supplied
by the runner, so technical rules, fundamental ranking, machine learning, and
mixed models all share the same output interface.

Data acquisition remains outside strategy code so that the runner can record
point-in-time provenance and a content hash. The current CLI adapter supplies
adjusted Yahoo daily OHLCV for technical strategies. The bundled fundamental
example selects a second runner-side profile that combines Yahoo daily prices,
volume and split actions with annual SEC Company Facts. Other datasets can add
another snapshot adapter that emits the same aligned panels and provenance;
this does not require changing the target-weight interface or encoding strategy
rules in JSON. A historical adapter must use values available at each decision
time and include delisted constituents where relevant instead of silently
substituting today's snapshot or universe.

The current runtime profile executes a shared-cash, long-only portfolio and
validates each explicit target row as fractions from zero through one with a
total no greater than one. Strategy code remains responsible for deciding the
desired cash allocation inside that boundary.

### Fundamental screening example

`portfolio-fundamental-quality-value` demonstrates the same target-weight
interface with a quarterly cross-sectional screen. It first requires minimum
price, 20-day dollar volume, market capitalization, freshness, positive latest
annual ROE, and positive latest annual operating-cash-flow-to-assets. Eligible
symbols are ranked 50% on quality (those two latest annual ratios) and 50% on
value (latest annual earnings yield and book-to-market); the top `topN` symbols
receive equal weights.

Its filing-derived panels must be reconstructed point in time. A value may
appear on a decision row only when its filing was public by that time;
restatements must not be copied backward, unavailable facts remain `NaN`, and
`fundamentals_available` remains zero. The sample adapter uses complete annual
10-K accessions starting on the first trading session after the filing date,
restores price and volume to each bar's contemporaneous share unit for nominal
price/liquidity screens, uses Yahoo Close plus split-normalized SEC diluted
weighted-average shares as a screening market-capitalization proxy, and keeps
adjusted Close for execution and valuation. Its
checked-in artifacts are a real measured run over the disclosed fixed
15-symbol universe, not an out-of-sample result. That current-symbol universe
still introduces survivorship and selection bias and must not be presented as
an unbiased estimate of future performance.

Strategy ZIP export should archive one complete strategy directory with these
paths at the archive root. Tests, README files, caches, raw datasets, and
unrelated development files are intentionally excluded from a strategy
package. `run.json` contains the dataset digest and provenance instead of the
raw input panels; `equity.json` contains only the normalized daily value series
needed for display.
