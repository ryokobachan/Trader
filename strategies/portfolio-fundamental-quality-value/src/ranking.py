from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np
import pandas as pd

from .config import validated_config
from .panels import average_dollar_volume, validated_panels


def generate(
    market_data: Mapping[str, pd.DataFrame],
    params: Mapping[str, Any] | None = None,
    context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Screen PIT fundamentals and return equal-weight target-percent orders."""
    del context
    config = validated_config(params)
    panels = validated_panels(market_data)
    dollar_volume = average_dollar_volume(
        panels.screening_close, panels.volume, config["liquidityWindowBars"]
    )
    market_cap = panels.market_cap
    return_on_equity = panels.net_income_latest_annual / panels.total_equity
    cash_return_on_assets = (
        panels.operating_cash_flow_latest_annual / panels.total_assets
    )
    earnings_yield = panels.net_income_latest_annual / market_cap
    book_to_market = panels.total_equity / market_cap

    target_weights = pd.DataFrame(
        np.nan, index=panels.close.index, columns=panels.close.columns
    )
    for position in _quarter_transition_positions(panels.close.index):
        decision_date = panels.close.index[position]
        target_weights.iloc[position] = 0.0
        eligible = _eligible_symbols(
            position=position,
            panels=panels,
            dollar_volume=dollar_volume,
            market_cap=market_cap,
            return_on_equity=return_on_equity,
            cash_return_on_assets=cash_return_on_assets,
            earnings_yield=earnings_yield,
            book_to_market=book_to_market,
            config=config,
        )
        if not eligible.any():
            continue

        quality = (
            _cross_sectional_rank(return_on_equity.loc[decision_date, eligible])
            + _cross_sectional_rank(cash_return_on_assets.loc[decision_date, eligible])
        ) / 2.0
        value = (
            _cross_sectional_rank(earnings_yield.loc[decision_date, eligible])
            + _cross_sectional_rank(book_to_market.loc[decision_date, eligible])
        ) / 2.0
        score = config["qualityWeight"] * quality + (1.0 - config["qualityWeight"]) * value
        selected = _highest_ranked(score, config["topN"])
        target_weights.loc[decision_date, selected] = config["grossExposure"] / len(selected)

    return {
        "type": "orders",
        "size_type": "targetpercent",
        "target_weights": target_weights,
    }


def _eligible_symbols(
    *,
    position: int,
    panels,
    dollar_volume: pd.DataFrame,
    market_cap: pd.DataFrame,
    return_on_equity: pd.DataFrame,
    cash_return_on_assets: pd.DataFrame,
    earnings_yield: pd.DataFrame,
    book_to_market: pd.DataFrame,
    config: Mapping[str, Any],
) -> pd.Series:
    values = pd.DataFrame(
        {
            "screening_close": panels.screening_close.iloc[position],
            "dollar_volume": dollar_volume.iloc[position],
            "market_cap": market_cap.iloc[position],
            "total_equity": panels.total_equity.iloc[position],
            "total_assets": panels.total_assets.iloc[position],
            "return_on_equity": return_on_equity.iloc[position],
            "cash_return_on_assets": cash_return_on_assets.iloc[position],
            "earnings_yield": earnings_yield.iloc[position],
            "book_to_market": book_to_market.iloc[position],
            "fundamental_age_days": panels.fundamental_age_days.iloc[position],
            "fundamentals_available": panels.fundamentals_available.iloc[position],
        },
        index=panels.close.columns,
    )
    finite = np.isfinite(values).all(axis=1)
    return (
        finite
        & values["fundamentals_available"].eq(1.0)
        & values["fundamental_age_days"].le(config["maximumFundamentalAgeDays"])
        & values["screening_close"].ge(config["minimumPrice"])
        & values["dollar_volume"].ge(config["minimumAverageDollarVolume"])
        & values["market_cap"].ge(config["minimumMarketCapitalization"])
        & values["total_equity"].gt(0.0)
        & values["total_assets"].gt(0.0)
        & values["return_on_equity"].ge(config["minimumReturnOnEquity"])
        & values["cash_return_on_assets"].ge(
            config["minimumOperatingCashFlowToAssets"]
        )
    )


def _quarter_transition_positions(index: pd.DatetimeIndex) -> np.ndarray:
    quarters = index.to_period("Q")
    transitions = np.zeros(len(index), dtype=bool)
    if len(index) > 1:
        transitions[1:] = quarters[1:] != quarters[:-1]
    return np.flatnonzero(transitions)


def _cross_sectional_rank(values: pd.Series) -> pd.Series:
    return values.rank(method="average", pct=True)


def _highest_ranked(score: pd.Series, top_n: int) -> pd.Index:
    ranked = pd.DataFrame(
        {"score": score, "symbol": score.index.astype(str)}, index=score.index
    )
    return ranked.sort_values(
        ["score", "symbol"], ascending=[False, True], kind="mergesort"
    ).head(top_n).index
