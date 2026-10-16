"""Bounded TA-Lib calculations over caller-supplied OHLCV, without data fetching.

Every request uses a fresh abstract Function. Values before its lookback are
null, including integer candlestick outputs where TA-Lib returns leading zeros.
"""

from __future__ import annotations

import math
import re
from datetime import date, datetime, timezone
from typing import Any

import numpy as np
import talib
from talib import abstract

SCHEMA_VERSION = "trader.talib.v1"
MAX_BARS = 10_000
MAX_INDICATORS = 8
MAX_PARAMETER_MAGNITUDE = 1_000_000
PRICE_COLUMNS = frozenset({"open", "high", "low", "close", "volume"})
BAR_FIELDS = PRICE_COLUMNS | {"time"}
EXCLUDED_GROUPS = frozenset({"Math Operators", "Math Transform"})
EXCLUDED_FUNCTIONS = frozenset({"MAVP", "BETA", "CORREL"})
FUNCTION_IDS = tuple(
    name
    for group, names in talib.get_function_groups().items()
    if group not in EXCLUDED_GROUPS
    for name in names
    if name not in EXCLUDED_FUNCTIONS
)
FUNCTION_ID_SET = frozenset(FUNCTION_IDS)
DATE_LABEL = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
INSTANT_LABEL = re.compile(r"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})")
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _base() -> dict[str, Any]:
    return {"schemaVersion": SCHEMA_VERSION, "engine": "TA-Lib", "version": talib.__version__}


def _metadata(function: Any) -> dict[str, Any]:
    info = function.info
    return {
        "id": info["name"],
        "name": info["display_name"],
        "group": info["group"],
        "parameters": dict(function.parameters),
        "inputs": dict(function.input_names),
        "outputs": list(function.output_names),
        "lookback": function.lookback,
    }


def catalog() -> dict[str, Any]:
    """Return the supported calculation contract, not remotely fetched data."""
    return {
        **_base(),
        "limits": {"maxBars": MAX_BARS, "maxIndicators": MAX_INDICATORS, "maxPeriod": MAX_BARS},
        "indicators": [_metadata(abstract.Function(name)) for name in FUNCTION_IDS],
    }


