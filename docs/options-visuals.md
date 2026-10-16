# Options visualizations

The stock-detail ownership tab compares option contracts at one expiration.
It answers where outstanding contracts and trading volume are concentrated,
and how quoted option prices vary across strikes. It does not predict a stock
price ceiling, floor, direction, or probability interval.

## Chart contract

- Surface: the existing Trader stock-detail application. Its native React/SVG
  component supports changing expiration, strike coverage, metric, and selected
  strike. The source table remains available under an expandable section.
- Open interest and volume: paired bars starting at zero, with a numeric strike
  axis. Blue filled calls and gold outlined puts also differ without color.
- Reference premium: call and put bid/ask midpoints as distinct point shapes.
  Missing, negative, nonfinite, and crossed quotes are not plotted. Last trades
  are never mixed with midpoints.
- One row is one contract (underlying, expiration, side, strike); comparisons
  join the two sides at the exact same strike and expiration. All retrieved
  strikes remain in the chart. Missing observations remain missing, not zero.
- The underlying price is a labeled reference, with its own source date. The
  option source does not supply a verified quote timestamp, so retrieval time
  is never labeled as the time the price changed.
- All strikes are displayed by default; near-the-money is an optional filter.
  Coverage is explicit. Truncated retrievals
  are labeled as partial. Even complete retrieval refers only to the selected
  expiration and filter at Nasdaq, not all contracts on every venue.
- QA: verify NBIS and MU, both near and all strikes; compare chart values to
  the source table; verify numeric axis spacing, zero/missing distinctions,
  pointer/touch/keyboard selection, and desktop/mobile overflow.

## Reference calculation

The supplementary band is the expiration breakeven of a hypothetical long
straddle: strike minus and plus the sum of call and put bid/ask midpoints.
It deliberately uses the strike as the center, not the underlying price.
It does not estimate an expected-move confidence interval or recommend a trade.

The calculation requires an unexpired selected expiration, a successfully refreshed snapshot, an underlying
price, a complete retrieved chain, and a nearest strike within 5% of that
price. Both sides must have positive, ordered bid and ask quotes. Missing
quotes are not substituted with last prices or more distant strikes. A
negative lower breakeven is reported as absent, not clipped to a zero-dollar
price forecast. Fees are excluded; midpoint execution and aligned timestamps
are not assumed. The combined spread is shown to expose quote uncertainty.

Methodology references:

- [OIC: Open interest does not indicate direction](https://www.optionseducation.org/referencelibrary/faq/general-information)
- [OIC: Long straddle breakeven calculation](https://www.optionseducation.org/strategies/all-strategies/long-straddle)

No implied volatility is invented from the source's unusable zero IV fields.

External historical prices, exports, and source coverage limits are
documented in [research history](options-history.md).

## Verification (2026-09-05)

- Contract suite: 649 passed; the five reference-calculation tests passed again
  after adding stale-snapshot suppression. Type checking, targeted lint, and
  the final application build passed.
- Live source checks covered NBIS and MU, near and all strikes, including a
  later expiration. NBIS 2026-09-11 returned 89 strikes (90–385 USD) and 178
  contracts in the application after selecting all strikes.
- In the existing desktop browser, visually checked open-interest bars,
  reference-price markers, legends, missing-data marks, and breakeven cards.
  Verified all three metric controls, pointer and arrow-key selection, and
  the expandable source table. The 230 USD call matched the table at 2,296
  open contracts, volume 5,772, and an 8.275 USD bid/ask midpoint.
- The persistent local LaunchAgent remained running and the root HTTP endpoint
  returned 200. A separate mobile viewport and touch device were not tested.
