import numpy as np
import pandas as pd
import talib


def _sma_series(series: pd.Series, period: int) -> pd.Series:
    values = series.to_numpy(dtype="float64")
    output = np.full(len(values), np.nan, dtype="float64")
    finite_positions = np.flatnonzero(np.isfinite(values))
    if len(finite_positions) == 0:
        return pd.Series(output, index=series.index)

    split_points = np.flatnonzero(np.diff(finite_positions) > 1) + 1
    for positions in np.split(finite_positions, split_points):
        output[positions] = talib.SMA(values[positions], timeperiod=period)
    return pd.Series(output, index=series.index)


def _sma(close: pd.DataFrame, period: int) -> pd.DataFrame:
    return close.apply(lambda series: _sma_series(series, period))


def generate(market_data, params=None, context=None):
    """Return equal target weights for symbols in a golden-cross regime."""
    del context
    params = params or {}
    fast_period = int(params.get("fastPeriod", 50))
    slow_period = int(params.get("slowPeriod", 200))
    gross_exposure = float(params.get("grossExposure", 1.0))

    if fast_period < 1 or slow_period <= fast_period:
        raise ValueError("slowPeriod must be greater than fastPeriod >= 1")
    if not np.isfinite(gross_exposure) or not 0.0 <= gross_exposure <= 1.0:
        raise ValueError("grossExposure must be a finite number between 0 and 1")

    close = market_data.get("close") if isinstance(market_data, dict) else None
    if not isinstance(close, pd.DataFrame):
        raise TypeError("market_data['close'] must be a pandas DataFrame")
    if not isinstance(close.index, pd.DatetimeIndex):
        raise TypeError("close must use a DatetimeIndex")
    if close.shape[1] < 2:
        raise ValueError("portfolio-golden-cross requires at least two symbols")
    if not close.index.is_monotonic_increasing or not close.index.is_unique:
        raise ValueError("close index must be sorted and unique")
    if not close.columns.is_unique:
        raise ValueError("close symbol columns must be unique")

    close = close.astype("float64")
    active = _sma(close, fast_period).gt(_sma(close, slow_period)).fillna(False)
    membership_changed = active.ne(active.shift(1, fill_value=False)).any(axis=1)

    target_weights = pd.DataFrame(np.nan, index=close.index, columns=close.columns)
    active_on_rebalance = active.loc[membership_changed]
    active_count = active_on_rebalance.sum(axis=1)
    target_weights.loc[membership_changed] = (
        active_on_rebalance.div(active_count.replace(0, np.nan), axis=0)
        .fillna(0.0)
        .mul(gross_exposure)
    )

    return {
        "type": "orders",
        "size_type": "targetpercent",
        "target_weights": target_weights,
    }
