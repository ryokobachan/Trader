from __future__ import annotations

from collections.abc import Callable, Mapping

import numpy as np
import pandas as pd
import talib


def market_panels(
    market_data: Mapping[str, pd.DataFrame],
) -> tuple[pd.DataFrame, pd.DataFrame]:
    if not isinstance(market_data, Mapping):
        raise TypeError("market_data must be a mapping containing close and volume panels")
    close = market_data.get("close")
    volume = market_data.get("volume")
    if not isinstance(close, pd.DataFrame) or not isinstance(volume, pd.DataFrame):
        raise TypeError("market_data['close'] and ['volume'] must be pandas DataFrames")
    if not isinstance(close.index, pd.DatetimeIndex):
        raise TypeError("market data must use a DatetimeIndex")
    if close.index.has_duplicates or not close.index.is_monotonic_increasing:
        raise ValueError("market data index must be unique and increasing")
    if not close.index.equals(volume.index) or set(close.columns) != set(volume.columns):
        raise ValueError("close and volume panels must have identical dates and symbols")
    if close.columns.has_duplicates or close.shape[1] < 2:
        raise ValueError("the strategy requires at least two unique symbols")
    return close.astype(float), volume.reindex(columns=close.columns).astype(float)


def feature_panels(close: pd.DataFrame, volume: pd.DataFrame) -> dict[str, pd.DataFrame]:
    returns = close.pct_change(fill_method=None)
    dollar_volume = close * volume
    sma20 = _talib_panel(close, lambda values: talib.SMA(values, timeperiod=20))
    volume_sma20 = _talib_panel(volume, lambda values: talib.SMA(values, timeperiod=20))

    return {
        "return_1": _rank(
            _talib_panel(close, lambda values: talib.ROC(values, timeperiod=1) / 100.0)
        ),
        "return_5": _rank(
            _talib_panel(close, lambda values: talib.ROC(values, timeperiod=5) / 100.0)
        ),
        "return_21": _rank(
            _talib_panel(close, lambda values: talib.ROC(values, timeperiod=21) / 100.0)
        ),
        "return_63": _rank(
            _talib_panel(close, lambda values: talib.ROC(values, timeperiod=63) / 100.0)
        ),
        "volatility_21": _rank(
            _talib_panel(returns, lambda values: talib.STDDEV(values, timeperiod=21))
        ),
        "price_to_sma_20": _rank(close.div(sma20).sub(1.0)),
        "volume_to_sma_20": _rank(volume.div(volume_sma20).sub(1.0)),
        "log_dollar_volume": _rank(np.log1p(dollar_volume.clip(lower=0.0))),
    }


def average_dollar_volume(
    close: pd.DataFrame, volume: pd.DataFrame, window: int
) -> pd.DataFrame:
    return (close * volume).rolling(window, min_periods=window).mean()


def _talib_panel(
    panel: pd.DataFrame, transform: Callable[[np.ndarray], np.ndarray]
) -> pd.DataFrame:
    result = pd.DataFrame(index=panel.index, columns=panel.columns, dtype=float)
    for symbol in panel.columns:
        values = np.asarray(panel[symbol], dtype=np.float64)
        transformed = np.full(values.shape, np.nan, dtype=float)
        finite = np.isfinite(values)
        transitions = np.diff(np.r_[False, finite, False].astype(np.int8))
        starts = np.flatnonzero(transitions == 1)
        stops = np.flatnonzero(transitions == -1)
        for start, stop in zip(starts, stops, strict=True):
            segment = np.asarray(transform(values[start:stop]), dtype=float)
            if segment.shape != (stop - start,):
                raise ValueError("TA-Lib transform returned an unexpected shape")
            transformed[start:stop] = segment
        result[symbol] = transformed
    return result


def _rank(panel: pd.DataFrame) -> pd.DataFrame:
    return panel.rank(axis=1, method="average", pct=True).sub(0.5)
