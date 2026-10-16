from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np


DEFAULTS = {
    "topN": 5,
    "grossExposure": 1.0,
    "liquidityWindowBars": 20,
    "minimumPrice": 5.0,
    "minimumAverageDollarVolume": 10_000_000.0,
    "minimumMarketCapitalization": 2_000_000_000.0,
    "maximumFundamentalAgeDays": 180,
    "minimumReturnOnEquity": 0.0,
    "minimumOperatingCashFlowToAssets": 0.0,
    "qualityWeight": 0.5,
}


def validated_config(params: Mapping[str, Any] | None) -> dict[str, Any]:
    supplied = {} if params is None else dict(params)
    unknown = set(supplied) - set(DEFAULTS)
    if unknown:
        raise ValueError(f"unknown parameters: {', '.join(sorted(unknown))}")
    config = {**DEFAULTS, **supplied}

    for name, minimum in {
        "topN": 1,
        "liquidityWindowBars": 1,
        "maximumFundamentalAgeDays": 0,
    }.items():
        value = config[name]
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, np.integer))
            or value < minimum
        ):
            raise ValueError(f"{name} must be an integer >= {minimum}")
        config[name] = int(value)

    for name in {
        "grossExposure",
        "minimumPrice",
        "minimumAverageDollarVolume",
        "minimumMarketCapitalization",
        "minimumReturnOnEquity",
        "minimumOperatingCashFlowToAssets",
        "qualityWeight",
    }:
        value = config[name]
        if isinstance(value, bool) or not isinstance(value, (int, float, np.number)):
            raise ValueError(f"{name} must be numeric")
        value = float(value)
        if not np.isfinite(value):
            raise ValueError(f"{name} must be finite")
        config[name] = value

    for name in {
        "grossExposure",
        "minimumPrice",
        "minimumAverageDollarVolume",
        "minimumMarketCapitalization",
        "qualityWeight",
    }:
        if config[name] < 0.0:
            raise ValueError(f"{name} must be >= 0")
    if config["grossExposure"] > 1.0:
        raise ValueError("grossExposure must be <= 1")
    if config["qualityWeight"] > 1.0:
        raise ValueError("qualityWeight must be <= 1")
    return config
