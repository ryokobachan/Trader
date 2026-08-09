# Technical Indicator Registry

- Version: `unicorn.indicator.v1`
- Status: proposed／MVP requirement
- Principle: chart indicators are calculated from canonical bars inside Unicorn
- Project overview: [README](../../README.md)

## 1. Why indicators are not a market-provider feature

Provider-supplied indicator endpoints may use different warm-up, smoothing, session, adjustment, or rounding policies. Unicorn therefore obtains OHLCV from `MarketDataProvider` and computes built-in indicators locally. This keeps chart display, screening, and strategy research reproducible across providers.

A provider-specific indicator may exist as an explicitly named extension, but it cannot replace the Core indicator with the same ID.

## 2. Registry contract

```ts
type IndicatorDefinition = {
  id: string;
  version: string;
  displayName: string;
  shortName: string;
  category: "trend" | "momentum" | "volatility" | "volume";
  placement: "overlay" | "pane";
  requiredFields: Array<"open" | "high" | "low" | "close" | "volume">;
  supportedIntervals: string[] | "all";
  inputSchema: JSONSchema;
  outputs: IndicatorOutputDefinition[];
  warmup: { type: "expression"; expression: string };
  render: IndicatorRenderDefinition;
  license: { spdx: string; source?: string };
};
```

Each installed indicator exposes a serializable manifest without executable code:

```json
{
  "schema_version": "unicorn.indicator.v1",
  "id": "core.rsi",
  "version": "1.0.0",
  "placement": "pane",
  "required_fields": ["close"],
  "inputs": {
    "length": {"type": "integer", "minimum": 1, "default": 14},
    "source": {"enum": ["open", "high", "low", "close", "hl2", "hlc3"], "default": "close"}
  },
  "outputs": [{"id": "rsi", "kind": "line"}],
  "calculation_policy": "unicorn.talib.rsi.v1"
}
```

The frontend builds Inputs／Style／Visibility controls from the manifest. It never imports an adapter's private settings component and does not contain the canonical calculation.

The executable server-side boundary is:

```python
class IndicatorPlugin(Protocol):
    definition: IndicatorDefinitionV1

    def lookback(self, inputs: Mapping[str, object]) -> int: ...

    def calculate(
        self,
        bars: CanonicalBarFrame,
        inputs: Mapping[str, object],
        context: IndicatorContext,
    ) -> IndicatorResult: ...
```

Plugins are discovered from an operator allow-list or Python entry point. They execute without Provider credentials, database credentials, or outbound network access.

## 3. Definition, Instance, and Preset

These are different schemas:

- Definition: immutable formula contract such as `core.ema@1.0.0`
- Instance: one chart use with `length=50`, source, timeframe, style, and visibility
- Preset: an ordered collection of instances such as “Trend Analysis”

Definition IDs never encode parameters. Existing mock IDs such as `sma20` and `ema50` become instances of `core.sma` and `core.ema`.

## 4. Core calculation policy

- Input bars are ascending, unique, canonical bars from one instrument, interval, session, and adjustment mode.
- Closed bars are canonical. A developing bar may show a provisional value but is not persisted as final.
- Missing required OHLCV produces `null`; Core does not forward-fill price or volume for indicator calculation.
- Warm-up values are `null` until the specified policy is satisfied.
- No future bar, centered window, or look-ahead fill is allowed.
- Intermediate calculation uses float64. API values are not rounded; presentation rounding is UI-only.
- Source definitions: `hl2=(high+low)/2`, `hlc3=(high+low+close)/3`.
- Corporate-action adjustment and regular／extended session are part of the series identity.
- The indicator result records `indicator_id`, version, input hash, parameters, bar dataset hash, and calculation policy.
- `offset` is a render-only setting. Shifted values cannot be consumed by screening, alerts, or strategy signals.
- Recursive indicators are calculated from a stable partition start; changing the visible viewport cannot reseed EMA／RMA.

## 5. MVP built-ins

`lookback` is the zero-based index of the first valid value under the declared profile.

