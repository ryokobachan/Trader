# Strategy customization

This directory is the developer-owned surface for the built-in strategy
examples.

| File | Purpose |
|---|---|
| [`catalog.ts`](./catalog.ts) | stable strategy IDs, sample metrics, and English/Japanese display copy |
| [`metrics.ts`](./metrics.ts) | strategy-detail performance-card calculations and formatting |
| [`market-valuation.ts`](./market-valuation.ts) | regular-session quotes and completed-close mark-to-market policy |
| [`metric-ids.ts`](./metric-ids.ts) | allowed performance-card IDs selected by `api/config.json` |
| [`i18n.ts`](./i18n.ts) | English/Japanese strategy UI and metric copy |
| [`sample-portfolio.ts`](./sample-portfolio.ts) | illustrative holdings used by sample detail screens |
| [`sample-transactions.ts`](./sample-transactions.ts) | explicit demo transaction fixture; reads never install it automatically |

The catalog intentionally contains three representative examples: a portfolio,
a trend rule, and a mean-reversion rule. The order of
`SAMPLE_STRATEGY_DEFINITIONS` is the default list order. Keep a
strategy ID stable after release because D1 preferences and transactions refer
to it. When the strategy meaning changes materially, add a new versioned ID
instead of reusing the old one.

Only public sample data belongs here. Custom strategies and transactions added
or edited in the UI, CLI, or AI skill are stored in D1 under the current owner
and are never written into this directory. Reads do not seed demo transactions.
That separation keeps runtime data durable, multi-user safe, and out of Git.

The metric values currently shipped with the catalog are illustrative samples,
not verified backtest results. A future backtest adapter should map a canonical
run result into the same stable metric IDs rather than writing provider-specific
fields directly into the UI.

When the strategy screen opens or is refreshed, its sample lots are marked from
the direct U.S. listing. During the regular session Unicorn uses the direct USD
quote. In pre-market, after-hours, or while the market is closed, it uses the
latest completed daily-bar close and never the separate USDT reference market.
This updates current value and unrealized P&L only; it does not manufacture new
return, Sharpe, or drawdown results.

Common changes stay in this folder:

- reorder or hide existing cards in `api/config.json`;
- change an existing formula in `metrics.ts`;
- add a card ID in `metric-ids.ts`, implement it in `metrics.ts`, add bilingual
  copy to `i18n.ts` when needed, then select it in `api/config.json`.
