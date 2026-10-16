from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np
import pandas as pd


REQUIRED_PANELS = (
    "close",
    "screening_close",
    "volume",
    "market_cap",
    "net_income_latest_annual",
    "operating_cash_flow_latest_annual",
    "total_equity",
    "total_assets",
    "fundamental_age_days",
    "fundamentals_available",
)

FUNDAMENTAL_FACT_PANELS = (
    "market_cap",
    "net_income_latest_annual",
    "operating_cash_flow_latest_annual",
    "total_equity",
    "total_assets",
)


@dataclass(frozen=True)
class StrategyPanels:
    close: pd.DataFrame
    screening_close: pd.DataFrame
    volume: pd.DataFrame
    market_cap: pd.DataFrame
    net_income_latest_annual: pd.DataFrame
    operating_cash_flow_latest_annual: pd.DataFrame
    total_equity: pd.DataFrame
    total_assets: pd.DataFrame
    fundamental_age_days: pd.DataFrame
    fundamentals_available: pd.DataFrame


def validated_panels(market_data: Mapping[str, pd.DataFrame]) -> StrategyPanels:
    """Validate aligned PIT panels; unavailable facts must not be backfilled.

    ``fundamental_age_days`` is measured from the fact's original public filing
    time to each decision date. The snapshot adapter must as-of join revisions:
    a later restatement gets a later availability date and never rewrites an
    earlier row.
    """
    if not isinstance(market_data, Mapping):
        raise TypeError("market_data must be a mapping of date-by-symbol panels")
    missing = [name for name in REQUIRED_PANELS if name not in market_data]
    if missing:
        raise ValueError(f"market_data is missing required panels: {', '.join(missing)}")

    close = market_data["close"]
    if not isinstance(close, pd.DataFrame):
        raise TypeError("market_data['close'] must be a pandas DataFrame")
    if not isinstance(close.index, pd.DatetimeIndex):
        raise TypeError("market data must use a DatetimeIndex")
    if close.index.has_duplicates or not close.index.is_monotonic_increasing:
        raise ValueError("market data index must be unique and increasing")
    if close.columns.has_duplicates or close.shape[1] < 2:
        raise ValueError("the strategy requires at least two unique symbols")
    if any(not isinstance(symbol, str) or not symbol for symbol in close.columns):
        raise ValueError("symbol columns must be non-empty strings")

    normalized: dict[str, pd.DataFrame] = {}
    for name in REQUIRED_PANELS:
        panel = market_data[name]
        if not isinstance(panel, pd.DataFrame):
            raise TypeError(f"market_data['{name}'] must be a pandas DataFrame")
        if not panel.index.equals(close.index) or not panel.columns.equals(close.columns):
            raise ValueError(f"market_data['{name}'] must align exactly with close")
        try:
            numeric = panel.astype("float64")
        except (TypeError, ValueError) as error:
            raise TypeError(f"market_data['{name}'] must be numeric") from error
        if np.isinf(numeric.to_numpy(dtype=float, copy=False)).any():
            raise ValueError(f"market_data['{name}'] must not contain infinity")
        normalized[name] = numeric

    if (normalized["close"].dropna().to_numpy() <= 0.0).any():
        raise ValueError("finite close values must be positive")
    if (normalized["screening_close"].dropna().to_numpy() <= 0.0).any():
        raise ValueError("finite screening_close values must be positive")
    if (normalized["volume"].dropna().to_numpy() < 0.0).any():
        raise ValueError("finite volume values must be non-negative")

    available = normalized["fundamentals_available"]
    available_values = available.to_numpy(dtype=float, copy=False)
    if not np.isfinite(available_values).all() or not np.isin(
        available_values, (0.0, 1.0)
    ).all():
        raise ValueError("fundamentals_available must contain only 0 or 1")

    age = normalized["fundamental_age_days"]
    available_mask = available.eq(1.0)
    available_ages = age.to_numpy(dtype=float, copy=False)[
        available_mask.to_numpy(dtype=bool, copy=False)
    ]
    if not np.isfinite(available_ages).all() or (available_ages < 0.0).any():
        raise ValueError(
            "available fundamentals require a finite non-negative fundamental_age_days"
        )

    unavailable_mask = ~available_mask
    for name in FUNDAMENTAL_FACT_PANELS:
        if normalized[name].where(unavailable_mask).notna().any(axis=None):
            raise ValueError(
                f"market_data['{name}'] contains values before fundamentals are available"
            )

    return StrategyPanels(**normalized)


def average_dollar_volume(
    close: pd.DataFrame, volume: pd.DataFrame, window: int
) -> pd.DataFrame:
    return (close * volume).rolling(window, min_periods=window).mean()
