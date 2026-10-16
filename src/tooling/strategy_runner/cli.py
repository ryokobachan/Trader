"""Execute one portable Trader strategy package with VectorBT.

Each invocation loads exactly one strategy in its own Python process.  This
keeps package-local ``main`` and ``src`` modules isolated from other packages.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
from importlib import metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import sys
from typing import Any, Mapping, Sequence

import pandas as pd
import vectorbt as vbt


TOOLING_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
if str(TOOLING_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLING_ROOT))

from strategy_runner.artifacts import (  # noqa: E402
    BenchmarkArtifactContext,
    StrategyArtifactContext,
    build_strategy_artifacts,
)
from strategy_runner.data import YAHOO_FIELDS, fetch_yahoo_snapshot, source_file_hash  # noqa: E402
from strategy_runner.execution import simulate_target_weight_portfolio  # noqa: E402
from strategy_runner.sec_companyfacts import (  # noqa: E402
    SEC_REQUIRED_FIELDS,
    fetch_sec_fundamental_snapshot,
)


STRATEGY_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SEMVER = re.compile(
    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
PARAMETER_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
BENCHMARK_SYMBOL = re.compile(r"^\^?[A-Z0-9][A-Z0-9.-]{0,14}$")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
MAX_CONFIG_BYTES = 1_000_000
MAX_CONFIG_NUMBER = 1_000_000_000_000.0


class RunnerInputError(ValueError):
    """Raised when a package or CLI input violates the runner contract."""


def _unique_json_object(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    for key, value in pairs:
        if key in parsed:
            raise ValueError(f"duplicate JSON key: {key}")
        parsed[key] = value
    return parsed


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"unsupported JSON number: {value}")


def _config_object(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RunnerInputError(f"{location} must be an object")
    return value


def _exact_keys(
    value: Mapping[str, Any],
    expected: set[str],
    location: str,
) -> None:
    actual = set(value)
    unknown = sorted(actual - expected)
    missing = sorted(expected - actual)
    if unknown:
        raise RunnerInputError(f"{location} contains unknown fields: {', '.join(unknown)}")
    if missing:
        raise RunnerInputError(f"{location} is missing fields: {', '.join(missing)}")


def _config_number(value: Any, location: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RunnerInputError(f"{location} must be a finite number")
    try:
        parsed = float(value)
    except (OverflowError, ValueError) as error:
        raise RunnerInputError(f"{location} must be a finite number") from error
    if not math.isfinite(parsed) or abs(parsed) > MAX_CONFIG_NUMBER:
        raise RunnerInputError(f"{location} must be a supported finite number")
    return parsed


def _config_text(value: Any, location: str, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > maximum
        or CONTROL_CHARACTERS.search(value)
    ):
        raise RunnerInputError(
            f"{location} must contain 1-{maximum} safe characters"
        )
    return value


def _validate_display(value: Any) -> None:
    display = _config_object(value, "config.display")
    _exact_keys(
        display,
        {"order", "family", "status", "candidateAt", "audit", "copy"},
        "config.display",
    )
    order = display.get("order")
    if (
        isinstance(order, bool)
        or not isinstance(order, int)
        or not 0 <= order <= MAX_CONFIG_NUMBER
    ):
        raise RunnerInputError("config.display.order must be a non-negative safe integer")
    if display.get("family") not in {"portfolio2", "rule", "research"}:
        raise RunnerInputError("config.display.family is unsupported")
    if display.get("status") not in {"pinned", "research"}:
        raise RunnerInputError("config.display.status is unsupported")
    _config_text(display.get("candidateAt"), "config.display.candidateAt", 64)

    audit = _config_object(display.get("audit"), "config.display.audit")
    _exact_keys(audit, {"overfit", "leakage"}, "config.display.audit")
    for field in ("overfit", "leakage"):
        if audit.get(field) is not None:
            _config_number(audit[field], f"config.display.audit.{field}")

    copy = _config_object(display.get("copy"), "config.display.copy")
    _exact_keys(copy, {"en", "ja"}, "config.display.copy")
    for locale in ("en", "ja"):
        location = f"config.display.copy.{locale}"
        localized = _config_object(copy.get(locale), location)
        _exact_keys(
            localized,
            {"name", "category", "sourceLabels", "headline", "auditVerdict"},
            location,
        )
        _config_text(localized.get("name"), f"{location}.name", 120)
        _config_text(localized.get("category"), f"{location}.category", 120)
        _config_text(localized.get("headline"), f"{location}.headline", 500)
        _config_text(localized.get("auditVerdict"), f"{location}.auditVerdict", 240)
        labels = localized.get("sourceLabels")
        if not isinstance(labels, list) or len(labels) > 24:
            raise RunnerInputError(
                f"{location}.sourceLabels must contain at most 24 labels"
            )
        for index, label in enumerate(labels):
            _config_text(label, f"{location}.sourceLabels[{index}]", 80)
        if len(set(labels)) != len(labels):
            raise RunnerInputError(f"{location}.sourceLabels must be unique")


def _validated_parameters(config: Mapping[str, Any]) -> dict[str, Any]:
    definitions = _config_object(config.get("parameters"), "config.parameters")
    if len(definitions) > 256:
        raise RunnerInputError("config.parameters contains too many entries")
    resolved: dict[str, Any] = {}
    allowed_keys = {
        "type",
        "default",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
    }
    for name, raw_definition in definitions.items():
        if not isinstance(name, str) or not PARAMETER_NAME.fullmatch(name):
            raise RunnerInputError("strategy parameter names must be safe identifiers")
        location = f"config.parameters.{name}"
        definition = _config_object(raw_definition, location)
        unknown = sorted(set(definition) - allowed_keys)
        if unknown:
            raise RunnerInputError(
                f"{location} contains unknown fields: {', '.join(unknown)}"
            )
        if "type" not in definition or "default" not in definition:
            raise RunnerInputError(f"{location} requires type and default")
        parameter_type = definition["type"]
        if parameter_type not in {"integer", "number"}:
            raise RunnerInputError(f"{location}.type must be integer or number")
        default = definition["default"]
        if parameter_type == "integer":
            if isinstance(default, bool) or not isinstance(default, int):
                raise RunnerInputError(f"{location}.default must be an integer")
            _config_number(default, f"{location}.default")
        else:
            _config_number(default, f"{location}.default")

        bounds: dict[str, float] = {}
        for field in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"):
            if field not in definition:
                continue
            bound = definition[field]
            if parameter_type == "integer" and (
                isinstance(bound, bool) or not isinstance(bound, int)
            ):
                raise RunnerInputError(f"{location}.{field} must be an integer")
            bounds[field] = _config_number(bound, f"{location}.{field}")
        if "minimum" in bounds and "exclusiveMinimum" in bounds:
            raise RunnerInputError(f"{location} cannot define both lower bounds")
        if "maximum" in bounds and "exclusiveMaximum" in bounds:
            raise RunnerInputError(f"{location} cannot define both upper bounds")
        lower = bounds.get("minimum", bounds.get("exclusiveMinimum"))
        upper = bounds.get("maximum", bounds.get("exclusiveMaximum"))
        if lower is not None and upper is not None:
            if lower > upper or (
                lower == upper
                and ("exclusiveMinimum" in bounds or "exclusiveMaximum" in bounds)
            ):
                raise RunnerInputError(f"{location} has an empty numeric range")
        default_number = float(default)
        if "minimum" in bounds and default_number < bounds["minimum"]:
            raise RunnerInputError(f"{location}.default is below minimum")
        if "exclusiveMinimum" in bounds and default_number <= bounds["exclusiveMinimum"]:
            raise RunnerInputError(f"{location}.default is not above exclusiveMinimum")
        if "maximum" in bounds and default_number > bounds["maximum"]:
            raise RunnerInputError(f"{location}.default is above maximum")
        if "exclusiveMaximum" in bounds and default_number >= bounds["exclusiveMaximum"]:
            raise RunnerInputError(f"{location}.default is not below exclusiveMaximum")
        resolved[name] = default
    return resolved


def _validate_config(parsed: dict[str, Any], strategy_dir: Path) -> None:
    _exact_keys(
        parsed,
        {
            "schemaVersion",
            "id",
            "name",
            "version",
            "display",
            "entrypoint",
            "runtimeProfile",
            "interface",
            "marketData",
            "parameters",
            "backtest",
        },
        "config",
    )
    if parsed.get("schemaVersion") != "trader.strategy-package.v1":
        raise RunnerInputError("unsupported config schemaVersion")
    if parsed.get("id") != strategy_dir.name:
        raise RunnerInputError("config.json id must match the strategy directory")
    _config_text(parsed.get("name"), "config.name", 200)
    version = parsed.get("version")
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        raise RunnerInputError("config.version must use semantic versioning")
    _validate_display(parsed.get("display"))
    if parsed.get("entrypoint") != "main.py:generate":
        raise RunnerInputError("only main.py:generate is supported")
    if parsed.get("runtimeProfile") != "trader-vectorbt-v1":
        raise RunnerInputError("unsupported runtimeProfile")
    if parsed.get("interface") != "trader.target-weights.v1":
        raise RunnerInputError("unsupported strategy interface")

    market_data = _config_object(parsed.get("marketData"), "config.marketData")
    _exact_keys(
        market_data,
        {"requiredFields", "minSymbols", "warmupBars"},
        "config.marketData",
    )
    fields = market_data.get("requiredFields")
    field_set = (
        set(fields)
        if isinstance(fields, list) and all(isinstance(field, str) for field in fields)
        else set()
    )
    if (
        not isinstance(fields, list)
        or not fields
        or len(fields) > 32
        or any(
            not isinstance(field, str)
            or field not in (set(YAHOO_FIELDS) | set(SEC_REQUIRED_FIELDS))
            for field in fields
        )
        or len(set(fields)) != len(fields)
        or "close" not in fields
        or not (
            field_set <= set(YAHOO_FIELDS)
            or field_set == set(SEC_REQUIRED_FIELDS)
        )
    ):
        raise RunnerInputError(
            "config.marketData.requiredFields must match a supported data profile containing close"
        )
    minimum_symbols = market_data.get("minSymbols")
    if (
        isinstance(minimum_symbols, bool)
        or not isinstance(minimum_symbols, int)
        or not 2 <= minimum_symbols <= 10_000
    ):
        raise RunnerInputError("config.marketData.minSymbols must be an integer from 2 to 10000")
    warmup_bars = market_data.get("warmupBars")
    if (
        isinstance(warmup_bars, bool)
        or not isinstance(warmup_bars, int)
        or not 0 <= warmup_bars <= 10_000
    ):
        raise RunnerInputError("config.marketData.warmupBars must be an integer from 0 to 10000")
    _validated_parameters(parsed)

    backtest = _config_object(parsed.get("backtest"), "config.backtest")
    _exact_keys(
        backtest,
        {
            "marketRegion",
            "baseCurrency",
            "initialCash",
            "barInterval",
            "valuationPriceField",
            "execution",
            "portfolio",
            "positionSizing",
            "costs",
            "risk",
            "benchmark",
        },
        "config.backtest",
    )
    if backtest.get("marketRegion") != "US" or backtest.get("baseCurrency") != "USD":
        raise RunnerInputError("the current runner requires US market and USD base currency")
    if backtest.get("barInterval") != "1d":
        raise RunnerInputError("the current runner supports daily bars only")
    initial_cash = _config_number(backtest.get("initialCash"), "config.backtest.initialCash")
    if initial_cash <= 0:
        raise RunnerInputError("config.backtest.initialCash must be greater than zero")

    execution = _config_object(backtest.get("execution"), "config.backtest.execution")
    _exact_keys(
        execution,
        {"delayBars", "priceField", "rebalanceSequence"},
        "config.backtest.execution",
    )
    portfolio = _config_object(backtest.get("portfolio"), "config.backtest.portfolio")
    _exact_keys(
        portfolio,
        {"cashSharing", "grouping", "direction"},
        "config.backtest.portfolio",
    )
    sizing = _config_object(backtest.get("positionSizing"), "config.backtest.positionSizing")
    _exact_keys(
        sizing,
        {"mode", "weightUnit", "minimumOrderShares", "shareIncrement"},
        "config.backtest.positionSizing",
    )
    for field in ("minimumOrderShares", "shareIncrement"):
        if _config_number(sizing.get(field), f"config.backtest.positionSizing.{field}") <= 0:
            raise RunnerInputError(f"config.backtest.positionSizing.{field} must be positive")
    costs = _config_object(backtest.get("costs"), "config.backtest.costs")
    _exact_keys(
        costs,
        {"proportionalFeeRate", "fixedFeePerOrder", "slippageRate"},
        "config.backtest.costs",
    )
    for field in ("proportionalFeeRate", "slippageRate"):
        rate = _config_number(costs.get(field), f"config.backtest.costs.{field}")
        if not 0 <= rate < 1:
            raise RunnerInputError(f"config.backtest.costs.{field} must be in [0, 1)")
    if _config_number(costs.get("fixedFeePerOrder"), "config.backtest.costs.fixedFeePerOrder") < 0:
        raise RunnerInputError("config.backtest.costs.fixedFeePerOrder must be non-negative")

    risk = _config_object(backtest.get("risk"), "config.backtest.risk")
    _exact_keys(
        risk,
        {
            "appliedBy",
            "stopLossRate",
            "takeProfitRate",
            "trailingStopLossRate",
            "triggerPriceField",
            "fillTiming",
            "referencePrice",
            "reentryPolicy",
        },
        "config.backtest.risk",
    )
    for field in ("stopLossRate", "takeProfitRate"):
        value = risk.get(field)
        if value is None:
            continue
        rate = _config_number(value, f"config.backtest.risk.{field}")
        if rate <= 0 or (field == "stopLossRate" and rate >= 1):
            raise RunnerInputError(f"config.backtest.risk.{field} has an unsupported rate")

    benchmark = _config_object(backtest.get("benchmark"), "config.backtest.benchmark")
    _exact_keys(
        benchmark,
        {"symbol", "assetType", "returnType", "costsApplied"},
        "config.backtest.benchmark",
    )
    benchmark_symbol = benchmark.get("symbol")
    if not isinstance(benchmark_symbol, str) or not BENCHMARK_SYMBOL.fullmatch(benchmark_symbol):
        raise RunnerInputError("config.backtest.benchmark.symbol is unsupported")
    if benchmark.get("assetType") not in {"index", "etf"}:
        raise RunnerInputError("config.backtest.benchmark.assetType must be index or etf")
    if benchmark.get("returnType") != "price":
        raise RunnerInputError("config.backtest.benchmark.returnType must be price")
    if not isinstance(benchmark.get("costsApplied"), bool):
        raise RunnerInputError("config.backtest.benchmark.costsApplied must be boolean")
    if benchmark.get("costsApplied") is not False:
        raise RunnerInputError("config.backtest.benchmark.costsApplied must be false")
    _assert_execution_contract(backtest)


def _arguments(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="npm run strategy:backtest --",
        description="Run one Trader portfolio strategy with VectorBT.",
    )
    parser.add_argument("strategy_id", help="Direct child directory under strategies/")
    parser.add_argument(
        "--symbols",
        required=True,
        help="Comma-separated portfolio universe (at least two symbols)",
    )
    parser.add_argument("--start", required=True, help="Inclusive evaluation date YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="Exclusive evaluation date YYYY-MM-DD")
    parser.add_argument(
        "--write",
        action="store_true",
        help="Replace performance.json, transactions.json, and run.json after validation",
    )
    return parser.parse_args(argv)


def _strategy_directory(strategy_id: str) -> Path:
    if not STRATEGY_SLUG.fullmatch(strategy_id):
        raise RunnerInputError("strategy_id must be a lowercase package slug")
    strategies_root = (REPOSITORY_ROOT / "strategies").resolve(strict=True)
    candidate = strategies_root / strategy_id
    if candidate.is_symlink() or not candidate.is_dir():
        raise RunnerInputError(f"strategy package does not exist: {strategy_id}")
    resolved = candidate.resolve(strict=True)
    if resolved.parent != strategies_root:
        raise RunnerInputError("strategy package resolves outside strategies/")
    return resolved


def _load_config(strategy_dir: Path) -> tuple[dict[str, Any], bytes]:
    config_path = strategy_dir / "config.json"
    try:
        raw = config_path.read_bytes()
        if len(raw) > MAX_CONFIG_BYTES:
            raise ValueError("config.json is too large")
        parsed = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise RunnerInputError("config.json is missing or invalid") from error
    if not isinstance(parsed, dict):
        raise RunnerInputError("config.json must contain an object")
    _validate_config(parsed, strategy_dir)
    return parsed, raw


def _symbols(value: str, minimum: int) -> tuple[str, ...]:
    parsed = tuple(item.strip().upper() for item in value.split(",") if item.strip())
    if len(parsed) < minimum:
        raise RunnerInputError(f"the strategy requires at least {minimum} symbols")
    if len(set(parsed)) != len(parsed):
        raise RunnerInputError("symbols must be unique")
    if any(not re.fullmatch(r"[A-Z0-9][A-Z0-9.-]{0,14}", item) for item in parsed):
        raise RunnerInputError("symbols contain an unsupported market identifier")
    return parsed


def _date_argument(value: str, location: str) -> str:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise RunnerInputError(f"{location} must use YYYY-MM-DD") from error
    if value != parsed.isoformat():
        raise RunnerInputError(f"{location} must use YYYY-MM-DD")
    return value


def _resolved_parameters(config: Mapping[str, Any]) -> dict[str, Any]:
    return _validated_parameters(config)


def _load_generate(strategy_dir: Path):
    main_path = strategy_dir / "main.py"
    if main_path.is_symlink() or not main_path.is_file():
        raise RunnerInputError("main.py is missing")
    sys.path.insert(0, str(strategy_dir))
    module_name = f"_trader_strategy_{strategy_dir.name.replace('-', '_')}"
    spec = importlib.util.spec_from_file_location(module_name, main_path)
    if spec is None or spec.loader is None:
        raise RunnerInputError("main.py could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    generate = getattr(module, "generate", None)
    if not callable(generate):
        raise RunnerInputError("main.py must export callable generate")
    return generate


def _target_weights(
    result: Any,
    close: pd.DataFrame,
) -> pd.DataFrame:
    if not isinstance(result, dict):
        raise RunnerInputError("generate must return an object")
    if result.get("type") != "orders" or result.get("size_type") != "targetpercent":
        raise RunnerInputError("generate must return target-percent orders")
    targets = result.get("target_weights")
    if not isinstance(targets, pd.DataFrame):
        raise RunnerInputError("generate target_weights must be a DataFrame")
    if not targets.index.equals(close.index) or not targets.columns.equals(close.columns):
        raise RunnerInputError("target_weights must exactly align with the close panel")
    return targets


def _mapping(value: Any, location: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise RunnerInputError(f"{location} must be an object")
    return value


def _assert_execution_contract(backtest: Mapping[str, Any]) -> None:
    execution = _mapping(backtest.get("execution"), "backtest.execution")
    portfolio = _mapping(backtest.get("portfolio"), "backtest.portfolio")
    sizing = _mapping(backtest.get("positionSizing"), "backtest.positionSizing")
    risk = _mapping(backtest.get("risk"), "backtest.risk")
    expected = {
        "backtest.valuationPriceField": (backtest.get("valuationPriceField"), "close"),
        "backtest.execution.priceField": (execution.get("priceField"), "close"),
        "backtest.execution.rebalanceSequence": (execution.get("rebalanceSequence"), "sellThenBuy"),
        "backtest.portfolio.cashSharing": (portfolio.get("cashSharing"), True),
        "backtest.portfolio.grouping": (portfolio.get("grouping"), "allSymbols"),
        "backtest.portfolio.direction": (portfolio.get("direction"), "longOnly"),
        "backtest.positionSizing.mode": (sizing.get("mode"), "targetWeight"),
        "backtest.positionSizing.weightUnit": (sizing.get("weightUnit"), "fraction"),
        "backtest.risk.appliedBy": (risk.get("appliedBy"), "runner"),
        "backtest.risk.triggerPriceField": (risk.get("triggerPriceField"), "close"),
        "backtest.risk.fillTiming": (risk.get("fillTiming"), "nextBarClose"),
        "backtest.risk.referencePrice": (risk.get("referencePrice"), "weightedAverageFill"),
        "backtest.risk.reentryPolicy": (risk.get("reentryPolicy"), "nextExplicitTarget"),
    }
    for location, (actual, required) in expected.items():
        if actual != required:
            raise RunnerInputError(f"{location} must be {required!r}")
    if risk.get("trailingStopLossRate") is not None:
        raise RunnerInputError("trailing stops are not supported by this runner version")
    delay_bars = execution.get("delayBars")
    if isinstance(delay_bars, bool) or not isinstance(delay_bars, int) or delay_bars < 1:
        raise RunnerInputError("backtest.execution.delayBars must be an integer of at least 1")


def _benchmark_portfolio(close: pd.Series, initial_cash: float) -> vbt.Portfolio:
    return vbt.Portfolio.from_holding(
        close,
        init_cash=initial_cash,
        fees=0.0,
        fixed_fees=0.0,
        slippage=0.0,
        freq="1D",
    )


def _run_id(
    *,
    strategy_id: str,
    strategy_version: str,
    data_hash: str,
    config_hash: str,
    code_hash: str,
    runner_hash: str,
    parameters: Mapping[str, Any],
    runtime_versions: Mapping[str, str],
    evaluation_start: str,
    evaluation_end_exclusive: str,
) -> str:
    identity = json.dumps(
        {
            "strategyId": strategy_id,
            "strategyVersion": strategy_version,
            "dataSha256": data_hash,
            "configSha256": config_hash,
            "codeSha256": code_hash,
            "runnerSha256": runner_hash,
            "parameters": parameters,
            "runtime": runtime_versions,
            "evaluationStart": evaluation_start,
            "evaluationEndExclusive": evaluation_end_exclusive,
            "engine": "trader-vectorbt-v1",
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return f"run-{sha256(identity).hexdigest()[:24]}"


def _runner_source_hash() -> str:
    digest = sha256()
    runner_root = Path(__file__).resolve().parent
    source_files = [
        *sorted(runner_root.glob("*.py")),
        REPOSITORY_ROOT / "src/tooling/scripts/strategy-backtest.mjs",
        REPOSITORY_ROOT / "requirements-strategy.txt",
    ]
    for file_path in source_files:
        relative = file_path.relative_to(REPOSITORY_ROOT)
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _runtime_versions() -> dict[str, str]:
    distributions = {
        "numpy": "numpy",
        "pandas": "pandas",
        "numba": "numba",
        "scipy": "scipy",
        "vectorbt": "vectorbt",
        "talib": "TA-Lib",
        "yfinance": "yfinance",
        "lightgbm": "lightgbm",
    }
    versions = {"python": platform.python_version()}
    for key, distribution in distributions.items():
        try:
            versions[key] = metadata.version(distribution)
        except metadata.PackageNotFoundError:
            versions[key] = "not-installed"
    return dict(sorted(versions.items()))


@dataclass(frozen=True)
class _ExecutionIdentity:
    config_bytes: bytes
    config_hash: str
    code_hash: str
    runner_hash: str
    runtime_versions: tuple[tuple[str, str], ...]


def _capture_execution_identity(
    strategy_dir: Path,
    config_bytes: bytes,
) -> _ExecutionIdentity:
    runtime_versions = _runtime_versions()
    return _ExecutionIdentity(
        config_bytes=config_bytes,
        config_hash=sha256(config_bytes).hexdigest(),
        code_hash=source_file_hash(strategy_dir),
        runner_hash=_runner_source_hash(),
        runtime_versions=tuple(sorted(runtime_versions.items())),
    )


def _assert_execution_identity_unchanged(
    strategy_dir: Path,
    expected: _ExecutionIdentity,
) -> None:
    try:
        _, current_config_bytes = _load_config(strategy_dir)
        current_code_hash = source_file_hash(strategy_dir)
        current_runner_hash = _runner_source_hash()
        current_runtime_versions = tuple(sorted(_runtime_versions().items()))
    except (OSError, TypeError, ValueError, RuntimeError) as error:
        raise RunnerInputError(
            "execution inputs became unavailable or invalid while the strategy was running"
        ) from error
    if current_config_bytes != expected.config_bytes:
        raise RunnerInputError("config.json changed while the strategy was running")
    if current_code_hash != expected.code_hash:
        raise RunnerInputError("strategy source changed while the strategy was running")
    if current_runner_hash != expected.runner_hash:
        raise RunnerInputError("strategy runner changed while the strategy was running")
    if current_runtime_versions != expected.runtime_versions:
        raise RunnerInputError("strategy runtime changed while the strategy was running")


def _write_artifacts(strategy_dir: Path, artifacts: Mapping[str, Mapping[str, Any]]) -> None:
    lock_path = strategy_dir / ".strategy-backtest.lock"
    try:
        lock_descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise RunnerInputError(
            "another write is active; remove .strategy-backtest.lock only after verifying it is stale"
        ) from error
    temporary: list[tuple[Path, Path]] = []
    try:
        os.write(lock_descriptor, f"pid={os.getpid()}\n".encode("ascii"))
        os.fsync(lock_descriptor)
        # run.json is the commit marker and is replaced last.
        for stem in ("transactions", "performance", "equity", "run"):
            target = strategy_dir / f"{stem}.json"
            temp = strategy_dir / f".{stem}.json.{os.getpid()}.tmp"
            rendered = json.dumps(
                artifacts[stem],
                ensure_ascii=False,
                indent=2,
                allow_nan=False,
            ) + "\n"
            with temp.open("w", encoding="utf-8") as output:
                output.write(rendered)
                output.flush()
                os.fsync(output.fileno())
            temporary.append((temp, target))
        for temp, target in temporary:
            os.replace(temp, target)
    finally:
        os.close(lock_descriptor)
        for temp, _ in temporary:
            temp.unlink(missing_ok=True)
        lock_path.unlink(missing_ok=True)


def run(argv: Sequence[str] | None = None) -> dict[str, Any]:
    args = _arguments(argv)
    strategy_dir = _strategy_directory(args.strategy_id)
    config, config_bytes = _load_config(strategy_dir)
    execution_identity = _capture_execution_identity(strategy_dir, config_bytes)
    runtime_versions = dict(execution_identity.runtime_versions)
    parameters = _resolved_parameters(config)
    market_contract = _mapping(config.get("marketData"), "marketData")
    minimum_symbols = int(market_contract.get("minSymbols", 2))
    symbols = _symbols(args.symbols, minimum_symbols)
    required_fields = market_contract.get("requiredFields")
    if not isinstance(required_fields, list) or not all(
        isinstance(field, str) for field in required_fields
    ):
        raise RunnerInputError("marketData.requiredFields must be a string array")
    backtest = _mapping(config.get("backtest"), "backtest")
    _assert_execution_contract(backtest)
    if backtest.get("marketRegion") != "US" or backtest.get("barInterval") != "1d":
        raise RunnerInputError("the current runner supports US daily strategies only")

    benchmark_config = _mapping(backtest.get("benchmark"), "backtest.benchmark")
    benchmark_symbol = benchmark_config.get("symbol")
    if not isinstance(benchmark_symbol, str):
        raise RunnerInputError("backtest.benchmark.symbol must be a string")
    if benchmark_config.get("returnType") != "price" or benchmark_config.get("costsApplied") is not False:
        raise RunnerInputError("the current runner supports a cost-free price-return benchmark")
    start = _date_argument(args.start, "--start")
    end_exclusive = _date_argument(args.end, "--end")
    if start >= end_exclusive:
        raise RunnerInputError("--start must be earlier than --end")
    raw_warmup_bars = market_contract.get("warmupBars", 0)
    if (
        isinstance(raw_warmup_bars, bool)
        or not isinstance(raw_warmup_bars, int)
        or raw_warmup_bars < 0
    ):
        raise RunnerInputError("marketData.warmupBars must be a non-negative integer")
    warmup_bars = raw_warmup_bars
    try:
        provider_start = (
            date.fromisoformat(start) - timedelta(days=max(30, warmup_bars * 2 + 30))
        ).isoformat()
    except OverflowError as error:
        raise RunnerInputError("--start is too early for the configured warmup") from error
    required_field_set = set(required_fields)
    sec_snapshot = None
    if required_field_set <= set(YAHOO_FIELDS):
        snapshot = fetch_yahoo_snapshot(
            symbols=symbols,
            required_fields=required_fields,
            benchmark_symbol=benchmark_symbol,
            start=provider_start,
            end_exclusive=end_exclusive,
            interval="1d",
        )
    elif required_field_set == set(SEC_REQUIRED_FIELDS):
        snapshot, sec_snapshot = fetch_sec_fundamental_snapshot(
            symbols=symbols,
            required_fields=required_fields,
            benchmark_symbol=benchmark_symbol,
            start=provider_start,
            end_exclusive=end_exclusive,
            interval="1d",
        )
    else:
        raise RunnerInputError(
            "marketData.requiredFields does not match a supported data profile"
        )
    full_close = snapshot.market_data.get("close")
    if not isinstance(full_close, pd.DataFrame):
        raise RunnerInputError("the strategy requires a close panel")
    evaluation_mask = (
        (full_close.index >= pd.Timestamp(start))
        & (full_close.index < pd.Timestamp(end_exclusive))
    )
    close = full_close.loc[evaluation_mask]
    if close.empty:
        raise RunnerInputError("the data provider returned no bars in the evaluation range")
    pre_evaluation_bars = int((full_close.index < pd.Timestamp(start)).sum())
    if pre_evaluation_bars < warmup_bars:
        raise RunnerInputError(
            f"the data provider returned {pre_evaluation_bars} warmup bars; {warmup_bars} are required"
        )
    if (date.fromisoformat(end_exclusive) - close.index[-1].date()).days > 10:
        raise RunnerInputError("market data does not cover the requested evaluation end")

    generate = _load_generate(strategy_dir)
    generated = generate(
        {
            field: frame.copy(deep=True)
            for field, frame in snapshot.market_data.items()
        },
        dict(parameters),
        {
            "strategyId": args.strategy_id,
            "symbols": list(symbols),
            "start": start,
            "endExclusive": end_exclusive,
            "warmupStart": snapshot.actual_start,
        },
    )
    full_targets = _target_weights(generated, full_close)
    targets = full_targets.loc[evaluation_mask].copy()
    explicit_before_start = full_targets.loc[
        (full_targets.index < pd.Timestamp(start))
        & full_targets.notna().all(axis=1)
    ]
    initial_target_weights = pd.Series(0.0, index=full_close.columns)
    if not explicit_before_start.empty:
        initial_target_weights = explicit_before_start.iloc[-1].copy()

    execution = _mapping(backtest["execution"], "backtest.execution")
    sizing = _mapping(backtest["positionSizing"], "backtest.positionSizing")
    costs = _mapping(backtest.get("costs"), "backtest.costs")
    risk = _mapping(backtest["risk"], "backtest.risk")
    portfolio = simulate_target_weight_portfolio(
        close,
        targets,
        initial_cash=float(backtest["initialCash"]),
        delay_bars=int(execution["delayBars"]),
        proportional_fee_rate=float(costs["proportionalFeeRate"]),
        fixed_fee_per_order=float(costs["fixedFeePerOrder"]),
        slippage_rate=float(costs["slippageRate"]),
        minimum_order_shares=float(sizing["minimumOrderShares"]),
        share_increment=float(sizing["shareIncrement"]),
        stop_loss_rate=risk.get("stopLossRate"),
        take_profit_rate=risk.get("takeProfitRate"),
        initial_target_weights=initial_target_weights,
        frequency="1D",
    )

    if snapshot.benchmark_close is None:
        raise RunnerInputError("benchmark data is unavailable")
    benchmark_portfolio = _benchmark_portfolio(
        snapshot.benchmark_close.reindex(close.index),
        float(backtest["initialCash"]),
    )
    config_hash = execution_identity.config_hash
    code_hash = execution_identity.code_hash
    runner_hash = execution_identity.runner_hash
    run_id = _run_id(
        strategy_id=args.strategy_id,
        strategy_version=str(config["version"]),
        data_hash=snapshot.data_sha256,
        config_hash=config_hash,
        code_hash=code_hash,
        runner_hash=runner_hash,
        parameters=parameters,
        runtime_versions=runtime_versions,
        evaluation_start=start,
        evaluation_end_exclusive=end_exclusive,
    )
    generated_at = datetime.now(timezone.utc)
    provider_warnings: list[str]
    if sec_snapshot is None:
        provider_warnings = [
            "Yahoo adjusted daily data is fetched at run time; the raw market dataset is not bundled.",
            "Yahoo can revise historical adjusted values, so a later refetch may have a different dataset hash.",
        ]
    else:
        coverage_summary = ", ".join(
            f"{symbol}={sec_snapshot.coverage[symbol].complete_event_count}"
            for symbol in symbols
        )
        provider_warnings = [
            *sec_snapshot.warnings,
            f"Complete annual SEC filing events by symbol: {coverage_summary}.",
            f"SEC source payload SHA-256: {sec_snapshot.payload_sha256}.",
            "Yahoo can revise historical adjusted prices or corporate actions, so a later refetch may have a different dataset hash.",
        ]

    context = StrategyArtifactContext(
        strategy_id=args.strategy_id,
        strategy_version=str(config["version"]),
        run_id=run_id,
        generated_at=generated_at,
        provider=snapshot.provider,
        provider_version=snapshot.provider_version,
        symbols=symbols,
        interval=snapshot.interval,
        requested_start=snapshot.requested_start,
        requested_end_exclusive=snapshot.requested_end_exclusive,
        evaluation_start=start,
        evaluation_end_exclusive=end_exclusive,
        data_start=snapshot.actual_start,
        data_end=snapshot.actual_end,
        adjustment=snapshot.adjustment,
        timezone="America/New_York",
        data_hash=snapshot.data_sha256,
        config_hash=config_hash,
        code_hash=code_hash,
        runner_hash=runner_hash,
        effective_parameters=parameters,
        runtime_versions=runtime_versions,
        benchmark=BenchmarkArtifactContext(
            symbol=benchmark_symbol,
            portfolio=benchmark_portfolio,
            return_type=str(benchmark_config.get("returnType", "price")),
            costs_applied=bool(benchmark_config.get("costsApplied", False)),
            data_hash=snapshot.benchmark_sha256,
        ),
        warnings=(
            "This trial uses a fixed current-symbol universe and may contain survivorship and selection bias.",
            *provider_warnings,
            f"{pre_evaluation_bars} bars were used only for indicator warmup and excluded from performance.",
            "The evaluation starts as a new cash portfolio using the latest pre-start target; pre-start holdings and stop state are not carried forward.",
            "No out-of-sample interval is designated, so forwardReturn is null.",
            "Stops trigger on the close and fill at the next bar close, so gaps can exceed the configured threshold.",
            "Strategy prices are dividend-adjusted while ^GSPC is a price index, so return bases are not identical.",
        ),
    )
    artifacts = build_strategy_artifacts(portfolio, context)
    artifact_map = artifacts.as_dict()
    _assert_execution_identity_unchanged(strategy_dir, execution_identity)
    if args.write:
        _write_artifacts(strategy_dir, artifact_map)

    summary = {
        "strategyId": args.strategy_id,
        "runId": run_id,
        "written": bool(args.write),
        "equityPointCount": len(artifacts.equity["points"]),
        "data": artifacts.run["data"],
        "metrics": artifacts.performance["metrics"],
        "execution": artifacts.run["execution"],
        "benchmark": artifacts.run["benchmark"],
    }
    return summary


def main() -> None:
    try:
        summary = run()
    except (RunnerInputError, ImportError, KeyError, OSError, TypeError, ValueError, RuntimeError) as error:
        raise SystemExit(f"strategy backtest failed: {error}") from error
    print(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