| ID | Defaults | Formula／policy | Placement | lookback |
|---|---|---|---|---|
| `core.sma` | length 20, close | Arithmetic mean of the latest `length` values | Overlay | `length-1` |
| `core.ema` | length 50, close | `alpha=2/(length+1)`; seed with first full-window SMA | Overlay | `length-1` |
| `core.bollinger` | length 20, close, mult 2 | basis=SMA; upper/lower=basis ± mult × population stddev (`ddof=0`) | Overlay | `length-1` |
| `core.vwap` | source HLC3, anchor session | cumulative `sum(source×volume)/sum(volume)` reset at anchor | Overlay | 0 after first positive-volume bar |
| `core.rsi` | length 14, close | Wilder RMA of gains/losses; `100-100/(1+RS)` | Pane | `length` |
| `core.macd` | fast 12, slow 26, signal 9, close | EMA(fast)−EMA(slow); signal=EMA(MACD); histogram=MACD−signal | Pane | `slow+signal-2` = 33 |
| `core.stochastic` | K 14, smoothK 3, D 3 | rawK=100×(close−lowest low)/(highest high−lowest low); SMA smoothK and D | Pane | 17 |
| `core.atr` | length 14 | TR=max(H−L, abs(H−prevC), abs(L−prevC)); Wilder RMA | Pane | `length` |
| `core.adx` | DI 14, ADX 14 | Wilder +DM/−DM/TR, DI, DX, then Wilder ADX | Pane | `2×length-1` = 27 |
| `core.obv` | none | TA-Lib policy: seed with the first volume; then add volume if close rises, subtract if it falls, and retain the value if equal | Pane | 0 |

Division-by-zero policy is part of each indicator version. Under the default TA-Lib-compatible profile, RSI is 100 when loss is zero and gain is positive, and 0 when gain is zero; Stochastic is 0 when the high-low range is zero. VWAP is the one built-in without a TA-Lib primitive and returns `null` until cumulative positive volume exists.

The default calculation profile is `unicorn-talib-v1`. The reference implementation uses an exactly pinned TA-Lib package for every built-in it supports and a reviewed local implementation for anchored VWAP. The documented behavior, pinned package version, and implementation hash are all included in persisted results. A future TradingView／Pine compatibility profile must use a distinct profile ID and pass its own golden fixtures; the MVP does not claim undocumented bit-for-bit Pine equivalence.

The current frontend mock calculates only some overlays in the browser and uses display-only readings for several pane indicators. Those values are explicitly non-canonical and must be replaced by this service before real data or strategies are enabled.

## 6. User settings versus developer extensions

Runtime user-configurable:

- add／remove an installed indicator
- numeric and enum inputs within schema bounds
- output color, width, line style, visibility, pane height
- timeframe visibility and preset composition
- source, session, and anchor where exposed by the definition

Developer-customizable:

- implement a new versioned definition package
- add calculation outputs and render metadata
- register an allow-listed package in deployment config
- supply a Python canonical implementation and a serializable render manifest
- add golden fixtures and license metadata

Core-owned and not overridable:

- canonical bar contract and data provenance
- no-look-ahead and missing-value policy
- manifest／parameter validation
- indicator ID namespace ownership
- worker sandbox and installed-package allow-list
- separation between provisional chart values and canonical research values

The browser cannot upload or execute arbitrary JavaScript, Python, or Pine Script in MVP.

## 7. Chart and strategy consistency

- Chart, screening, alerts, strategy generation, and backtests consume the same canonical server result.
- The frontend only validates settings, requests series, and renders outputs.
- Result streaming and incremental server calculation provide interactivity; a second browser formula implementation is not part of MVP.
- The UI shows the implementation version used by a saved strategy.
- Changing a formula, seed, warm-up, or missing-value rule requires a new indicator version; saved strategies keep the old version.

## 8. Validation and conformance

Tests for every indicator include:

- deterministic hand-calculated small series
- golden comparison with the exactly pinned TA-Lib reference
- fixed Pine output fixtures before any optional TradingView-compatible profile may be named compatible
- insufficient warm-up, flat series, zero volume, gaps, NaN, split boundary, DST/session reset
- batch versus incremental updates
- batch versus incremental server calculation tolerance
- no output change when future bars are appended before the evaluated timestamp
- parameter minimum／maximum and schema migration

Compatibility means matching the documented Unicorn policy, not claiming undocumented bit-for-bit TradingView equivalence.

## 9. Official references

- TradingView Pine Script v6 reference: <https://www.tradingview.com/pine-script-reference/v6/>
- TradingView chart data semantics: <https://www.tradingview.com/pine-script-docs/concepts/chart-information/>
- Bollinger Bands: <https://www.tradingview.com/support/solutions/43000501840-bollinger-bands-bb/>
- RSI: <https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/>
- MACD: <https://www.tradingview.com/support/solutions/43000502344-moving-average-convergence-divergence-macd-indicator/>
- OBV: <https://www.tradingview.com/support/solutions/43000502593-on-balance-volume-obv/>
