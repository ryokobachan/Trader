# Research history in stock details

This feature provides data for the user's own analysis. It does not schedule
analysis, automatically save option observations, or run backtests.

## Available data

| View | Source and coverage | Export |
|---|---|---|
| Current option distribution | Nasdaq, all retrieved strikes for the selected expiration by default; the near-the-money filter is optional | Source table |
| Contract price, volume and open-interest history (default) | ChartExchange public historical table, all rows returned for the selected contract within bounded response limits | CSV and JSON |
| Alternative contract price and volume history | Yahoo Finance, daily OHLCV; request one year, display only the period actually returned | CSV and JSON |
| Cash flows | Yahoo Finance annual and quarterly operating, investing and financing cash flow, where reported | CSV including period, currency, metric, source and retrieval time |

The contract price lookup also accepts an explicit expiration, side and strike,
including expired contracts. A complete list of historical contracts is not
available. Some valid contracts have no retained history at the selected source.
This lookup remains visible when current Nasdaq data is unavailable.

## ChartExchange contract history

The default historical source is ChartExchange, without registration, API keys
or cookies. Trader reads the public **individual contract** historical table,
not the separately authenticated ChartExchange API. It validates the option's
underlying, expiration, side, strike and table schema before returning normalized
OHLC, volume and open interest. Explicit zero counts remain zero; missing cells
remain absent. It neither downloads a complete historical chain nor assumes that
every contract ever listed can be found.

History is retrieved on demand when the panel opens or a contract changes.
Successful results are cached for five minutes, concurrent identical lookups
are shared, and transient failures are briefly cached. Reads have byte, row,
concurrency and time bounds. Restrictions and rate limits are not retried via
another host. A Yahoo Finance selector remains available for price/volume
research, but a failed ChartExchange retrieval never silently changes sources.
External history is available immediately without a local snapshot archive.
CSV and JSON downloads occur only when the user explicitly selects an export.

ChartExchange only labels its daily table with a source session date. The
adapter preserves that date and leaves `time` absent and `sourceAsOf` null;
there is no invented exchange timestamp. The response and CSV mark the
open-interest date basis as `source_session_date_unverified`. For the NBIS
2026-09-11 230 call, the inspected 2026-09-03 source row contained close 3.15,
volume 2,022 and open interest 2,296. Another feed used open interest 823 on that
date, matching ChartExchange's preceding row. This is evidence of a possible
timing difference, not justification to shift dates automatically. An OI-based
point-in-time backtest needs verified clearing/publication availability first.

The UI offers price, volume and open-interest charts. Its OI change is relative
to the preceding available OI observation and names that comparison date; it
does not call a gap-spanning difference a one-day change. CSV preserves source
URL, retrieval time, source date basis and missing original timestamps. Historical
IV, Greeks and bid/ask are not supplied by this adapter.

## Meaning and limitations

- Each financial statement series keeps its own reporting frequency and source.
  Cash flows use signed bars around a shared zero; missing values are marked,
  not replaced by zero. Financial CSV files contain raw currency values, not
  the chart's display scale. Future reporting periods are rejected as historical
  actuals.
- Historical financial figures are the versions available from the source now.
  A reporting period end is not a publication time. A point-in-time fundamental
  backtest requires original filings, amendments and their publication times;
  this view does not provide that archive.
- Option price charts use daily session dates in the source timezone and do
  not bridge explicit missing observations. Price is USD per underlying share;
  volume and open interest are contract counts. CSV missing values stay blank.
  Source price adjustments are not verified, and adjusted-close substitution
  is not performed.
- Nasdaq retrieval time is when Trader fetched a chain, not a verified
  exchange quote timestamp. A fresh retrieval can return unchanged prices;
  retrievals must not be interpreted as separate trades.
- ChartExchange supplies externally retained contract open interest from before
  local collection began. A complete past strike distribution is not inferred
  from one contract or the current chain. Yahoo OHLCV history does not contain
  historical open interest, implied volatility, or the bid/ask at each trade.
- Open-interest changes represent net contract changes after clearing. They
  cannot identify a specific large order as a purchase, sale, opening or closing
  trade. A daily last price multiplied by volume is not verified order premium.
  Strike coverage does not define the stock's maximum upside or downside.

## No local option archive

At the user's request, the local option archive, its read/write API, Python
storage module, archive metadata and saved-distribution panel have been removed.
Opening the panel,
changing expiration, switching sources and reloading history do not write an
options archive. Both current chains and external contract histories use bounded
in-memory caches only. Responses and browser requests use `no-store` to avoid
persisting these responses in the browser's HTTP cache. User-triggered CSV/JSON
downloads remain available.

The six old saved observations and their SQLite index under
`var/research/options` were deleted on 2026-09-06. This does not affect external
contract history, explicit downloads, or strategy and research outputs.

## Routes

- `GET /api/v1/symbols/:symbol/options` defaults to all strikes and returns the
  current chain without saving it.
