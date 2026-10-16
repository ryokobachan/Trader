from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
import struct
from typing import Mapping, Sequence

import numpy as np
import pandas as pd
import yfinance as yf


YAHOO_FIELDS = {
    "open": "Open",
    "high": "High",
    "low": "Low",
    "close": "Close",
    "volume": "Volume",
}


@dataclass(frozen=True)
class MarketSnapshot:
    market_data: Mapping[str, pd.DataFrame]
    benchmark_close: pd.Series | None
    provider: str
    provider_version: str
    interval: str
    adjustment: str
    requested_start: str
    requested_end_exclusive: str
    actual_start: str
    actual_end: str
    data_sha256: str
    benchmark_sha256: str | None


def _normalized_frame_for_hash(frame: pd.DataFrame) -> bytes:
    """Return a canonical lossless byte representation of one numeric panel.

    Missing fundamental observations are part of the dataset contract, so the
    representation stores a separate missing-value mask and canonicalizes the
    corresponding numeric payload to zero.  Infinities remain invalid.
    """

    if not isinstance(frame, pd.DataFrame):
        raise TypeError("market-data hash input must be a pandas DataFrame")
    index = pd.DatetimeIndex(frame.index)
    if index.tz is not None:
        raise ValueError("market-data hash input must use a timezone-naive index")
    if not index.is_monotonic_increasing or not index.is_unique:
        raise ValueError("market-data hash index must be sorted and unique")
    columns = tuple(frame.columns)
    if any(not isinstance(column, str) or not column for column in columns):
        raise ValueError("market-data hash columns must be non-empty strings")
    try:
        values = frame.to_numpy(dtype=np.float64, copy=True)
    except (TypeError, ValueError) as error:
        raise TypeError("market-data hash values must be numeric") from error
    if np.isinf(values).any():
        raise ValueError("market-data hash values must not contain infinity")

    missing = np.isnan(values)
    values[missing] = 0.0

    # Canonicalize both arrays to little-endian fixed-width representations.
    # This preserves every float64 bit used by the simulator and remains stable
    # across CSV formatting, locale, host byte order, and pandas display changes.
    timestamps = np.ascontiguousarray(
        index.to_numpy(dtype="datetime64[ns]").astype("<i8", copy=False)
    )
    numeric_values = np.ascontiguousarray(values, dtype="<f8")
    missing_values = np.ascontiguousarray(missing, dtype=np.uint8)
    output = bytearray(b"trader.market-frame.v2\0")
    output.extend(struct.pack("<QQ", len(index), len(columns)))
    output.extend(b"datetime64[ns]\0float64-le\0")
    for column in columns:
        encoded = column.encode("utf-8")
        output.extend(struct.pack("<Q", len(encoded)))
        output.extend(encoded)
    output.extend(timestamps.tobytes(order="C"))
    output.extend(missing_values.tobytes(order="C"))
    output.extend(numeric_values.tobytes(order="C"))
    return bytes(output)


def snapshot_data_hash(
    market_data: Mapping[str, pd.DataFrame],
    benchmark_close: pd.Series | None,
) -> str:
    digest = sha256()
    for field in sorted(market_data):
        digest.update(f"field:{field}\n".encode())
        digest.update(_normalized_frame_for_hash(market_data[field]))
    if benchmark_close is not None:
        digest.update(b"benchmark\n")
        digest.update(_normalized_frame_for_hash(benchmark_close.to_frame("benchmark")))
    return digest.hexdigest()


def frame_data_hash(frame: pd.DataFrame) -> str:
    """Hash one normalized panel with the same canonical representation."""

    return sha256(_normalized_frame_for_hash(frame)).hexdigest()


def _validate_symbols(symbols: Sequence[str]) -> tuple[str, ...]:
    normalized = tuple(symbol.strip().upper() for symbol in symbols)
    if len(normalized) < 2:
        raise ValueError("at least two symbols are required for a portfolio strategy")
    if any(not symbol for symbol in normalized) or len(set(normalized)) != len(normalized):
        raise ValueError("symbols must be non-empty and unique")
    return normalized


