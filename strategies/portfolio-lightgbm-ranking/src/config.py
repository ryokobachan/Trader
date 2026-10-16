from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np


DEFAULTS = {
    "horizonBars": 5,
    "rebalanceBars": 21,
    "trainWindowBars": 756,
    "minimumTrainingRows": 500,
    "topN": 5,
    "grossExposure": 1.0,
    "minimumPrice": 5.0,
    "liquidityWindowBars": 20,
    "minimumAverageDollarVolume": 1_000_000.0,
    "nEstimators": 100,
    "learningRate": 0.05,
    "numLeaves": 15,
    "seed": 42,
}


def validated_config(params: Mapping[str, Any] | None) -> dict[str, Any]:
    supplied = {} if params is None else dict(params)
    unknown = set(supplied) - set(DEFAULTS)
    if unknown:
        raise ValueError(f"unknown parameters: {', '.join(sorted(unknown))}")
    config = {**DEFAULTS, **supplied}

    for name, minimum in {
        "horizonBars": 1,
        "rebalanceBars": 1,
        "trainWindowBars": 63,
        "minimumTrainingRows": 20,
        "topN": 1,
        "liquidityWindowBars": 1,
        "nEstimators": 1,
        "numLeaves": 2,
    }.items():
        value = config[name]
        if isinstance(value, bool) or not isinstance(value, (int, np.integer)) or value < minimum:
            raise ValueError(f"{name} must be an integer >= {minimum}")
        config[name] = int(value)

    for name, strictly_positive in {
        "grossExposure": False,
        "minimumPrice": False,
        "minimumAverageDollarVolume": False,
        "learningRate": True,
    }.items():
        value = config[name]
        if isinstance(value, bool) or not isinstance(value, (int, float, np.number)):
            raise ValueError(f"{name} must be numeric")
        value = float(value)
        if not np.isfinite(value) or value < 0.0 or (strictly_positive and value == 0.0):
            qualifier = "> 0" if strictly_positive else ">= 0"
            raise ValueError(f"{name} must be finite and {qualifier}")
        config[name] = value

    if config["grossExposure"] > 1.0:
        raise ValueError("grossExposure must be <= 1")

    seed = config["seed"]
    if isinstance(seed, bool) or not isinstance(seed, (int, np.integer)):
        raise ValueError("seed must be an integer")
    config["seed"] = int(seed)
    return config
