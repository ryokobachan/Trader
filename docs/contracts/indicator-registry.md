# Technical Indicator Registry

- Status: implemented
- Calculation source: [`indicator-calculations.ts`](../../src/app/features/chart-indicators/indicator-calculations.ts)
- UI definitions: [`page.tsx`](../../src/app/page.tsx) and [`indicator-i18n.ts`](../../src/app/features/indicators/indicator-i18n.ts)
- Principle: every chart surface consumes the same typed calculation result

## 1. Boundary

Providers return canonical OHLCV bars. Unicorn calculates its built-in indicators locally with pure TypeScript; provider-specific indicator endpoints are not used. This keeps the visible series, pane readout, legend value, and snapshot on one formula and one input series.

The calculation registry is explicit and build-time only:

```ts
export const INDICATOR_CALCULATION_REGISTRY: Readonly<
  Record<ChartIndicatorId, IndicatorCalculator>
>;
```

Configuration cannot load an arbitrary JavaScript, Python, Pine, or filesystem path. A new built-in requires a reviewed ID, calculation function, UI definition, translations, and tests.

## 2. Calculation contract

```ts
type IndicatorCalculationSpec = Readonly<{
  id: ChartIndicatorId;
  length?: number;
  source?: "終値" | "始値" | "高値" | "安値" | "HL2" | "HLC3";
  multiplier?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  smoothing?: number;
  anchor?: "セッション" | "週" | "月" | "四半期" | "年" | "全期間";
  timeZone?: string;
}>;

type ComputedIndicator = Readonly<{
  id: ChartIndicatorId;
  primarySeriesKey: IndicatorSeriesKey;
  series: readonly {
    key: IndicatorSeriesKey;
    name: string;
    points: readonly { time: string; value: number }[];
    kind?: "line" | "histogram";
  }[];
  guideLines?: readonly number[];
  precision?: number;
}>;
```

Presentation-only settings such as color, width, line style, visibility, and offset are not calculation inputs. Insufficient history returns an empty series and the UI displays `—`; it never fabricates a fallback value.

## 3. Built-ins

| ID | Default | Policy | Placement |
|---|---|---|---|
| `sma20` | length 20, close | arithmetic rolling mean | overlay |
| `ema50` | length 50, close | `alpha=2/(length+1)`, recursive seed from first observation | overlay |
| `bollinger` | length 20, close, 2σ | SMA ± population standard deviation | overlay |
| `vwap` | HLC3, session | cumulative price×volume / volume, reset at selected anchor in exchange time | overlay |
| `rsi14` | length 14, close | SMA seed followed by Wilder RMA | pane |
| `macd` | 12/26/9, close | fast EMA − slow EMA, signal EMA, histogram | pane |
| `stochastic` | 14/3/3, close | rolling high/low %K with SMA smoothing and %D | pane |
| `atr14` | length 14 | true range followed by Wilder RMA | pane |
| `adx14` | length 14 | Wilder DM/TR, real DX warm-up, then Wilder ADX | pane |
| `obv` | close | add/subtract volume according to source direction | pane |

VWAP supports session, week, month, quarter, year, and full-range anchors. Timestamped U.S. bars use `America/New_York` unless the calculation caller supplies another exchange timezone; date-only bars retain their provider trading date.

MAMA is intentionally not registered. Its implementation and compatibility differences make it unsuitable as a portable built-in until a separately versioned, independently verified formula is available.

## 4. Consistency and chart types

- `computeIndicatorSeries()` validates finite OHLCV and dispatches through the typed registry.
- `latestIndicatorValue()` and `latestIndicatorValues()` read from that exact computed series.
- RSI in the chart legend, RSI pane, symbol overview, and symbol detail uses the same Wilder implementation.
- Indicators are calculated from the underlying canonical bars. Selecting Heikin Ashi changes candle presentation but does not silently replace research inputs with synthetic Heikin-Ashi OHLC.
- Changing timeframe changes the input bar series, not the formula.
- No formula may inspect future bars or reseed from only the visible viewport.

## 5. User settings and templates

Users can add/remove indicators, edit supported numeric or enum inputs, change style/visibility, and select a VWAP anchor. Saved chart templates store active IDs, hidden IDs, settings, and visibility in versioned browser storage. They can be created, renamed, applied, and deleted.

Template JSON contains settings only. It cannot add executable code or unregistered indicator IDs.

## 6. Adding an indicator

1. Add its stable ID to `CHART_INDICATOR_IDS`.
2. Implement a pure calculator and register it in `INDICATOR_CALCULATION_REGISTRY`.
3. Add its UI definition and English/Japanese copy.
4. Add deterministic formula, warm-up, finite-value, parameter, and 10,000-bar performance tests.
5. If it is a pane indicator, verify the pane header and legend use the returned series rather than recomputing it.

TA-Lib is not bundled in the browser or Worker. Native/WASM packaging and runtime differences would add material deployment cost for formulas already covered by the small pure-TypeScript registry. It remains suitable as an offline oracle when adding independent comparison fixtures.

## 7. Validation

The current contract suite verifies:

- explicit warm-up boundaries;
- source and parameter changes;
- anchored VWAP calendar resets;
- Wilder RSI and corrected ADX seeding;
- finite outputs for all ten indicators over 10,000 bars;
- identical latest values between renderer and legend;
- absence of MAMA and fabricated fallback readings.

Compatibility means matching the documented Unicorn policy. It does not claim undocumented bit-for-bit equivalence with TradingView, TA-Lib, or any provider implementation.

## 8. References

- [TradingView Pine Script reference](https://www.tradingview.com/pine-script-reference/v6/)
- [TradingView chart information](https://www.tradingview.com/pine-script-docs/concepts/chart-information/)
- [TradingView time semantics](https://www.tradingview.com/pine-script-docs/concepts/time/)
