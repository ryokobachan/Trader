# Technical Indicator Registry

- Status: implemented
- Calculation source: [`indicator-calculations.ts`](../../src/app/features/chart-indicators/indicator-calculations.ts)
- UI definitions: [`page.tsx`](../../src/app/page.tsx) and [`indicator-i18n.ts`](../../src/app/features/indicators/indicator-i18n.ts)
- Principle: every chart surface consumes the same typed calculation result

## 1. Boundary

Providers return canonical OHLCV bars. Existing chart overlays/panes and the 26-indicator rating retain their TypeScript calculation contracts. The technicals screen additionally offers Python TA-Lib calculations through Trader's authenticated helper; no external provider indicator endpoint is used. Each result's chart and readout consume the same computed series.

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

MAMA is not in the browser calculation registry. It is available in the separate Python TA-Lib library with the native library's version, parameters and lookback.

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

TA-Lib runs in Trader's Python helper, not inside the browser or Worker. The helper and desktop packaging include the native Python dependency. The TA-Lib library exposes 129 functions, including 61 candlestick patterns. It excludes generic math functions, MAVP (additional period-series input), and BETA/CORREL (a separate comparison-series contract is needed).

The TA-Lib catalog is derived from the installed library within reviewed function groups. User input can select only those IDs and validated numeric parameters or canonical OHLCV columns; it cannot load code or a file. Up to 10,000 bars and eight functions are accepted. Date labels are preserved, absolute times must be ordered and unique, and invalid/missing OHLCV is rejected. Lookback rows and non-finite output values are null, including leading integer candlestick zeros. The UI stores selections and parameters only, and discards results if the symbol, bars or settings change. Pattern sign/magnitude is function-specific, not a universal trade recommendation or probability.

HTTP: `GET /api/v1/indicators`, `POST /api/v1/indicators/calculate`, and `GET /api/v1/symbols/:symbol/technicals`. CLI: `data get technicals`. Responses contain version, input labels, effective parameters, input mappings and lookback; the symbol route also retains source bar metadata. The additional library currently plots daily bars in the stock-detail screen; the API/CLI accepts other supported intervals.

## 7. Validation

The current contract suite verifies:

- explicit warm-up boundaries;
- source and parameter changes;
- anchored VWAP calendar resets;
- Wilder RSI and corrected ADX seeding;
- finite outputs for all ten indicators over 10,000 bars;
- identical latest values between renderer and legend;
- absence of fabricated fallback readings in browser indicators;
- native TA-Lib equality and prefix invariance for all 129 functions;
- authenticated HTTP behavior, bounds, timestamp validation and missing warm-up values.

Compatibility means matching the documented Trader policy. It does not claim undocumented bit-for-bit equivalence with TradingView, TA-Lib, or any provider implementation.

## 8. References

- [TradingView Pine Script reference](https://www.tradingview.com/pine-script-reference/v6/)
- [TradingView chart information](https://www.tradingview.com/pine-script-docs/concepts/chart-information/)
- [TradingView time semantics](https://www.tradingview.com/pine-script-docs/concepts/time/)
- [TA-Lib Python and native parameter/lookback contract](https://github.com/TA-Lib/ta-lib-python)
