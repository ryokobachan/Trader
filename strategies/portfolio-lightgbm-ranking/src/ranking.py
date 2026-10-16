from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor

from .config import validated_config
from .features import average_dollar_volume, feature_panels, market_panels


def generate(
    market_data: Mapping[str, pd.DataFrame],
    params: Mapping[str, Any] | None = None,
    context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Return delayed target-percent orders for a multi-symbol portfolio."""
    del context
    config = validated_config(params)
    close, volume = market_panels(market_data)
    features = feature_panels(close, volume)
    liquidity = average_dollar_volume(close, volume, config["liquidityWindowBars"])
    labels = close.shift(-config["horizonBars"]).div(close).sub(1.0)
    target_weights = pd.DataFrame(np.nan, index=close.index, columns=close.columns)

    for decision_position in range(0, len(close.index), config["rebalanceBars"]):
        training = _training_data(features, labels, decision_position, config)
        if training is None:
            continue
        x_train, y_train = training

        x_current = pd.DataFrame(
            {name: panel.iloc[decision_position] for name, panel in features.items()},
            index=close.columns,
        )
        current_close = close.iloc[decision_position]
        current_liquidity = liquidity.iloc[decision_position]
        eligible = (
            np.isfinite(x_current).all(axis=1)
            & np.isfinite(current_close)
            & (current_close >= config["minimumPrice"])
            & np.isfinite(current_liquidity)
            & (current_liquidity >= config["minimumAverageDollarVolume"])
        )

        target_weights.iloc[decision_position] = 0.0
        if not eligible.any():
            continue

        model = _model(config)
        model.fit(x_train, y_train)
        candidates = x_current.loc[eligible].sort_index()
        scores = pd.Series(model.predict(candidates), index=candidates.index)
        selected = scores[scores > 0.0].sort_values(
            ascending=False, kind="mergesort"
        ).head(config["topN"])
        if len(selected) > 0:
            target_weights.loc[close.index[decision_position], selected.index] = (
                config["grossExposure"] / len(selected)
            )

    return {
        "type": "orders",
        "size_type": "targetpercent",
        "target_weights": target_weights,
    }


def _training_data(
    features: Mapping[str, pd.DataFrame],
    labels: pd.DataFrame,
    decision_position: int,
    config: Mapping[str, Any],
) -> tuple[pd.DataFrame, np.ndarray] | None:
    # A label originating at i is usable only after bar i + horizon is known.
    latest_label_position = decision_position - config["horizonBars"]
    if latest_label_position < 0:
        return None
    first_label_position = max(
        0, latest_label_position - config["trainWindowBars"] + 1
    )
    rows = slice(first_label_position, latest_label_position + 1)
    x_train = pd.DataFrame(
        {
            name: panel.iloc[rows].to_numpy(dtype=float).reshape(-1)
            for name, panel in features.items()
        }
    )
    y_train = labels.iloc[rows].to_numpy(dtype=float).reshape(-1)
    valid = np.isfinite(y_train) & np.isfinite(x_train).all(axis=1)
    if int(valid.sum()) < config["minimumTrainingRows"]:
        return None
    return x_train.loc[valid], y_train[valid]


def _model(config: Mapping[str, Any]) -> LGBMRegressor:
    return LGBMRegressor(
        objective="regression",
        n_estimators=config["nEstimators"],
        learning_rate=config["learningRate"],
        num_leaves=config["numLeaves"],
        random_state=config["seed"],
        deterministic=True,
        force_col_wise=True,
        device_type="cpu",
        n_jobs=1,
        subsample=1.0,
        colsample_bytree=1.0,
        verbosity=-1,
    )
