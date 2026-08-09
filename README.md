# Unicorn

Unicorn is an open-source, TradingView-inspired workspace for U.S. stock charts, company research, watchlists, technical indicators, and sample strategy portfolios.

> Unicorn is a research prototype. It does not execute orders or provide investment advice. Strategy metrics are illustrative unless a backtest provider is connected.

The screenshots below use Unicorn's deterministic mock profile and contain no downloaded provider dataset.

## Screens

### Chart workspace

![Unicorn chart workspace](public/screenshots/unicorn-chart.png)

- candlestick, line, and area charts with 1m–1M timeframes
- configurable 2–10,000 candle history; default 1,000
- overlay and separate-pane indicators such as SMA, EMA, Bollinger Bands, VWAP, RSI, MACD, Stochastic, ATR, ADX, and OBV
- independently scrollable watchlist and symbol overview
- live quote, change, and optional `{symbol}USDT.P` reference close

### Symbol details

![Unicorn symbol details](public/screenshots/unicorn-details.png)

- financial statements, valuation, profitability, balance sheet, cash flow, and earnings
- Benzinga-compatible analyst ratings and target-price history
- technical metrics calculated from the selected OHLCV series
- provider name, observation time, and missing-data states are shown explicitly

### Strategies

![Unicorn strategy list](public/screenshots/unicorn-strategies.png)

- sortable sample strategy table with return, drawdown, recovery factor, Sharpe ratio, audit state, and win rate
- portfolio overview, holdings, transactions, profitability, and symbol contribution
- editable strategy name and description, soft deletion, and D1-backed transaction history; CSV import/export controls remain prototype affordances
- sample values are intentionally conservative examples, not verified backtest results

## Basic usage

1. Press `Command + F` or click the symbol selector to search U.S. stocks.
2. Select a timeframe and chart type, then use **Indicators** to add or configure studies.
3. Use `+` in the watchlist to add a symbol. Right-click a row to remove it.
4. Use the watchlist **More** menu to create, rename, or delete a list. The final list is protected from deletion.
5. Select **Details** in the symbol overview to open financials, analysts, and technicals.
6. Open **Strategies** to inspect samples. In a strategy detail screen, use `…` to edit or delete it. The final visible strategy is protected.
7. Open **Settings** to change the candle count or switch between English and Japanese.

## Run locally

Requirements:

- Node.js 22.13 or newer
- Python 3 for the optional TradingView websocket chart adapter

Deterministic mock profile:

```bash
npm install
npm run dev -- --port 3001
```

Keyless personal-development profile:

```bash
python3 -m pip install -r services/requirements-tradingview.txt
npm run dev:yahoo
```

Open <http://localhost:3001>.

`dev:yahoo` uses Yahoo-compatible endpoints for U.S. stock search, quotes, company data, fundamentals, earnings, and news; the local Python sidecar supplies chart bars; and the Midas-compatible Benzinga adapter supplies analyst ratings. These are unofficial or provider-controlled data paths. Review the applicable access, display, and redistribution terms before enabling them outside personal development.

To reuse only the allow-listed FMP/Benzinga values from a local Midas environment file:

```bash
MIDAS_ENV_FILE=/absolute/path/to/Midas/.env npm run dev:midas
```

Secrets stay server-side. The repository contains no provider credentials or downloaded third-party datasets.

## Data and persistence

| Data | Default source | Storage |
|---|---|---|
| Search, quotes, fundamentals, earnings, news | Mock; Yahoo/FMP optional | Provider response only |
| Chart OHLCV | Mock; local `tradingview-websocket` optional | Not stored in D1 |
| Analyst ratings and targets | Benzinga-compatible adapter | Provider response only |
| Watchlists and ordered items | User actions | D1 `DB` binding |
| Strategy name/description overrides and tombstones | User actions | D1 `DB` binding |
| Strategy portfolio transactions | User actions | D1 `DB` binding |
| Language, chart, and indicator preferences | User actions | Browser storage |

Persistent APIs use the Sites-provided `oai-authenticated-user-id` when present. Anonymous persistence is allowed only on a loopback local-development origin; hosted anonymous requests fail closed.

## Developer customization

Unicorn keeps product Core separate from deployment-owned extensions.

| Customize | Main entry point |
|---|---|
| Brand and logo | `app/platform/brand.ts`, `public/` |
| Provider selection | `.env.example`, `app/plugins/providers/` |
| Canonical provider DTOs | `app/platform/provider-contracts.ts` |
| Symbol summary modules and order | `app/unicorn.config.ts`, `app/plugins/ui-modules/` |
| Indicators | `app/features/chart-indicators/`, `app/features/indicators/` |
| English/Japanese copy | `app/platform/i18n.tsx`, feature `*-i18n.ts` files |
| Sample strategy catalog | `app/features/strategy/sample-strategies.ts` |
| Transactional schema | `db/schema.ts`, `drizzle/` |

Providers return canonical data with provenance instead of exposing vendor response shapes to UI components. UI modules are trusted build-time registrations; configuration cannot load arbitrary remote JavaScript.

Technical contracts:

- [Data providers](docs/contracts/data-providers.md)
- [Indicator registry](docs/contracts/indicator-registry.md)
- [UI module registry](docs/contracts/ui-module-registry.md)
- [Watchlists](docs/contracts/watchlists.md)
- [Strategy preferences](docs/contracts/strategy-preferences.md)
- [Strategy transactions](docs/contracts/strategy-portfolio-transactions.md)
- [Storage boundaries](docs/architecture/data-storage.md)

## Project structure

```text
app/                 UI, internal APIs, Core contracts, provider adapters
db/                  D1 schema and binding helpers
drizzle/             versioned D1 migrations
public/              brand, company-logo fixtures, README screenshots
services/            optional Python chart sidecar
tests/               contract, security-boundary, SSR, and UI-structure tests
worker/              Cloudflare/Vinext worker entry
```

## Quality checks

```bash
npm run lint
npm test
npx tsc --noEmit
npm audit --omit=dev
```

The production dependency audit is expected to report zero known vulnerabilities. Some local build-tool advisories may remain upstream; they are not included in the deployed runtime and are tracked separately from production dependencies.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for private vulnerability reporting. Provider-specific notices and trademark attribution are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).

Company names, logos, TradingView, Yahoo, Benzinga, FMP, and Midas remain the property of their respective owners. Their mention does not imply affiliation or endorsement.
