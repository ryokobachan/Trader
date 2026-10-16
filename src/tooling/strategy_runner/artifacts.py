"""Build validated, JSON-serializable artifacts from a VectorBT portfolio.

This module deliberately performs no filesystem writes.  The runner owns the
atomic write boundary after all four returned objects have been built.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from importlib import metadata
import math
from numbers import Integral, Real
import platform
import re
from typing import Any

import numpy as np
import pandas as pd


PERFORMANCE_SCHEMA_VERSION = "trader.strategy-performance.v1"
TRANSACTIONS_SCHEMA_VERSION = "trader.strategy-transactions.v1"
RUN_SCHEMA_VERSION = "trader.strategy-run.v1"
EQUITY_SCHEMA_VERSION = "trader.strategy-equity.v1"
METRICS_DEFINITION_VERSION = "trader.strategy-metrics.v1"

_STRATEGY_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
)
_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9.-]{0,14}$")
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
_MAX_NUMBER = 1_000_000_000_000.0
_MAX_TRANSACTIONS = 50_000
_RELATIVE_TOLERANCE = 1e-9
_ABSOLUTE_TOLERANCE = 1e-8


@dataclass(frozen=True)
class BenchmarkArtifactContext:
    """Inputs needed to calculate a like-for-like benchmark comparison."""

    symbol: str
    portfolio: Any = field(repr=False, compare=False)
    return_type: str = "price"
    costs_applied: bool = False
    data_hash: str | None = None


@dataclass(frozen=True)
class StrategyArtifactContext:
    """Resolved execution context that must accompany a portfolio result."""

    strategy_id: str
    strategy_version: str
    run_id: str
    generated_at: str | datetime
    provider: str
    provider_version: str
    symbols: Sequence[str]
    interval: str
    requested_start: str | date | datetime
    requested_end_exclusive: str | date | datetime
    evaluation_start: str | date | datetime
    evaluation_end_exclusive: str | date | datetime
    data_start: str | date | datetime
    data_end: str | date | datetime
    adjustment: str
    timezone: str
    data_hash: str
    config_hash: str
    code_hash: str
    runner_hash: str
    effective_parameters: Mapping[str, Any]
    benchmark: BenchmarkArtifactContext | None = None
    forward_return_percent: float | None = None
    annualization_days: int = 252
    annual_risk_free_rate: float = 0.0
    runtime_versions: Mapping[str, str] = field(default_factory=dict)
    warnings: Sequence[str] = ()


@dataclass(frozen=True)
class StrategyArtifacts:
    """The complete display and reproducibility artifact set for one run."""

    performance: dict[str, Any]
    transactions: dict[str, Any]
    equity: dict[str, Any]
    run: dict[str, Any]

    def as_dict(self) -> dict[str, dict[str, Any]]:
        return {
            "performance": self.performance,
            "transactions": self.transactions,
            "equity": self.equity,
            "run": self.run,
        }


@dataclass(frozen=True)
class _NormalizedContext:
    strategy_id: str
    strategy_version: str
    run_id: str
    generated_at: str
    provider: str
    provider_version: str
    symbols: tuple[str, ...]
    interval: str
    requested_start: str
    requested_end_exclusive: str
    evaluation_start: str
    evaluation_end_exclusive: str
    data_start: str
    data_end: str
    adjustment: str
    timezone: str
    data_hash: str
    config_hash: str
    code_hash: str
    runner_hash: str
    effective_parameters: dict[str, Any]
    benchmark: BenchmarkArtifactContext | None
    forward_return_percent: float | None
    annualization_days: int
    annual_risk_free_rate: float
    runtime_versions: dict[str, str]
    warnings: tuple[str, ...]


def _safe_text(value: Any, field_name: str, maximum: int = 256) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > maximum
        or _CONTROL_CHARACTERS.search(normalized)
    ):
        raise ValueError(f"{field_name} must contain 1-{maximum} safe characters")
    return normalized


def _iso_date(value: str | date | datetime, field_name: str) -> str:
    if isinstance(value, datetime):
        parsed = value.date()
    elif isinstance(value, date):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = date.fromisoformat(value)
        except ValueError as error:
            raise ValueError(f"{field_name} must use YYYY-MM-DD") from error
        if value != parsed.isoformat():
            raise ValueError(f"{field_name} must use YYYY-MM-DD")
    else:
        raise ValueError(f"{field_name} must be a date or YYYY-MM-DD string")
    return parsed.isoformat()


def _utc_timestamp(value: str | datetime) -> str:
    if isinstance(value, str):
        raw = value.strip()
        try:
            parsed = datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
        except ValueError as error:
            raise ValueError("generated_at must be an ISO-8601 timestamp") from error
    elif isinstance(value, datetime):
        parsed = value
    else:
        raise ValueError("generated_at must be a datetime or ISO-8601 string")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("generated_at must include a timezone")
    return (
        parsed.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _sha256(value: Any, field_name: str) -> str:
    parsed = _safe_text(value, field_name, 64)
    if not _SHA256.fullmatch(parsed):
        raise ValueError(f"{field_name} must be a 64-character SHA-256 digest")
    return parsed.lower()


def _market_symbol(value: Any, field_name: str) -> str:
    parsed = _safe_text(value, field_name, 15)
    if parsed != parsed.upper() or not _SYMBOL.fullmatch(parsed):
        raise ValueError(f"{field_name} must be an uppercase market symbol")
    return parsed


def _finite_or_none(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    parsed = float(value)
    if not math.isfinite(parsed) or abs(parsed) > _MAX_NUMBER:
        return None
    return 0.0 if parsed == 0.0 else parsed


def _required_finite(
    value: Any,
    field_name: str,
    *,
    positive: bool = False,
    non_negative: bool = False,
) -> float:
    parsed = _finite_or_none(value)
    if parsed is None:
        raise ValueError(f"{field_name} must be a finite supported number")
    if positive and parsed <= 0:
        raise ValueError(f"{field_name} must be positive")
    if non_negative and parsed < 0:
        raise ValueError(f"{field_name} must be non-negative")
    return parsed


def _json_value(value: Any, field_name: str, depth: int = 0) -> Any:
    if depth > 16:
        raise ValueError(f"{field_name} exceeds the supported nesting depth")
    if value is None or isinstance(value, (str, bool)):
        if isinstance(value, str) and _CONTROL_CHARACTERS.search(value):
            raise ValueError(f"{field_name} contains control characters")
        return value
    if isinstance(value, Integral) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, Real) and not isinstance(value, bool):
        parsed = _finite_or_none(value)
        if parsed is None:
            raise ValueError(f"{field_name} contains a non-finite or unsupported number")
        return parsed
    if isinstance(value, Mapping):
        normalized: dict[str, Any] = {}
        for key in sorted(value):
            if not isinstance(key, str) or not key or _CONTROL_CHARACTERS.search(key):
                raise ValueError(f"{field_name} contains an invalid object key")
            normalized[key] = _json_value(value[key], f"{field_name}.{key}", depth + 1)
        return normalized
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [
            _json_value(item, f"{field_name}[{index}]", depth + 1)
            for index, item in enumerate(value)
        ]
    raise ValueError(f"{field_name} contains a non-JSON value")


def _installed_runtime_versions(overrides: Mapping[str, str]) -> dict[str, str]:
    distributions = {
        "numpy": ("numpy",),
        "pandas": ("pandas",),
        "numba": ("numba",),
        "scipy": ("scipy",),
        "vectorbt": ("vectorbt",),
        "talib": ("TA-Lib", "ta-lib"),
        "yfinance": ("yfinance",),
        "lightgbm": ("lightgbm",),
    }
    versions = {"python": platform.python_version()}
    for key, candidates in distributions.items():
        version = None
        for distribution in candidates:
            try:
                version = metadata.version(distribution)
                break
            except metadata.PackageNotFoundError:
                continue
        versions[key] = version or "not-installed"
    for key, value in overrides.items():
        versions[_safe_text(key, "runtime_versions key", 64)] = _safe_text(
            value,
            f"runtime_versions.{key}",
            128,
        )
    return dict(sorted(versions.items()))


def _normalize_context(context: StrategyArtifactContext) -> _NormalizedContext:
    strategy_id = _safe_text(context.strategy_id, "strategy_id", 64)
    if not _STRATEGY_ID.fullmatch(strategy_id):
        raise ValueError("strategy_id must be a package directory slug")
    strategy_version = _safe_text(context.strategy_version, "strategy_version", 64)
    if not _SEMVER.fullmatch(strategy_version):
        raise ValueError("strategy_version must use semantic versioning")
    run_id = _safe_text(context.run_id, "run_id", 128)
    generated_at = _utc_timestamp(context.generated_at)
    requested_start = _iso_date(context.requested_start, "requested_start")
    requested_end_exclusive = _iso_date(
        context.requested_end_exclusive,
        "requested_end_exclusive",
    )
    if requested_start >= requested_end_exclusive:
        raise ValueError("requested_start must be earlier than requested_end_exclusive")
    evaluation_start = _iso_date(context.evaluation_start, "evaluation_start")
    evaluation_end_exclusive = _iso_date(
        context.evaluation_end_exclusive,
        "evaluation_end_exclusive",
    )
    if evaluation_start >= evaluation_end_exclusive:
        raise ValueError("evaluation_start must be earlier than evaluation_end_exclusive")
    if (
        evaluation_start < requested_start
        or evaluation_end_exclusive > requested_end_exclusive
    ):
        raise ValueError("evaluation range must fall within the requested data range")
    data_start = _iso_date(context.data_start, "data_start")
    data_end = _iso_date(context.data_end, "data_end")
    if data_start > data_end:
        raise ValueError("data_start must not be later than data_end")
    if data_start < requested_start or data_end >= requested_end_exclusive:
        raise ValueError("actual data bounds must fall within the requested range")
    if data_start > evaluation_start or data_end >= evaluation_end_exclusive:
        raise ValueError("actual data must cover the evaluation range")
    if isinstance(context.symbols, (str, bytes, bytearray)) or not context.symbols:
        raise ValueError("symbols must be a non-empty sequence")
    symbols = tuple(
        _market_symbol(symbol, f"symbols[{index}]")
        for index, symbol in enumerate(context.symbols)
    )
    if len(set(symbols)) != len(symbols):
        raise ValueError("symbols must not contain duplicates")
    if not isinstance(context.effective_parameters, Mapping):
        raise ValueError("effective_parameters must be an object")
    if not isinstance(context.runtime_versions, Mapping):
        raise ValueError("runtime_versions must be an object")
    if isinstance(context.warnings, (str, bytes, bytearray)):
        raise ValueError("warnings must be a sequence of strings")
    if context.benchmark is not None and not isinstance(
        context.benchmark,
        BenchmarkArtifactContext,
    ):
        raise ValueError("benchmark must be a BenchmarkArtifactContext")
    if (
        isinstance(context.annualization_days, bool)
        or not isinstance(context.annualization_days, Integral)
        or context.annualization_days <= 0
        or context.annualization_days > 366
    ):
        raise ValueError("annualization_days must be an integer between 1 and 366")
    annual_risk_free_rate = _required_finite(
        context.annual_risk_free_rate,
        "annual_risk_free_rate",
    )
    if annual_risk_free_rate <= -1:
        raise ValueError("annual_risk_free_rate must be greater than -1")
    forward_return = (
        None
        if context.forward_return_percent is None
        else _required_finite(context.forward_return_percent, "forward_return_percent")
    )
    warnings = tuple(
        _safe_text(item, f"warnings[{index}]", 500)
        for index, item in enumerate(context.warnings)
    )
    return _NormalizedContext(
        strategy_id=strategy_id,
        strategy_version=strategy_version,
        run_id=run_id,
        generated_at=generated_at,
        provider=_safe_text(context.provider, "provider", 80),
        provider_version=_safe_text(context.provider_version, "provider_version", 128),
        symbols=symbols,
        interval=_safe_text(context.interval, "interval", 32),
        requested_start=requested_start,
        requested_end_exclusive=requested_end_exclusive,
        evaluation_start=evaluation_start,
        evaluation_end_exclusive=evaluation_end_exclusive,
        data_start=data_start,
        data_end=data_end,
        adjustment=_safe_text(context.adjustment, "adjustment", 128),
        timezone=_safe_text(context.timezone, "timezone", 80),
        data_hash=_sha256(context.data_hash, "data_hash"),
        config_hash=_sha256(context.config_hash, "config_hash"),
        code_hash=_sha256(context.code_hash, "code_hash"),
        runner_hash=_sha256(context.runner_hash, "runner_hash"),
        effective_parameters=_json_value(
            context.effective_parameters,
            "effective_parameters",
        ),
        benchmark=context.benchmark,
        forward_return_percent=forward_return,
        annualization_days=int(context.annualization_days),
        annual_risk_free_rate=annual_risk_free_rate,
        runtime_versions=_installed_runtime_versions(context.runtime_versions),
        warnings=warnings,
    )


def _record_rows(record_container: Any, field_name: str) -> list[dict[str, Any]]:
    records = getattr(record_container, "records", None)
    if records is None:
        raise ValueError(f"{field_name}.records is unavailable")
    if isinstance(records, pd.DataFrame):
        return records.to_dict(orient="records")
    names = getattr(getattr(records, "dtype", None), "names", None)
    if names:
        return [
            {name: row[name] for name in names}
            for row in records
        ]
    raise ValueError(f"{field_name}.records has an unsupported format")


def _integer(value: Any, field_name: str, *, non_negative: bool = True) -> int:
    if isinstance(value, bool) or not isinstance(value, Integral):
        raise ValueError(f"{field_name} must be an integer")
    parsed = int(value)
    if non_negative and parsed < 0:
        raise ValueError(f"{field_name} must be non-negative")
    return parsed


def _portfolio_index(portfolio: Any) -> Sequence[Any]:
    wrapper = getattr(portfolio, "wrapper", None)
    index = getattr(wrapper, "index", None)
    if index is None:
        raise ValueError("portfolio.wrapper.index is unavailable")
    return index


def _portfolio_columns(portfolio: Any) -> Sequence[Any]:
    wrapper = getattr(portfolio, "wrapper", None)
    columns = getattr(wrapper, "columns", None)
    if columns is None:
        raise ValueError("portfolio.wrapper.columns is unavailable")
    return columns


def _order_date(
    index: Sequence[Any],
    position: int,
    context: _NormalizedContext,
) -> str:
    if position >= len(index):
        raise ValueError("order idx is outside the portfolio index")
    try:
        timestamp = pd.Timestamp(index[position])
    except (TypeError, ValueError) as error:
        raise ValueError("portfolio order timestamp is invalid") from error
    if pd.isna(timestamp):
        raise ValueError("portfolio order timestamp is invalid")
    if timestamp.tzinfo is not None:
        try:
            timestamp = timestamp.tz_convert(context.timezone)
        except (TypeError, ValueError) as error:
            raise ValueError("context timezone is invalid") from error
    result = timestamp.date().isoformat()
    if result < context.data_start or result > context.data_end:
        raise ValueError("portfolio order date is outside the declared data bounds")
    return result


def _transaction_rows(
    portfolio: Any,
    context: _NormalizedContext,
) -> list[dict[str, Any]]:
    rows = _record_rows(getattr(portfolio, "orders", None), "portfolio.orders")
    if len(rows) > _MAX_TRANSACTIONS:
        raise ValueError(f"portfolio contains more than {_MAX_TRANSACTIONS} filled orders")
    index = _portfolio_index(portfolio)
    columns = _portfolio_columns(portfolio)
    normalized: list[tuple[tuple[int, int, int], dict[str, Any]]] = []
    transaction_ids: set[str] = set()
    order_ids: set[int] = set()
    universe = set(context.symbols)
    for row_number, row in enumerate(rows):
        missing = {"id", "col", "idx", "size", "price", "fees", "side"} - row.keys()
        if missing:
            raise ValueError(
                f"portfolio.orders.records[{row_number}] is missing {sorted(missing)}"
            )
        order_id = _integer(row["id"], f"orders[{row_number}].id")
        column_position = _integer(row["col"], f"orders[{row_number}].col")
        index_position = _integer(row["idx"], f"orders[{row_number}].idx")
        if column_position >= len(columns):
            raise ValueError("order col is outside the portfolio columns")
        if order_id in order_ids:
            raise ValueError("VectorBT order identifiers must be globally unique")
        order_ids.add(order_id)
        symbol = _market_symbol(columns[column_position], f"orders[{row_number}].symbol")
        if symbol not in universe:
            raise ValueError(f"order symbol {symbol} is absent from the declared universe")
        side_value = _integer(row["side"], f"orders[{row_number}].side")
        if side_value == 0:
            side = "buy"
        elif side_value == 1:
            side = "sell"
        else:
            raise ValueError("VectorBT order side must be Buy(0) or Sell(1)")
        transaction_id = f"vbt-order-{column_position:04d}-{order_id:08d}"
        if len(transaction_id) > 80 or transaction_id in transaction_ids:
            raise ValueError("generated transaction identifiers are not unique and supported")
        transaction_ids.add(transaction_id)
        transaction = {
            "transactionId": transaction_id,
            "date": _order_date(index, index_position, context),
            "symbol": symbol,
            "side": side,
            "shares": _required_finite(
                row["size"],
                f"orders[{row_number}].size",
                positive=True,
            ),
            "price": _required_finite(
                row["price"],
                f"orders[{row_number}].price",
                non_negative=True,
            ),
            "fee": _required_finite(
                row["fees"],
                f"orders[{row_number}].fees",
                non_negative=True,
            ),
        }
        # VectorBT assigns the global order ID in actual execution order.  In a
        # cash-sharing portfolio this matters: sells are deliberately filled
        # before buys on the same bar, even when their symbol column sorts
        # later.  Preserve that ledger order in the portable artifact.
        normalized.append(((index_position, order_id, column_position), transaction))
    normalized.sort(key=lambda item: item[0])
    return [transaction for _, transaction in normalized]


def _scalar(value: Any, field_name: str) -> float | None:
    if isinstance(value, pd.DataFrame):
        values = value.to_numpy().reshape(-1)
    elif isinstance(value, (pd.Series, pd.Index)):
        values = value.to_numpy().reshape(-1)
    elif isinstance(value, np.ndarray):
        values = value.reshape(-1)
    else:
        return _finite_or_none(value)
    if len(values) != 1:
        raise ValueError(f"{field_name} must resolve to one cash-sharing portfolio")
    return _finite_or_none(values[0])


def _series(value: Any, field_name: str) -> np.ndarray:
    if isinstance(value, pd.DataFrame):
        if value.shape[1] != 1:
            raise ValueError(f"{field_name} must resolve to one cash-sharing portfolio")
        values = value.iloc[:, 0].to_numpy(dtype="float64")
    elif isinstance(value, pd.Series):
        values = value.to_numpy(dtype="float64")
    else:
        array = np.asarray(value, dtype="float64")
        if array.ndim == 0:
            values = array.reshape(1)
        elif array.ndim == 1:
            values = array
        elif array.ndim == 2 and array.shape[1] == 1:
            values = array[:, 0]
        else:
            raise ValueError(f"{field_name} must resolve to one cash-sharing portfolio")
    return values[np.isfinite(values)]


def _portfolio_values(portfolio: Any) -> np.ndarray:
    try:
        values = portfolio.value(group_by=True)
    except (AttributeError, TypeError) as error:
        raise ValueError("portfolio.value(group_by=True) is unavailable") from error
    parsed = _series(values, "portfolio.value")
    if len(parsed) == 0:
        raise ValueError("portfolio value series contains no finite values")
    return parsed


def _aligned_portfolio_value_series(
    portfolio: Any,
    context: _NormalizedContext,
    field_name: str,
) -> tuple[tuple[str, ...], tuple[float, ...]]:
    try:
        raw = portfolio.value(group_by=True)
    except (AttributeError, TypeError) as error:
        raise ValueError(f"{field_name}.value(group_by=True) is unavailable") from error
    if isinstance(raw, pd.DataFrame):
        if raw.shape[1] != 1:
            raise ValueError(f"{field_name} must resolve to one portfolio value series")
        values = raw.iloc[:, 0].to_numpy(dtype="float64")
    elif isinstance(raw, pd.Series):
        values = raw.to_numpy(dtype="float64")
    else:
        values = np.asarray(raw, dtype="float64").reshape(-1)

    index = pd.DatetimeIndex(_portfolio_index(portfolio))
    if len(index) != len(values) or len(index) == 0:
        raise ValueError(f"{field_name} value series must align with its index")
    if index.tz is not None:
        try:
            index = index.tz_convert(context.timezone).tz_localize(None)
        except (TypeError, ValueError) as error:
            raise ValueError("context timezone is invalid") from error
    if index.has_duplicates or not index.is_monotonic_increasing:
        raise ValueError(f"{field_name} index must be unique and increasing")
    if not np.isfinite(values).all() or (values < 0.0).any():
        raise ValueError(f"{field_name} values must be finite and non-negative")
    dates = tuple(timestamp.date().isoformat() for timestamp in index)
    if dates[0] < context.evaluation_start or dates[-1] >= context.evaluation_end_exclusive:
        raise ValueError(f"{field_name} values are outside the evaluation range")
    return dates, tuple(float(value) for value in values)


def _portfolio_initial_value(portfolio: Any, field_name: str) -> float:
    try:
        raw = portfolio.init_cash
    except AttributeError as error:
        raise ValueError(f"{field_name}.init_cash is unavailable") from error
    values = np.asarray(raw, dtype="float64").reshape(-1)
    if len(values) != 1 or not np.isfinite(values[0]) or values[0] <= 0.0:
        raise ValueError(
            f"{field_name}.init_cash must resolve to one positive finite value"
        )
    return float(values[0])


def _approximately_equal(left: float, right: float) -> bool:
    return math.isclose(
        left,
        right,
        rel_tol=_RELATIVE_TOLERANCE,
        abs_tol=_ABSOLUTE_TOLERANCE,
    )


def _final_column_values(
    value: Any,
    field_name: str,
    columns: tuple[str, ...],
) -> tuple[float, ...]:
    if isinstance(value, pd.DataFrame):
        if len(value.index) == 0 or value.shape[1] != len(columns):
            raise ValueError(
                f"{field_name} must contain one non-empty series per portfolio column"
            )
        result_columns = tuple(
            _market_symbol(column, f"{field_name}.columns[{index}]")
            for index, column in enumerate(value.columns)
        )
        if result_columns != columns:
            raise ValueError(f"{field_name} columns must match portfolio.wrapper.columns")
        raw_values = value.iloc[-1].to_numpy()
    elif isinstance(value, pd.Series):
        if len(columns) != 1 or len(value.index) == 0:
            raise ValueError(
                f"{field_name} must contain one non-empty series per portfolio column"
            )
        result_column = _market_symbol(value.name, f"{field_name}.name")
        if result_column != columns[0]:
            raise ValueError(f"{field_name} name must match portfolio.wrapper.columns")
        raw_values = np.asarray([value.iloc[-1]])
    else:
        raise ValueError(f"{field_name} must be a pandas Series or DataFrame")
    return tuple(
        _required_finite(raw_value, f"{field_name}.final[{index}]")
        for index, raw_value in enumerate(raw_values)
    )


def _final_positions(
    portfolio: Any,
    context: _NormalizedContext,
    final_value: float | None,
    final_cash_percent: float | None,
    open_trade_count: int,
) -> list[dict[str, Any]]:
    columns = tuple(
        _market_symbol(column, f"portfolio.wrapper.columns[{index}]")
        for index, column in enumerate(_portfolio_columns(portfolio))
    )
    if columns != context.symbols:
        raise ValueError(
            "portfolio.wrapper.columns must exactly match the declared symbol universe"
        )
    try:
        assets = _final_column_values(
            portfolio.assets(),
            "portfolio.assets",
            columns,
        )
        asset_values = _final_column_values(
            portfolio.asset_value(group_by=False),
            "portfolio.asset_value",
            columns,
        )
        open_rows = _record_rows(portfolio.trades.open, "portfolio.trades.open")
    except (AttributeError, TypeError) as error:
        raise ValueError("portfolio final-position state is unavailable") from error
    if len(open_rows) != open_trade_count:
        raise ValueError("portfolio open trade count changed while building artifacts")

    open_trades: dict[int, tuple[float, float]] = {}
    for row_number, row in enumerate(open_rows):
        missing = {"col", "size", "pnl", "direction", "status"} - row.keys()
        if missing:
            raise ValueError(
                f"portfolio.trades.open.records[{row_number}] is missing {sorted(missing)}"
            )
        column_position = _integer(
            row["col"],
            f"portfolio.trades.open.records[{row_number}].col",
        )
        if column_position >= len(columns):
            raise ValueError("open trade col is outside the portfolio columns")
        if column_position in open_trades:
            raise ValueError("each final position must resolve to exactly one open trade")
        if _integer(
            row["direction"],
            f"portfolio.trades.open.records[{row_number}].direction",
        ) != 0:
            raise ValueError("final positions must contain long trades only")
        if _integer(
            row["status"],
            f"portfolio.trades.open.records[{row_number}].status",
        ) != 0:
            raise ValueError("portfolio.trades.open must contain open trade records")
        open_trades[column_position] = (
            _required_finite(
                row["size"],
                f"portfolio.trades.open.records[{row_number}].size",
                positive=True,
            ),
            _required_finite(
                row["pnl"],
                f"portfolio.trades.open.records[{row_number}].pnl",
            ),
        )

    positions: list[dict[str, Any]] = []
    for column_position, symbol in enumerate(columns):
        shares = assets[column_position]
        market_value = asset_values[column_position]
        if _approximately_equal(shares, 0.0):
            if not _approximately_equal(market_value, 0.0):
                raise ValueError("zero final shares must have zero asset value")
            if column_position in open_trades:
                raise ValueError("zero final shares must not have an open trade")
            continue
        if shares < 0:
            raise ValueError("final position shares must be positive")
        if market_value <= 0:
            raise ValueError("final position market value must be positive")
        open_trade = open_trades.get(column_position)
        if open_trade is None:
            raise ValueError("positive final shares must have an open trade")
        open_shares, unrealized_pnl = open_trade
        if not _approximately_equal(shares, open_shares):
            raise ValueError("final asset shares must match the open trade size")
        cost_basis = _required_finite(
            market_value - unrealized_pnl,
            f"finalPositions[{len(positions)}].costBasis",
            positive=True,
        )
        average_cost = _required_finite(
            cost_basis / shares,
            f"finalPositions[{len(positions)}].averageCost",
            positive=True,
        )
        mark_price = _required_finite(
            market_value / shares,
            f"finalPositions[{len(positions)}].markPrice",
            positive=True,
        )
        if final_value is None or final_value <= 0 or final_cash_percent is None:
            raise ValueError(
                "positive final positions require final value and cash percentage"
            )
        allocation_percent = _required_finite(
            market_value / final_value * 100.0,
            f"finalPositions[{len(positions)}].allocationPercent",
            positive=True,
        )
        if allocation_percent > 100.0:
            if _approximately_equal(allocation_percent, 100.0):
                allocation_percent = 100.0
            else:
                raise ValueError("final position allocation must not exceed 100%")
        positions.append({
            "symbol": symbol,
            "shares": shares,
            "averageCost": average_cost,
            "markPrice": mark_price,
            "marketValue": market_value,
            "allocationPercent": allocation_percent,
            "unrealizedPnl": unrealized_pnl,
        })

    if len(positions) != open_trade_count or len(open_trades) != len(positions):
        raise ValueError("final positions must match the portfolio open trades")
    if final_value is not None and final_cash_percent is not None:
        holdings_value = sum(position["marketValue"] for position in positions)
        expected_holdings_value = final_value * (1.0 - final_cash_percent / 100.0)
        if not _approximately_equal(holdings_value, expected_holdings_value):
            raise ValueError("final position values and cash must reconcile to final value")
        total_allocation = sum(
            position["allocationPercent"] for position in positions
        ) + final_cash_percent
        if not _approximately_equal(total_allocation, 100.0):
            raise ValueError("final position allocations and cash must total 100%")
    return positions


def _total_return_percent(portfolio: Any) -> float | None:
    try:
        value = portfolio.total_return(group_by=True)
    except (AttributeError, TypeError) as error:
        raise ValueError("portfolio.total_return(group_by=True) is unavailable") from error
    parsed = _scalar(value, "portfolio.total_return")
    return None if parsed is None else _finite_or_none(parsed * 100.0)


def _max_drawdown_percent(portfolio: Any) -> float | None:
    try:
        value = portfolio.max_drawdown(group_by=True)
    except (AttributeError, TypeError) as error:
        raise ValueError("portfolio.max_drawdown(group_by=True) is unavailable") from error
    parsed = _scalar(value, "portfolio.max_drawdown")
    if parsed is None:
        values = _portfolio_values(portfolio)
        peaks = np.maximum.accumulate(values)
        valid = peaks > 0
        if not valid.any():
            return None
        parsed = float(np.min(values[valid] / peaks[valid] - 1.0))
    result = _finite_or_none(parsed * 100.0)
    if result is not None and result > 0:
        raise ValueError("portfolio max drawdown must be non-positive")
    return result


def _periodic_risk_free_rate(context: _NormalizedContext) -> float:
    return math.expm1(
        math.log1p(context.annual_risk_free_rate) / context.annualization_days
    )


def _sharpe(portfolio: Any, context: _NormalizedContext) -> float | None:
    try:
        value = portfolio.sharpe_ratio(
            group_by=True,
            year_freq=f"{context.annualization_days}D",
            risk_free=_periodic_risk_free_rate(context),
            ddof=1,
        )
    except (AttributeError, TypeError, ValueError, ZeroDivisionError):
        return None
    return _scalar(value, "portfolio.sharpe_ratio")


def _trade_record_count(trades: Any, field_name: str) -> int:
    return len(_record_rows(trades, field_name))


def _closed_trade_count(portfolio: Any) -> int:
    try:
        return _trade_record_count(portfolio.trades.closed, "portfolio.trades.closed")
    except AttributeError as error:
        raise ValueError("portfolio.trades.closed is unavailable") from error


def _open_trade_count(portfolio: Any) -> int:
    try:
        return _trade_record_count(portfolio.trades.open, "portfolio.trades.open")
    except AttributeError as error:
        raise ValueError("portfolio.trades.open is unavailable") from error


def _closed_win_rate_percent(portfolio: Any, closed_count: int) -> float | None:
    if closed_count == 0:
        return None
    try:
        value = portfolio.trades.closed.win_rate(group_by=True)
    except (AttributeError, TypeError) as error:
        raise ValueError("portfolio.trades.closed.win_rate is unavailable") from error
    parsed = _scalar(value, "portfolio.trades.closed.win_rate")
    result = None if parsed is None else _finite_or_none(parsed * 100.0)
    if result is not None and not 0 <= result <= 100:
        raise ValueError("closed trade win rate must be between 0 and 100")
    return result


def _final_cash_percent(portfolio: Any) -> float | None:
    try:
        cash = _series(portfolio.cash(group_by=True), "portfolio.cash")
    except (AttributeError, TypeError) as error:
        raise ValueError("portfolio.cash(group_by=True) is unavailable") from error
    values = _portfolio_values(portfolio)
    if len(cash) == 0 or values[-1] <= 0:
        return None
    result = _finite_or_none(cash[-1] / values[-1] * 100.0)
    if result is None:
        return None
    epsilon = 1e-9
    if -epsilon <= result < 0:
        result = 0.0
    elif 100 < result <= 100 + epsilon:
        result = 100.0
    if not 0 <= result <= 100:
        return None
    return result


def _elapsed_years(portfolio: Any, context: _NormalizedContext) -> float:
    index = _portfolio_index(portfolio)
    if len(index) >= 2:
        try:
            first = pd.Timestamp(index[0])
            last = pd.Timestamp(index[-1])
            elapsed = (last - first).total_seconds() / (365.2425 * 24 * 60 * 60)
            if math.isfinite(elapsed) and elapsed > 0:
                return elapsed
        except (TypeError, ValueError):
            pass
    return (
        date.fromisoformat(context.data_end) - date.fromisoformat(context.data_start)
    ).days / 365.2425


def _cagr_percent(portfolio: Any, context: _NormalizedContext) -> float | None:
    values = _portfolio_values(portfolio)
    years = _elapsed_years(portfolio, context)
    if years <= 0 or values[0] <= 0 or values[-1] <= 0:
        return None
    try:
        result = (values[-1] / values[0]) ** (1.0 / years) - 1.0
    except (OverflowError, ZeroDivisionError):
        return None
    return _finite_or_none(result * 100.0)


def _performance_metrics(
    portfolio: Any,
    context: _NormalizedContext,
    transactions: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    net_return = _total_return_percent(portfolio)
    max_drawdown = _max_drawdown_percent(portfolio)
    recovery_factor = None
    if (
        net_return is not None
        and max_drawdown is not None
        and abs(max_drawdown) > 1e-15
    ):
        recovery_factor = _finite_or_none(net_return / abs(max_drawdown))
    closed_count = _closed_trade_count(portfolio)
    return {
        "netReturn": net_return,
        "maxDrawdown": max_drawdown,
        "recoveryFactor": recovery_factor,
        "sharpe": _sharpe(portfolio, context),
        "forwardReturn": context.forward_return_percent,
        "winRate": _closed_win_rate_percent(portfolio, closed_count),
        # The current package loader defines this as the number of persisted
        # transaction rows, which are filled VectorBT orders rather than round trips.
        "trades": len(transactions),
        "symbols": len({transaction["symbol"] for transaction in transactions}),
        "cash": _final_cash_percent(portfolio),
    }


def _total_fees(transactions: Sequence[Mapping[str, Any]]) -> float:
    total = math.fsum(float(transaction["fee"]) for transaction in transactions)
    parsed = _finite_or_none(total)
    if parsed is None or parsed < 0:
        raise ValueError("total order fees are invalid")
    return parsed


def _benchmark_metadata(
    context: _NormalizedContext,
    strategy_metrics: Mapping[str, Any],
) -> dict[str, Any] | None:
    benchmark = context.benchmark
    if benchmark is None:
        return None
    if not isinstance(benchmark.costs_applied, bool):
        raise ValueError("benchmark.costs_applied must be a boolean")
    symbol = _safe_text(benchmark.symbol, "benchmark.symbol", 32)
    return_type = _safe_text(benchmark.return_type, "benchmark.return_type", 32)
    net_return = _total_return_percent(benchmark.portfolio)
    max_drawdown = _max_drawdown_percent(benchmark.portfolio)
    sharpe = _sharpe(benchmark.portfolio, context)
    cagr = _cagr_percent(benchmark.portfolio, context)
    strategy_return = strategy_metrics["netReturn"]
    excess_return = (
        None
        if strategy_return is None or net_return is None
        else _finite_or_none(float(strategy_return) - net_return)
    )
    return {
        "symbol": symbol,
        "returnType": return_type,
        "costsApplied": bool(benchmark.costs_applied),
        "dataSha256": (
            None
            if benchmark.data_hash is None
            else _sha256(benchmark.data_hash, "benchmark.data_hash")
        ),
        "metrics": {
            "netReturn": net_return,
            "maxDrawdown": max_drawdown,
            "sharpe": sharpe,
            "cagr": cagr,
            "excessReturn": excess_return,
        },
    }


def _performance_artifact(
    context: _NormalizedContext,
    metrics: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schemaVersion": PERFORMANCE_SCHEMA_VERSION,
        "strategyId": context.strategy_id,
        "strategyVersion": context.strategy_version,
        "runId": context.run_id,
        "generatedAt": context.generated_at,
        "provenance": "backtest_artifact",
        "metrics": dict(metrics),
    }


def _transactions_artifact(
    context: _NormalizedContext,
    transactions: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    return {
        "schemaVersion": TRANSACTIONS_SCHEMA_VERSION,
        "strategyId": context.strategy_id,
        "strategyVersion": context.strategy_version,
        "runId": context.run_id,
        "generatedAt": context.generated_at,
        "transactions": [dict(transaction) for transaction in transactions],
    }


def _equity_artifact(
    portfolio: Any,
    context: _NormalizedContext,
) -> dict[str, Any]:
    dates, portfolio_values = _aligned_portfolio_value_series(
        portfolio, context, "portfolio"
    )
    initial_value = _portfolio_initial_value(portfolio, "portfolio")
    benchmark_values: tuple[float, ...] | None = None
    if context.benchmark is not None:
        benchmark_initial_value = _portfolio_initial_value(
            context.benchmark.portfolio,
            "benchmark",
        )
        if not _approximately_equal(initial_value, benchmark_initial_value):
            raise ValueError(
                "benchmark initial cash must match the strategy initial cash"
            )
        benchmark_dates, benchmark_values = _aligned_portfolio_value_series(
            context.benchmark.portfolio,
            context,
            "benchmark",
        )
        if benchmark_dates != dates:
            raise ValueError("benchmark value series must align with the strategy calendar")
    return {
        "schemaVersion": EQUITY_SCHEMA_VERSION,
        "strategyId": context.strategy_id,
        "strategyVersion": context.strategy_version,
        "runId": context.run_id,
        "generatedAt": context.generated_at,
        "frequency": context.interval,
        "initialValue": initial_value,
        "points": [
            {
                "date": date_value,
                "portfolioValue": portfolio_value,
                "benchmarkValue": (
                    None if benchmark_values is None else benchmark_values[index]
                ),
            }
            for index, (date_value, portfolio_value) in enumerate(
                zip(dates, portfolio_values)
            )
        ],
    }


def _run_metadata(
    portfolio: Any,
    context: _NormalizedContext,
    transactions: Sequence[Mapping[str, Any]],
    metrics: Mapping[str, Any],
) -> dict[str, Any]:
    values = _portfolio_values(portfolio)
    final_value = _finite_or_none(values[-1])
    closed_count = _closed_trade_count(portfolio)
    open_count = _open_trade_count(portfolio)
    final_cash_percent = metrics["cash"]
    final_positions = _final_positions(
        portfolio,
        context,
        final_value,
        final_cash_percent,
        open_count,
    )
    result = {
        "schemaVersion": RUN_SCHEMA_VERSION,
        "metricsDefinitionVersion": METRICS_DEFINITION_VERSION,
        "strategyId": context.strategy_id,
        "strategyVersion": context.strategy_version,
        "runId": context.run_id,
        "generatedAt": context.generated_at,
        "data": {
            "provider": context.provider,
            "providerVersion": context.provider_version,
            "symbols": list(context.symbols),
            "interval": context.interval,
            "requestedStart": context.requested_start,
            "requestedEndExclusive": context.requested_end_exclusive,
            "evaluationStart": context.evaluation_start,
            "evaluationEndExclusive": context.evaluation_end_exclusive,
            "start": context.data_start,
            "end": context.data_end,
            "adjustment": context.adjustment,
            "timezone": context.timezone,
            "sha256": context.data_hash,
        },
        "reproducibility": {
            "configSha256": context.config_hash,
            "codeSha256": context.code_hash,
            "runnerSha256": context.runner_hash,
            "runtime": context.runtime_versions,
            "effectiveParameters": context.effective_parameters,
            "annualizationDays": context.annualization_days,
            "annualRiskFreeRate": context.annual_risk_free_rate,
            "periodicRiskFreeRate": _periodic_risk_free_rate(context),
        },
        "execution": {
            "transactionMapping": "vectorbt_filled_orders",
            "orderCount": len(transactions),
            "closedTradeCount": closed_count,
            "openTradeCount": open_count,
            "totalTradeCount": closed_count + open_count,
            "totalFees": _total_fees(transactions),
            "finalValue": final_value,
            "finalCashPercent": final_cash_percent,
            "finalPositions": final_positions,
            "cagr": _cagr_percent(portfolio, context),
        },
        "benchmark": _benchmark_metadata(context, metrics),
        "warnings": list(context.warnings),
    }
    normalized = _json_value(result, "run")
    if not isinstance(normalized, dict):
        raise AssertionError("run metadata normalization must return an object")
    return normalized


def _validate_artifact_pair(
    performance: Mapping[str, Any],
    transactions: Mapping[str, Any],
) -> None:
    performance_keys = {
        "schemaVersion",
        "strategyId",
        "strategyVersion",
        "runId",
        "generatedAt",
        "provenance",
        "metrics",
    }
    transaction_keys = {
        "schemaVersion",
        "strategyId",
        "strategyVersion",
        "runId",
        "generatedAt",
        "transactions",
    }
    if set(performance) != performance_keys or set(transactions) != transaction_keys:
        raise AssertionError("current package artifact schemas must remain exact")
    for field_name in ("strategyId", "strategyVersion", "runId", "generatedAt"):
        if performance[field_name] != transactions[field_name]:
            raise AssertionError(f"artifact {field_name} values must match")
    metric_keys = {
        "netReturn",
        "maxDrawdown",
        "recoveryFactor",
        "sharpe",
        "forwardReturn",
        "winRate",
        "trades",
        "symbols",
        "cash",
    }
    metrics = performance["metrics"]
    rows = transactions["transactions"]
    if not isinstance(metrics, Mapping) or set(metrics) != metric_keys:
        raise AssertionError("performance metrics must match the current schema")
    if not isinstance(rows, Sequence):
        raise AssertionError("transactions must be an array")
    if metrics["trades"] != len(rows):
        raise AssertionError("trade count must equal persisted order rows")
    if metrics["symbols"] != len({row["symbol"] for row in rows}):
        raise AssertionError("symbol count must equal distinct persisted order symbols")


def build_strategy_artifacts(
    portfolio: Any,
    context: StrategyArtifactContext,
) -> StrategyArtifacts:
    """Build the complete in-memory artifact set for one successful run."""

    normalized_context = _normalize_context(context)
    transactions = _transaction_rows(portfolio, normalized_context)
    metrics = _performance_metrics(portfolio, normalized_context, transactions)
    performance_artifact = _performance_artifact(normalized_context, metrics)
    transactions_artifact = _transactions_artifact(normalized_context, transactions)
    equity_artifact = _equity_artifact(portfolio, normalized_context)
    _validate_artifact_pair(performance_artifact, transactions_artifact)
    run_metadata = _run_metadata(
        portfolio,
        normalized_context,
        transactions,
        metrics,
    )
    return StrategyArtifacts(
        performance=performance_artifact,
        transactions=transactions_artifact,
        equity=equity_artifact,
        run=run_metadata,
    )


def build_performance_artifact(
    portfolio: Any,
    context: StrategyArtifactContext,
) -> dict[str, Any]:
    """Build only the current-schema performance object without writing it."""

    normalized_context = _normalize_context(context)
    transactions = _transaction_rows(portfolio, normalized_context)
    return _performance_artifact(
        normalized_context,
        _performance_metrics(portfolio, normalized_context, transactions),
    )


def build_transactions_artifact(
    portfolio: Any,
    context: StrategyArtifactContext,
) -> dict[str, Any]:
    """Build only the current-schema filled-order transaction object."""

    normalized_context = _normalize_context(context)
    return _transactions_artifact(
        normalized_context,
        _transaction_rows(portfolio, normalized_context),
    )


def build_run_metadata(
    portfolio: Any,
    context: StrategyArtifactContext,
) -> dict[str, Any]:
    """Build only compact reproducibility metadata for a successful run."""

    normalized_context = _normalize_context(context)
    transactions = _transaction_rows(portfolio, normalized_context)
    metrics = _performance_metrics(portfolio, normalized_context, transactions)
    return _run_metadata(portfolio, normalized_context, transactions, metrics)


def build_equity_artifact(
    portfolio: Any,
    context: StrategyArtifactContext,
) -> dict[str, Any]:
    """Build the reproducible daily strategy and benchmark value series."""

    return _equity_artifact(portfolio, _normalize_context(context))


__all__ = [
    "BenchmarkArtifactContext",
    "StrategyArtifactContext",
    "StrategyArtifacts",
    "build_equity_artifact",
    "build_performance_artifact",
    "build_run_metadata",
    "build_strategy_artifacts",
    "build_transactions_artifact",
]
