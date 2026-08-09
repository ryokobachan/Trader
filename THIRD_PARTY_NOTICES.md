# Third-party notices

Unicorn includes the following third-party software and referenced assets.
The lockfile remains the complete machine-readable dependency inventory.

## Lightweight Charts 5.2.0

- Project: [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
- Source: [tradingview/lightweight-charts](https://github.com/tradingview/lightweight-charts)
- Copyright: 2023 TradingView, Inc.
- License: [Apache License 2.0](https://github.com/tradingview/lightweight-charts/blob/master/LICENSE)

The embedded chart logo is disabled through the public `attributionLogo` option.
Unicorn retains a user-visible “Lightweight Charts by TradingView” link in
the chart workspace. TradingView is a trademark of its respective owner, and
its mention does not imply affiliation or endorsement.

## Company logo fixtures

The local prototype logo fixtures, source versions, fallback policy, and
trademark disclaimer are documented in
[`public/company-logos/README.md`](public/company-logos/README.md).

The Unicorn brand artwork in `public/unicorn-logo.png` was supplied by the
project owner for this repository. It is not Apple emoji artwork. The README
chart and symbol-detail screenshots were captured with Unicorn's optional
real-data profile and visually reproduce time-sensitive, provider-derived
values. The strategy screenshot uses Unicorn's deterministic sample catalog.
No raw provider response payloads or machine-readable provider datasets are
bundled with the repository.

## Optional market-data adapters

Unicorn includes adapter code for Yahoo Finance-compatible endpoints, Benzinga
analyst ratings, and Financial Modeling Prep. No provider credentials or
third-party response data are bundled with the repository. Operators are
responsible for the applicable access, display, retention, and redistribution
terms. The default open-source profile remains deterministic mock data.

The optional local chart sidecar uses
[`tradingview-websocket` 0.6](https://pypi.org/project/tradingview-websocket/)
and its `websocket-client` dependency. It is not installed by `npm install`, is
not bundled in browser or Cloudflare output, and accesses a TradingView
websocket as an unauthorized user. Operators must review TradingView's current
terms and data entitlements before enabling it. Its inclusion does not imply
affiliation with or endorsement by TradingView.

## Dependency licenses

JavaScript dependency versions are pinned by `package-lock.json`; the optional
Python chart dependency is pinned by `services/requirements-tradingview.txt`.
Contributors must preserve upstream license notices and review newly added
packages before distributing a build.