def _number(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _instant(label: Any) -> int:
    if not isinstance(label, str):
        raise ValueError("bar time must be a canonical date or ISO timestamp with timezone")
    if DATE_LABEL.fullmatch(label):
        instant = datetime.combine(date.fromisoformat(label), datetime.min.time(), timezone.utc)
        fraction = 0
    else:
        match = INSTANT_LABEL.fullmatch(label)
        if not match:
            raise ValueError("bar time must be a canonical date or ISO timestamp with timezone")
        base, decimal, zone = match.groups()
        if int(base[11:13]) > 23 or int(base[14:16]) > 59 or int(base[17:19]) > 59:
            raise ValueError("bar time has invalid clock fields")
        if zone != "Z" and (int(zone[1:3]) > 23 or int(zone[4:6]) > 59):
            raise ValueError("bar time has an invalid timezone offset")
        # Parsing the zone and actual calendar/time fields rejects impossible
        # dates and timezone offsets; retain up to nanoseconds for ordering.
        instant = datetime.fromisoformat(base + ("+00:00" if zone == "Z" else zone))
        fraction = int((decimal or "").ljust(9, "0"))
    delta = instant - EPOCH
    return (delta.days * 86400 + delta.seconds) * 1_000_000_000 + fraction


def _bars(value: Any) -> tuple[list[str], dict[str, np.ndarray]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_BARS:
        raise ValueError("bars must contain between 1 and 10000 observations")
    times = []
    columns: dict[str, list[float]] = {column: [] for column in PRICE_COLUMNS}
    previous: int | None = None
    for bar in value:
        if not isinstance(bar, dict) or set(bar) != BAR_FIELDS:
            raise ValueError("each bar must contain exactly time and OHLCV")
        instant = _instant(bar["time"])
        if previous is not None and instant <= previous:
            raise ValueError("bar times must represent ordered unique instants")
        if any(not _number(bar[column]) or bar[column] < 0 for column in PRICE_COLUMNS):
            raise ValueError("OHLCV values must be finite nonnegative numbers")
        if not bar["low"] <= min(bar["open"], bar["close"]) <= max(bar["open"], bar["close"]) <= bar["high"]:
            raise ValueError("bar OHLC range is inconsistent")
        previous = instant
        times.append(bar["time"])
        for column in PRICE_COLUMNS:
            columns[column].append(float(bar[column]))
    return times, {column: np.asarray(values, dtype=np.float64) for column, values in columns.items()}


def _parameters(function: Any, requested: Any) -> None:
    defaults = dict(function.parameters)
    if not isinstance(requested, dict) or not set(requested).issubset(defaults):
        raise ValueError("unknown indicator parameter")
    parameters = {}
    for key, value in requested.items():
        if not _number(value):
            raise ValueError("indicator parameters must be finite numbers")
        if isinstance(defaults[key], int):
            if value != int(value):
                raise ValueError("integer indicator parameter required")
            value = int(value)
            if "matype" in key:
                if not 0 <= value <= 8:
                    raise ValueError("moving average type must be between 0 and 8")
            elif not 1 <= value <= MAX_BARS:
                raise ValueError("indicator periods must be between 1 and 10000")
        else:
            value = float(value)
            if abs(value) > MAX_PARAMETER_MAGNITUDE or (key != "startvalue" and value < 0):
                raise ValueError("indicator parameter is outside its supported range")
            if key in {"penetration", "vfactor", "fastlimit", "slowlimit"} and value > 1:
                raise ValueError("indicator fraction must be between 0 and 1")
        parameters[key] = value
    function.set_parameters(parameters)
    # TA-Lib's native lookback functions return -1 for invalid ranges, even
    # when the abstract parameter setter accepted the numeric value.
    if function.lookback < 0:
        raise ValueError("indicator parameters are invalid for this function")


def _inputs(function: Any, requested: Any) -> None:
    defaults = dict(function.input_names)
    if not isinstance(requested, dict) or not set(requested).issubset(defaults):
        raise ValueError("unknown indicator input")
    for key, value in requested.items():
        expected = defaults[key]
        if isinstance(expected, list):
            if not isinstance(value, list) or len(value) != len(expected) or any(not isinstance(column, str) or column not in PRICE_COLUMNS for column in value):
                raise ValueError("indicator input must preserve its OHLCV column count")
        elif not isinstance(value, str) or value not in PRICE_COLUMNS:
            raise ValueError("indicator input must be an OHLCV column")
    function.set_input_names(requested)


def _function(specification: Any) -> Any:
    if not isinstance(specification, dict) or not {"id"} <= set(specification) <= {"id", "parameters", "inputs"}:
        raise ValueError("invalid indicator specification")
    identifier = specification["id"]
    if not isinstance(identifier, str) or identifier not in FUNCTION_ID_SET:
        raise ValueError("unsupported indicator")
    function = abstract.Function(identifier)
    _parameters(function, specification.get("parameters", {}))
    _inputs(function, specification.get("inputs", {}))
    return function


def calculate(payload: Any) -> dict[str, Any]:
    """Calculate up to eight indicators; no filesystem, network, or evaluation."""
    if not isinstance(payload, dict) or set(payload) != {"bars", "indicators"}:
        raise ValueError("payload must contain exactly bars and indicators")
    times, columns = _bars(payload["bars"])
    specifications = payload["indicators"]
    if not isinstance(specifications, list) or not 1 <= len(specifications) <= MAX_INDICATORS:
        raise ValueError("between 1 and 8 indicators are required")
    functions = [_function(specification) for specification in specifications]
    identifiers = [function.info["name"] for function in functions]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("indicator ids must be unique")
    results = []
    for function in functions:
        metadata = _metadata(function)
        try:
            output = function(columns)
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError("indicator calculation failed") from error
        outputs = [output] if len(function.output_names) == 1 else list(output)
        series = []
        for name, values in zip(function.output_names, outputs, strict=True):
            if len(values) != len(times):
                raise ValueError("indicator output does not align with input bars")
            series.append({
                "name": name,
                "values": [
                    None if index < metadata["lookback"] or not math.isfinite(float(value))
                    else int(value) if np.issubdtype(values.dtype, np.integer) else float(value)
                    for index, value in enumerate(values)
                ],
            })
        results.append({key: value for key, value in metadata.items() if key != "outputs"} | {"series": series})
    return {**_base(), "times": times, "barCount": len(times), "results": results}