- `GET /api/v1/symbols/:symbol/options/prices?contractId=...` returns contract
  daily history from ChartExchange; symbol identity must match the contract.
  `source=chartexchange` is explicit equivalent; `source=yahoo` selects Yahoo's
  price/volume history. Optional `from=YYYY-MM-DD` and `to=YYYY-MM-DD` filter the
  source's original daily date labels inclusively. Either bound may be omitted;
  omitting both preserves the complete provider response. Expired contracts are
  accepted when the chosen provider retains them. Invalid calendar dates, empty
  bounds, reversed bounds, duplicate parameters and unsupported parameters return
  HTTP 400 before a provider lookup. Selected-source failures do not switch feeds.

  Example (no UI, registration or local save required):
  `/api/v1/symbols/NBIS/options/prices?contractId=NBIS270115C00200000&source=chartexchange&from=2026-08-01&to=2026-08-31`

  A filtered response keeps `coverage` unchanged as the **original provider
  coverage** and includes `requestWindow` with the supplied bounds. Its `items`
  contain only matching rows; `filteredCoverage` describes those returned items
  with `firstDate`, `lastDate`, `returnedBars`, `observedBars` and `missingBars`.
  A source row is observed when any OHLC, volume or open-interest value is
  present, including zero. `missingBars` counts returned rows with all these
  fields absent, not unlisted calendar or trading days. A valid window containing
  no source rows returns HTTP 200, `items: []`, zero filtered counts and null
  filtered first/last dates. The original source date labels, quote timestamps,
  source URL, retrieval time and OI date-basis metadata are unchanged. Filtering
  never extends the provider's available period, fills gaps or shifts OI dates.
  Yahoo therefore remains limited to its available one-year response even when
  an older `from` is requested. Responses retain `Cache-Control: no-store`.
- The obsolete `/options/history` and sidecar `/v1/research/options` routes have
  been removed. The supported CLI `trader data get options-history` continues
  to use `/options/prices` for external contract history.

## Source references

- [ChartExchange: NBIS January 2027 200 call history](https://chartexchange.com/symbol/opra-nbis20270115c200/historical/)
- [ChartExchange: NBIS September 2026 230 call history](https://chartexchange.com/symbol/opra-nbis20260911c230/historical/)
- [ChartExchange policies](https://chartexchange.com/policies/)
- [OIC: general information and open interest](https://www.optionseducation.org/referencelibrary/faq/general-information)
- [SEC: filing and company data APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [ThetaData: historical end-of-day options data](https://docs.thetadata.us/operations/option_history_eod.html)
- [ThetaData: historical open interest](https://docs.thetadata.us/operations/option_history_open_interest.html)

ThetaData is a potential additional source that requires its terminal/account;
it has not been connected. Historical open interest is not part of its free
end-of-day feed. No paid feed or account signup is included in this change.

## Historical verification on 2026-09-05 (archive since removed)

- The full contract suite passed 679 tests. Python archive/packaging checks
  passed 19 tests; existing sidecar/desktop checks passed 18. Type checking,
  targeted lint and the application build passed.
- Live NBIS all-strike retrieval returned 178 contracts at 89 strikes, from
  90 to 385 USD, for 2026-09-11. The observation survived a LaunchAgent
  restart. Its 230 call history matched the saved chain: bid 8.10, ask 8.45,
  last 8.40, open interest 2,296 and volume 5,772.
- Live 230 call daily history contained 29 source rows, with 25 valid price
  observations and four explicit gaps. The UI showed the gaps, price/volume
  switching and keyboard date selection. Manual lookup of the 2027-02-19
  260 call also returned its own history.
- Live CF data included four annual and five quarterly periods, each with
  all three CF categories. The annual/quarterly graph and source table were
  inspected in the desktop browser. A downloaded quarterly CSV was verified
  to contain the original raw values and provenance.
- Current prices, historical prices and saved observations are distinct
  views. Only one observation initially existed, so the archive correctly
  displayed a collection message instead of inventing a historical trend.
- The local service required a warm restart after building; cold SSR was
  slow before recovering. Once warm, the root endpoint returned 200 in
  approximately 0.1 seconds. No speculative server changes were made.
  A packaged desktop binary and a separate mobile/touch viewport were not
  exercised.

## ChartExchange verification on 2026-09-06 (before archive removal)

- All 706 contract tests, TypeScript checking, targeted ESLint and the application
  build passed. Parser tests cover exact contract identity, decimal strikes,
  malformed tables, invalid values, date ordering, size/time bounds, redirects,
  access restrictions and deduplication.
- Live localhost requests returned the NBIS January 2027 200 call's 225 daily
  rows (2025-10-13 through 2026-09-03), with original date labels and no invented
  timestamps. The UI displayed that same source URL, interval and series.
- The September 2026 230 call showed 26 rows and open interest 2,296 on the last
  date, with +1,473 versus the preceding observation. The 227.5 call showed
  eight rows; keyboard date selection and price/volume/OI switching worked.
  Selecting Yahoo hid OI and showed its separate 29-row price history.
- The saved-distribution panel was absent. Current-chain and history requests
  returned `Cache-Control: no-store` and no archive metadata. Comparing all
  seven existing archive files before and after those requests showed identical
  file counts, sizes and modification times. No automatic download was made.
- The root page, NBIS ownership page and contract-history endpoint returned
  HTTP 200. The persistent LaunchAgent remained running after verification.
