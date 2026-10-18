# Midas / Trader data-source comparison

Checked against both working trees and bounded live requests on 2026-09-06.
This describes acquisition and usable data, rather than merely a provider name
in a catalog. Neither Midas databases nor Midas APIs are used by the new adapters.

## Added to standalone Trader research

Updated on 2026-09-07: `/data-sources` now uses the unified Trader catalog,
including direct external sources and independent shared 13F/X stores. Inputs
and comparison results are separate filters. There is no Midas catalog mode.
See [data access](data-cli.md) for the common CLI, HTTP/OpenAPI and clients.

| Dataset | Previous Trader coverage | Direct research scope |
|---|---|---|
| SEC filings | No general research API | Up to 100 entries from `submissions.recent`, with original-document links |
| SEC Companyfacts | Already acquired by the strategy runner | Up to 300 selected GAAP observations; units, period, accession and filed date retained |
| SEC Form 4 | Not available | Actual non-derivative transactions from at most four recent XML filings; up to 200 rows |
| FINRA short sale volume | Yahoo short-interest fields are a different dataset | Exact symbol and trade date in the consolidated CNMS daily file |
| USAspending | Not available | Recipient-name search; 365-day scope, at most 50 federal prime contract awards |
| FRED / ALFRED | Not available | Nine selectable rates, inflation, employment, credit and volatility series; up to 100 observations, optional historical vintage |
| CNN Fear & Greed | Not available | Current snapshot and vendor-supplied previous reference values |

In Midas, Form 4, FINRA volume, government awards and SEC fundamentals have
current collection jobs. FRED and CNN also have implementations, but the audit
did not establish equivalent scheduled freshness. Direct Trader results are
fetched on demand, not copied from that state.

### API

```text
GET /api/v1/research/sources
GET /api/v1/research/sources/sec-filings?symbol=AAPL
GET /api/v1/research/sources/sec-facts?symbol=AAPL&date=2026-06-30
GET /api/v1/research/sources/sec-insiders?symbol=AAPL
GET /api/v1/research/sources/finra-short-volume?symbol=AAPL&date=2026-09-04
GET /api/v1/research/sources/usaspending?recipient=LOCKHEED%20MARTIN
GET /api/v1/research/sources/fred?series=DGS10
GET /api/v1/research/sources/fred?series=CPIAUCSL&date=2025-01-15
GET /api/v1/research/sources/cnn-fear-greed
```

SEC routes also accept `cik` instead of `symbol`. If both are supplied, they
must identify the same issuer. SEC `date` limits filing dates within the recent
block; it does not backfill old submissions. FRED `date` requests the vintage
available on that date and is validated against the response revision window.
Unknown sources, unknown/duplicate query parameters and malformed inputs are
rejected. There is no caller-supplied upstream URL.

### Configuration and limits

Set `SEC_EDGAR_USER_AGENT` to a real application/organization and contact email,
and set `FRED_API_KEY` in ignored `.env.local`. FINRA, USAspending and CNN do not
require keys. These values are forwarded to the development worker only through
the reviewed server environment allowlist. Builds omit local credential vars;
hosted deployments require their own server-side secret bindings.

On systems where local workerd cannot connect to USAspending, its adapter uses
Trader's existing authenticated Python helper as a transport fallback. The
helper makes the same fixed, bounded USAspending request; TypeScript still
validates and normalizes its response. This uses the existing
`TRADER_TRADINGVIEW_SIDECAR_URL` and token settings and has no Midas dependency.

SEC requests start at most twice per second per process. All sources have
bounded response sizes, deadlines and in-memory caches; the cache is capped
by both entry count and approximate serialized size. Credentials, raw vendor
errors and credential-bearing URLs are excluded from responses. Missing
credentials return `configuration_required`, vendor failures return an error,
and empty datasets remain distinct from unavailable datasets. No fixture or
stale-value fallback is used. This is on-demand research, not a scheduled
collector, complete historical archive or point-in-time backtest store.

### Interpretation

- FINRA `ShortVolume` already includes `ShortExemptVolume`. The displayed ratio
  is `ShortVolume / TotalVolume`, for reported off-exchange activity only.
  Fractional shares are retained. Volume is not outstanding short interest.
- USAspending reports the original recipient name, including related entities
  returned by its search. No recipient-to-ticker mapping is inferred. The award
  amount is not new spending in the query period or company revenue.
- SEC facts preserve restatements and distinct filing accessions. Report dates,
  filed dates, acceptance times and transaction dates remain separate. Form 4
  amendments are not reconciled into a trading ledger. Missing prices are null.
- FRED values preserve the source's units; a value in `Percent` is not multiplied
  by 100. Latest values may include revisions. Vintage windows are not initial
  release dates.
- CNN's snapshot has its own update timestamp. Exact dates are not invented for
  its prior-week, month or year reference values.

## Already present and remaining differences

Yahoo, market data provider, Benzinga, Google Finance, TipRanks analyst ratings, Stock
Analysis ownership, Nasdaq options and ChartExchange history already existed
in Trader. FMP was explicitly retired and remains disabled.

Institutional portfolios, X analysis, ideas and the old source catalog already
have separate Midas proxy views. Those views still depend on Midas; the new
direct source view does not. This change does not replace the 13F/X pipelines.

Not included in this direct integration:

- Parsed SEC 13D/G ownership is explicitly excluded at the user's request
  (2026-09-06); no port is planned. A form appearing in the filing index is not
  a parsed holding.
- Complete 13F institution positions are not directly collected by Trader;
  the existing institutional-report view still reads Midas.
- Full filing-body/section extraction beyond links and Form 4 XML.
- HedgeFollow congressional trades: the prior public listing returned HTTP 404
  during the audit, and a dependable direct contract was not confirmed.
- FINRA short-interest balances: Midas had an implementation but zero stored
  rows in the audited database.
- SEC FTD and Cboe volatility/put-call collectors: Midas has research overlay
  scripts, not the same established collection path as its active datasets.
- Moomoo articles, TipRanks buybacks/AI-analyst and Investing.com analyst events:
  further content/vendor-specific adapters would be needed. These were not
  silently enabled or treated as equivalent to existing analyst ratings.

## Primary references

- [SEC data APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [FINRA short-sale volume](https://www.finra.org/finra-data/browse-catalog/short-sale-volume)
- [FINRA daily-file layout](https://www.finra.org/sites/default/files/2021-07/DailyShortSaleVolumeFileLayout.pdf)
- [USAspending API contract](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/api_contracts/contracts/v2/search/spending_by_award.md)
- [FRED observations API](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)
- [CNN Fear & Greed](https://www.cnn.com/markets/fear-and-greed)