def fetch_yahoo_snapshot(
    *,
    symbols: Sequence[str],
    required_fields: Sequence[str],
    benchmark_symbol: str | None,
    start: str,
    end_exclusive: str,
    interval: str = "1d",
) -> MarketSnapshot:
    """Fetch one strict, adjusted, complete multi-symbol Yahoo snapshot."""
    normalized_symbols = _validate_symbols(symbols)
    normalized_fields = tuple(dict.fromkeys(field.strip().lower() for field in required_fields))
    unsupported = [field for field in normalized_fields if field not in YAHOO_FIELDS]
    if unsupported:
        raise ValueError(f"unsupported Yahoo fields: {', '.join(unsupported)}")
    if not normalized_fields:
        raise ValueError("at least one market-data field is required")

    tickers = [*normalized_symbols]
    if benchmark_symbol and benchmark_symbol not in tickers:
        tickers.append(benchmark_symbol)
    raw = yf.download(
        tickers,
        start=start,
        end=end_exclusive,
        interval=interval,
        auto_adjust=True,
        actions=False,
        repair=True,
        group_by="column",
        progress=False,
        threads=True,
    )
    if raw.empty or not isinstance(raw.columns, pd.MultiIndex):
        raise RuntimeError("Yahoo returned no usable multi-symbol data")

    market_data: dict[str, pd.DataFrame] = {}
    for field in normalized_fields:
        provider_field = YAHOO_FIELDS[field]
        if provider_field not in raw.columns.get_level_values(0):
            raise RuntimeError(f"Yahoo response is missing {provider_field}")
        frame = raw[provider_field].reindex(columns=normalized_symbols).astype("float64")
        frame.index = pd.DatetimeIndex(frame.index)
        if frame.index.tz is not None:
            frame.index = frame.index.tz_convert(None)
        frame = frame.sort_index()
        values = frame.to_numpy(dtype=np.float64, copy=False)
        if frame.empty or not np.isfinite(values).all():
            invalid = int((~np.isfinite(values)).sum())
            raise RuntimeError(f"Yahoo {field} panel is incomplete ({invalid} invalid values)")
        market_data[field] = frame

    reference_index = next(iter(market_data.values())).index
    if any(not frame.index.equals(reference_index) for frame in market_data.values()):
        raise RuntimeError("Yahoo fields do not share one trading calendar")

    benchmark_close: pd.Series | None = None
    if benchmark_symbol:
        try:
            benchmark_close = raw["Close"][benchmark_symbol].astype("float64")
        except KeyError as error:
            raise RuntimeError("Yahoo response is missing the benchmark close") from error
        benchmark_close.index = pd.DatetimeIndex(benchmark_close.index)
        if benchmark_close.index.tz is not None:
            benchmark_close.index = benchmark_close.index.tz_convert(None)
        benchmark_close = benchmark_close.sort_index().reindex(reference_index)
        if not np.isfinite(benchmark_close.to_numpy(dtype=np.float64, copy=False)).all():
            raise RuntimeError("Yahoo benchmark does not cover the strategy calendar")

    return MarketSnapshot(
        market_data=market_data,
        benchmark_close=benchmark_close,
        provider="yfinance",
        provider_version=yf.__version__,
        interval=interval,
        adjustment="yfinance_auto_adjust=true;repair=true",
        requested_start=start,
        requested_end_exclusive=end_exclusive,
        actual_start=reference_index[0].strftime("%Y-%m-%d"),
        actual_end=reference_index[-1].strftime("%Y-%m-%d"),
        data_sha256=snapshot_data_hash(market_data, benchmark_close),
        benchmark_sha256=(
            None
            if benchmark_close is None
            else frame_data_hash(benchmark_close.to_frame("benchmark"))
        ),
    )


def source_file_hash(strategy_dir: Path) -> str:
    """Hash every package execution input while excluding generated output."""
    digest = sha256()
    excluded_root_files = {
        "config.json",
        "equity.json",
        "performance.json",
        "transactions.json",
        "run.json",
        ".strategy-backtest.lock",
    }
    excluded_directories = {
        "tests",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
    }
    source_files: list[Path] = []
    for file_path in sorted(strategy_dir.rglob("*")):
        relative = file_path.relative_to(strategy_dir)
        if file_path.is_symlink():
            raise ValueError(f"strategy packages may not contain symlinks: {relative}")
        if any(part in excluded_directories for part in relative.parts[:-1]):
            continue
        if not file_path.is_file():
            continue
        if len(relative.parts) == 1 and relative.name in excluded_root_files:
            continue
        if relative.name.lower().startswith("readme") or relative.suffix == ".pyc":
            continue
        source_files.append(file_path)
    if strategy_dir / "main.py" not in source_files:
        raise FileNotFoundError(strategy_dir / "main.py")
    for file_path in source_files:
        digest.update(file_path.relative_to(strategy_dir).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()
