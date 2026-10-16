"""Build conservative point-in-time annual SEC fundamental panels.

Only facts from a complete 10-K accession are used.  A filing becomes visible
on the first trading session after its SEC ``filed`` date, which is deliberately
more conservative than guessing whether an unknown acceptance time preceded
that day's market close.  Amendments therefore change future rows only.

Yahoo adjusted close remains the execution/valuation price.  Market
capitalization is built separately from Yahoo's non-dividend-adjusted Close and
SEC diluted shares normalized for later stock splits, so value factors do not
mix incompatible price and share bases.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
import gzip
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time
from typing import Any, Mapping, Sequence
import urllib.error
import urllib.request

import numpy as np
import pandas as pd
import yfinance as yf

from .data import (
    MarketSnapshot,
    frame_data_hash,
    snapshot_data_hash,
)


SEC_PANEL_FIELDS = (
    "market_cap",
    "net_income_latest_annual",
    "operating_cash_flow_latest_annual",
    "total_equity",
    "total_assets",
    "fundamental_age_days",
    "fundamentals_available",
)

SEC_REQUIRED_FIELDS = ("close", "screening_close", "volume", *SEC_PANEL_FIELDS)

_FACT_FIELDS = (
    "shares_outstanding",
    "net_income_latest_annual",
    "operating_cash_flow_latest_annual",
    "total_equity",
    "total_assets",
)
_FACT_PANEL_FIELDS = (
    *_FACT_FIELDS,
    "fundamental_age_days",
    "fundamentals_available",
)
_ANNUAL_FORMS = frozenset({"10-K", "10-K/A"})
_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9.-]{0,14}$")
_CIK = re.compile(r"^\d{1,10}$")
_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
_DEFAULT_USER_AGENT = "Trader/1.0 local strategy research"
_TICKER_URL = "https://www.sec.gov/files/company_tickers.json"
_COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"

# Reviewed issuer identities for the bundled sample universe.  Keeping these
# stable avoids silently following a ticker to a newly reorganized registrant.
REVIEWED_CIK_BY_SYMBOL = {
    "AAPL": "0000320193",
    "AMZN": "0001018724",
    "CAT": "0000018230",
    "COST": "0000909832",
    "CVX": "0000093410",
    "GOOGL": "0001652044",
    "HD": "0000354950",
    "JNJ": "0000200406",
    "KO": "0000021344",
    "META": "0001326801",
    "MSFT": "0000789019",
    "NVDA": "0001045810",
    "PEP": "0000077476",
    "PG": "0000080424",
    "WMT": "0000104169",
}

_CONCEPTS = {
    "net_income_latest_annual": (
        ("us-gaap", "NetIncomeLoss"),
        ("us-gaap", "ProfitLoss"),
        ("us-gaap", "NetIncomeLossAvailableToCommonStockholdersBasic"),
    ),
    "operating_cash_flow_latest_annual": (
        ("us-gaap", "NetCashProvidedByUsedInOperatingActivities"),
        (
            "us-gaap",
            "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
        ),
    ),
    "total_equity": (
        ("us-gaap", "StockholdersEquity"),
        (
            "us-gaap",
            "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        ),
    ),
    "total_assets": (("us-gaap", "Assets"),),
    # A single combined diluted share basis is preferable for multi-class
    # issuers.  Cover-page shares remain the final fallback.
    "shares_outstanding": (
        ("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding"),
        ("us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic"),
        ("dei", "EntityCommonStockSharesOutstanding"),
        ("us-gaap", "CommonStockSharesOutstanding"),
    ),
}

_EXPECTED_UNITS = {
    "net_income_latest_annual": ("USD",),
    "operating_cash_flow_latest_annual": ("USD",),
    "total_equity": ("USD",),
    "total_assets": ("USD",),
    "shares_outstanding": ("shares",),
}


@dataclass(frozen=True)
class SecSymbolCoverage:
    cik: str
    complete_event_count: int
    available_row_count: int
    first_effective_date: str | None
    latest_source_filing_date: str | None
    source_accessions_sha256: str
    concepts: Mapping[str, str | None]


@dataclass(frozen=True)
class SecCompanyFactsSnapshot:
    panels: Mapping[str, pd.DataFrame]
    provider: str
    provider_version: str
    data_sha256: str
    payload_sha256: str
    coverage: Mapping[str, SecSymbolCoverage]
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class _Fact:
    start: date | None
    end: date
    filed: date
    form: str
    accn: str
    value: float
    frame: str | None

    @property
    def duration_days(self) -> int | None:
        return None if self.start is None else (self.end - self.start).days


@dataclass(frozen=True)
class _AnnualEvent:
    filed: date
    accession: str
    values: Mapping[str, float]


def _normalized_symbols(symbols: Sequence[str]) -> tuple[str, ...]:
    normalized = tuple(symbol.strip().upper() for symbol in symbols)
    if len(normalized) < 2:
        raise ValueError("at least two symbols are required")
    if len(set(normalized)) != len(normalized) or any(
        not _SYMBOL.fullmatch(symbol) for symbol in normalized
    ):
        raise ValueError("symbols must be unique supported uppercase identifiers")
    return normalized


def _normalized_index(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    if not isinstance(index, pd.DatetimeIndex):
        raise TypeError("index must be a pandas DatetimeIndex")
    normalized = pd.DatetimeIndex(index)
    if normalized.tz is not None:
        normalized = normalized.tz_convert(None)
    normalized = normalized.normalize()
    if normalized.empty or normalized.has_duplicates or not normalized.is_monotonic_increasing:
        raise ValueError("trading index must be non-empty, unique, and increasing")
    return normalized


def _parse_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if value == parsed.isoformat() else None


def _safe_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    return parsed if math.isfinite(parsed) else None


def _rows_for_concept(
    payload: Mapping[str, Any],
    namespace: str,
    concept: str,
    expected_units: Sequence[str],
) -> list[_Fact]:
    facts = payload.get("facts")
    namespace_facts = facts.get(namespace) if isinstance(facts, Mapping) else None
    raw_concept = (
        namespace_facts.get(concept) if isinstance(namespace_facts, Mapping) else None
    )
    units = raw_concept.get("units") if isinstance(raw_concept, Mapping) else None
    if not isinstance(units, Mapping):
        return []

    raw_rows: Any = None
    for unit in expected_units:
        if isinstance(units.get(unit), list):
            raw_rows = units[unit]
            break
    if not isinstance(raw_rows, list):
        return []

    parsed: list[_Fact] = []
    for row in raw_rows:
        if not isinstance(row, Mapping):
            continue
        form = row.get("form")
        accn = row.get("accn")
        end = _parse_date(row.get("end"))
        filed = _parse_date(row.get("filed"))
        value = _safe_float(row.get("val"))
        start = _parse_date(row.get("start"))
        if (
            form not in _ANNUAL_FORMS
            or not isinstance(accn, str)
            or not accn
            or end is None
            or filed is None
            or value is None
            or end > filed
        ):
            continue
        frame = row.get("frame")
        parsed.append(
            _Fact(
                start=start,
                end=end,
                filed=filed,
                form=form,
                accn=accn,
                value=value,
                frame=frame if isinstance(frame, str) else None,
            )
        )
    return parsed


def _facts_by_accession(
    payload: Mapping[str, Any], field: str
) -> tuple[dict[str, list[_Fact]], dict[str, str]]:
    selected: dict[str, list[_Fact]] = {}
    concepts: dict[str, str] = {}
    for namespace, concept in _CONCEPTS[field]:
        grouped: dict[str, list[_Fact]] = {}
        for fact in _rows_for_concept(
            payload, namespace, concept, _EXPECTED_UNITS[field]
        ):
            grouped.setdefault(fact.accn, []).append(fact)
        for accession, rows in grouped.items():
            if accession not in selected:
                selected[accession] = rows
                concepts[accession] = f"{namespace}:{concept}"
    return selected, concepts


def _unambiguous_fact(candidates: Sequence[_Fact], score) -> _Fact | None:
    if not candidates:
        return None
    scores = [score(candidate) for candidate in candidates]
    best_score = min(scores)
    best = [
        candidate
        for candidate, candidate_score in zip(candidates, scores)
        if candidate_score == best_score
    ]
    values = {candidate.value for candidate in best}
    if len(values) == 1:
        return sorted(
            best,
            key=lambda candidate: (
                0 if candidate.frame else 1,
                candidate.start or date.min,
                candidate.end,
                candidate.accn,
            ),
        )[0]
    framed = [candidate for candidate in best if candidate.frame]
    framed_values = {candidate.value for candidate in framed}
    if len(framed_values) != 1:
        return None
    return sorted(
        framed,
        key=lambda candidate: (
            candidate.start or date.min,
            candidate.end,
            candidate.accn,
        ),
    )[0]


def _annual_flow_fact(rows: Sequence[_Fact]) -> _Fact | None:
    candidates = [
        row
        for row in rows
        if row.duration_days is not None and 270 <= row.duration_days <= 430
    ]
    if not candidates:
        return None
    latest_end = max(row.end for row in candidates)
    current = [row for row in candidates if row.end == latest_end]
    return _unambiguous_fact(
        current,
        lambda row: (abs((row.duration_days or 365) - 365), row.start or date.min),
    )


def _instant_fact(rows: Sequence[_Fact]) -> _Fact | None:
    candidates = [row for row in rows if row.start is None]
    if not candidates:
        return None
    latest_end = max(row.end for row in candidates)
    return _unambiguous_fact(
        [row for row in candidates if row.end == latest_end],
        lambda row: (0 if row.frame else 1,),
    )


def _share_fact(rows: Sequence[_Fact]) -> _Fact | None:
    return _annual_flow_fact(rows) or _instant_fact(rows)


def _annual_events(
    payload: Mapping[str, Any], last_trading_date: date
) -> tuple[list[_AnnualEvent], Mapping[str, str | None]]:
    groups: dict[str, dict[str, list[_Fact]]] = {}
    concept_by_accession: dict[str, dict[str, str]] = {}
    for field in _FACT_FIELDS:
        groups[field], concept_by_accession[field] = _facts_by_accession(payload, field)

    accessions = sorted(set().union(*(set(group) for group in groups.values())))
    events: list[_AnnualEvent] = []
    used_concepts: dict[str, Counter[str]] = {
        field: Counter() for field in _FACT_FIELDS
    }
    for accession in accessions:
        rows = [
            row
            for field in _FACT_FIELDS
            for row in groups[field].get(accession, [])
        ]
        filed_dates = {row.filed for row in rows}
        if len(filed_dates) != 1:
            continue
        filed = next(iter(filed_dates))
        if filed >= last_trading_date:
            continue

        selected_facts: dict[str, _Fact] = {}
        for field in _FACT_FIELDS:
            field_rows = groups[field].get(accession, [])
            if field in {
                "net_income_latest_annual",
                "operating_cash_flow_latest_annual",
            }:
                selected = _annual_flow_fact(field_rows)
            elif field == "shares_outstanding":
                selected = _share_fact(field_rows)
            else:
                selected = _instant_fact(field_rows)
            if selected is None:
                break
            selected_facts[field] = selected
        if len(selected_facts) != len(_FACT_FIELDS):
            continue
        statement_period_ends = {
            selected_facts[field].end
            for field in (
                "net_income_latest_annual",
                "operating_cash_flow_latest_annual",
                "total_equity",
                "total_assets",
            )
        }
        if len(statement_period_ends) != 1:
            continue
        values = {
            field: selected.value for field, selected in selected_facts.items()
        }
        if not all(math.isfinite(value) for value in values.values()):
            continue
        events.append(_AnnualEvent(filed=filed, accession=accession, values=values))
        for field in _FACT_FIELDS:
            concept = concept_by_accession[field].get(accession)
            if concept:
                used_concepts[field][concept] += 1

    events.sort(key=lambda event: (event.filed, event.accession))
    concepts = {
        field: (
            None
            if not counts
            else sorted(counts, key=lambda item: (-counts[item], item))[0]
        )
        for field, counts in used_concepts.items()
    }
    return events, concepts


def _empty_fact_panels(
    index: pd.DatetimeIndex, symbols: Sequence[str]
) -> dict[str, pd.DataFrame]:
    return {
        field: pd.DataFrame(np.nan, index=index, columns=symbols, dtype="float64")
        for field in _FACT_PANEL_FIELDS
    }


def build_sec_companyfacts_panels(
    *,
    companyfacts_by_symbol: Mapping[str, Mapping[str, Any]],
    index: pd.DatetimeIndex,
    symbols: Sequence[str] | None = None,
    ciks: Mapping[str, str] | None = None,
) -> tuple[Mapping[str, pd.DataFrame], Mapping[str, SecSymbolCoverage]]:
    """Build annual fact panels from injected SEC payloads without I/O."""

    requested = _normalized_symbols(
        tuple(companyfacts_by_symbol) if symbols is None else symbols
    )
    trading_index = _normalized_index(index)
    if set(requested) != set(companyfacts_by_symbol):
        raise ValueError("companyfacts payloads must exactly match requested symbols")

    panels = _empty_fact_panels(trading_index, requested)
    coverage: dict[str, SecSymbolCoverage] = {}
    for symbol in requested:
        payload = companyfacts_by_symbol[symbol]
        if not isinstance(payload, Mapping):
            raise TypeError(f"SEC payload for {symbol} must be an object")
        raw_cik = str(payload.get("cik", "")) if ciks is None else str(ciks.get(symbol, ""))
        if not _CIK.fullmatch(raw_cik):
            raise ValueError(f"SEC payload for {symbol} has no valid CIK")
        cik = raw_cik.zfill(10)
        events, concepts = _annual_events(payload, trading_index[-1].date())
        first_effective: str | None = None
        latest_source: str | None = None
        applied_accessions: list[str] = []
        for event in events:
            position = int(
                trading_index.searchsorted(pd.Timestamp(event.filed), side="right")
            )
            if position >= len(trading_index):
                continue
            if first_effective is None:
                first_effective = trading_index[position].date().isoformat()
            latest_source = event.filed.isoformat()
            applied_accessions.append(event.accession)
            row_slice = slice(position, None)
            column = panels["fundamentals_available"].columns.get_loc(symbol)
            for field, value in event.values.items():
                panels[field].iloc[row_slice, column] = value
            panels["fundamental_age_days"].iloc[row_slice, column] = (
                trading_index[position:] - pd.Timestamp(event.filed)
            ).days.astype("float64")
            panels["fundamentals_available"].iloc[row_slice, column] = 1.0

        panels["fundamentals_available"][symbol] = panels[
            "fundamentals_available"
        ][symbol].fillna(0.0)
        accession_digest = sha256()
        for accession in applied_accessions:
            accession_digest.update(accession.encode("ascii"))
            accession_digest.update(b"\0")
        coverage[symbol] = SecSymbolCoverage(
            cik=cik,
            complete_event_count=len(applied_accessions),
            available_row_count=int(panels["fundamentals_available"][symbol].sum()),
            first_effective_date=first_effective,
            latest_source_filing_date=latest_source,
            source_accessions_sha256=accession_digest.hexdigest(),
            concepts=dict(sorted(concepts.items())),
        )
    return panels, coverage


class _SecClient:
    def __init__(
        self,
        *,
        user_agent: str,
        cache_dir: Path,
        cache_max_age_seconds: int,
        timeout_seconds: float,
        requests_per_second: float,
    ) -> None:
        normalized_agent = user_agent.strip()
        if not normalized_agent or len(normalized_agent) > 256:
            raise ValueError("SEC user agent must contain 1-256 characters")
        if not 0 < requests_per_second <= 10:
            raise ValueError("SEC requests_per_second must be in (0, 10]")
        self.user_agent = normalized_agent
        self.cache_dir = cache_dir
        self.cache_max_age_seconds = cache_max_age_seconds
        self.timeout_seconds = timeout_seconds
        self.minimum_interval = 1.0 / requests_per_second
        self.last_request_at: float | None = None

    def _throttle(self) -> None:
        if self.last_request_at is None:
            return
        delay = self.minimum_interval - (time.monotonic() - self.last_request_at)
        if delay > 0:
            time.sleep(delay)

    def get_json(self, url: str, cache_name: str) -> tuple[Mapping[str, Any], bytes]:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = self.cache_dir / cache_name
        try:
            age = time.time() - cache_path.stat().st_mtime
            if 0 <= age <= self.cache_max_age_seconds:
                raw = cache_path.read_bytes()
                parsed = json.loads(raw)
                if isinstance(parsed, Mapping):
                    return parsed, raw
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
            pass

        last_error: Exception | None = None
        for attempt in range(3):
            self._throttle()
            request = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip",
                    "User-Agent": self.user_agent,
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                    encoded = response.read(_MAX_RESPONSE_BYTES + 1)
                    self.last_request_at = time.monotonic()
                    raw = gzip.decompress(encoded) if response.headers.get("Content-Encoding") == "gzip" else encoded
                if len(raw) > _MAX_RESPONSE_BYTES:
                    raise RuntimeError("SEC response exceeds the supported size")
                parsed = json.loads(raw)
                if not isinstance(parsed, Mapping):
                    raise RuntimeError("SEC returned a non-object JSON payload")
                break
            except (
                OSError,
                UnicodeError,
                ValueError,
                urllib.error.HTTPError,
                urllib.error.URLError,
            ) as error:
                self.last_request_at = time.monotonic()
                last_error = error
                if attempt == 2:
                    raise RuntimeError(f"SEC request failed: {url}") from error
                time.sleep(0.5 * (2**attempt))
        else:  # pragma: no cover - loop either breaks or raises
            raise RuntimeError(f"SEC request failed: {url}") from last_error

        temporary = cache_path.with_name(
            f".{cache_path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp"
        )
        try:
            temporary.write_bytes(raw)
            os.replace(temporary, cache_path)
        finally:
            temporary.unlink(missing_ok=True)
        return parsed, raw


def _resolved_ciks(
    client: _SecClient,
    symbols: Sequence[str],
    supplied: Mapping[str, str] | None,
) -> tuple[dict[str, str], bytes]:
    if supplied is not None:
        if set(supplied) != set(symbols):
            raise ValueError("supplied CIKs must exactly match requested symbols")
        resolved = {}
        for symbol in symbols:
            cik = str(supplied[symbol])
            if not _CIK.fullmatch(cik):
                raise ValueError(f"invalid CIK for {symbol}")
            resolved[symbol] = cik.zfill(10)
        return resolved, json.dumps(
            resolved, sort_keys=True, separators=(",", ":")
        ).encode()

    resolved = {
        symbol: REVIEWED_CIK_BY_SYMBOL[symbol]
        for symbol in symbols
        if symbol in REVIEWED_CIK_BY_SYMBOL
    }
    unresolved = [symbol for symbol in symbols if symbol not in resolved]
    lookup: dict[str, str] = {}
    if unresolved:
        ticker_payload, _ = client.get_json(_TICKER_URL, "company_tickers.json")
        for item in ticker_payload.values():
            if not isinstance(item, Mapping):
                continue
            ticker = item.get("ticker")
            cik = item.get("cik_str")
            if isinstance(ticker, str) and isinstance(cik, int):
                lookup[ticker.upper()] = str(cik).zfill(10)
    for symbol in unresolved:
        cik = next(
            (
                lookup[candidate]
                for candidate in (symbol, symbol.replace(".", "-"))
                if candidate in lookup
            ),
            None,
        )
        if cik is None:
            raise ValueError(f"SEC ticker map has no CIK for {symbol}")
        resolved[symbol] = cik
    return resolved, json.dumps(
        resolved, sort_keys=True, separators=(",", ":")
    ).encode()


def _fetch_sec_facts(
    *,
    symbols: Sequence[str],
    index: pd.DatetimeIndex,
    user_agent: str | None,
    ciks: Mapping[str, str] | None,
    cache_dir: str | Path | None,
) -> tuple[Mapping[str, pd.DataFrame], Mapping[str, SecSymbolCoverage], str]:
    resolved_cache = (
        Path(tempfile.gettempdir()) / "trader-sec-companyfacts-annual-v1"
        if cache_dir is None
        else Path(cache_dir)
    )
    client = _SecClient(
        user_agent=user_agent or os.environ.get("SEC_USER_AGENT") or _DEFAULT_USER_AGENT,
        cache_dir=resolved_cache,
        cache_max_age_seconds=86_400,
        timeout_seconds=45.0,
        requests_per_second=2.0,
    )
    resolved_ciks, cik_identity = _resolved_ciks(client, symbols, ciks)
    payloads: dict[str, Mapping[str, Any]] = {}
    payload_digest = sha256(b"trader.sec-companyfacts-annual-payload.v1\0")
    payload_digest.update(cik_identity)
    for symbol in symbols:
        cik = resolved_ciks[symbol]
        payload, raw = client.get_json(
            _COMPANYFACTS_URL.format(cik=cik), f"CIK{cik}.json"
        )
        payloads[symbol] = payload
        payload_digest.update(symbol.encode("ascii"))
        payload_digest.update(b"\0")
        payload_digest.update(raw)
    panels, coverage = build_sec_companyfacts_panels(
        companyfacts_by_symbol=payloads,
        index=index,
        symbols=symbols,
        ciks=resolved_ciks,
    )
    return panels, coverage, payload_digest.hexdigest()


def _price_panels(
    *,
    symbols: Sequence[str],
    benchmark_symbol: str,
    start: str,
    end_exclusive: str,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.Series]:
    tickers = list(symbols)
    if benchmark_symbol not in tickers:
        tickers.append(benchmark_symbol)
    action_end = max(date.fromisoformat(end_exclusive), date.today() + timedelta(days=2))
    raw = yf.download(
        tickers,
        start=start,
        end=action_end.isoformat(),
        interval="1d",
        auto_adjust=False,
        actions=True,
        repair=True,
        group_by="column",
        progress=False,
        threads=True,
    )
    if raw.empty or not isinstance(raw.columns, pd.MultiIndex):
        raise RuntimeError("Yahoo returned no usable multi-symbol data")
    for field in ("Adj Close", "Close", "Volume", "Stock Splits"):
        if field not in raw.columns.get_level_values(0):
            raise RuntimeError(f"Yahoo response is missing {field}")

    raw.index = _normalized_index(pd.DatetimeIndex(raw.index))
    requested_mask = (
        (raw.index >= pd.Timestamp(start))
        & (raw.index < pd.Timestamp(end_exclusive))
    )
    requested = raw.loc[requested_mask]
    adjusted_close = requested["Adj Close"].reindex(columns=symbols).astype("float64")
    unadjusted_close = requested["Close"].reindex(columns=symbols).astype("float64")
    volume = requested["Volume"].reindex(columns=symbols).astype("float64")
    for name, frame in (
        ("adjusted close", adjusted_close),
        ("unadjusted close", unadjusted_close),
        ("volume", volume),
    ):
        if frame.empty or not np.isfinite(frame.to_numpy(dtype=float, copy=False)).all():
            raise RuntimeError(f"Yahoo {name} panel is incomplete")
    splits = raw["Stock Splits"].reindex(columns=symbols).astype("float64").fillna(0.0)
    split_values = splits.to_numpy(dtype=float, copy=False)
    if not np.isfinite(split_values).all() or (split_values < 0.0).any():
        raise RuntimeError("Yahoo stock-split panel is invalid")
    benchmark_close = requested["Adj Close"][benchmark_symbol].astype("float64")
    benchmark_close = benchmark_close.reindex(adjusted_close.index)
    if not np.isfinite(benchmark_close.to_numpy(dtype=float, copy=False)).all():
        raise RuntimeError("Yahoo benchmark does not cover the strategy calendar")
    return adjusted_close, unadjusted_close, volume, splits, benchmark_close


def _market_cap_panel(
    *,
    raw_close: pd.DataFrame,
    shares: pd.DataFrame,
    fundamental_age_days: pd.DataFrame,
    splits: pd.DataFrame,
) -> pd.DataFrame:
    result = pd.DataFrame(
        np.nan, index=raw_close.index, columns=raw_close.columns, dtype="float64"
    )
    for symbol in raw_close.columns:
        split_series = splits[symbol]
        split_series = split_series[split_series > 0.0]
        share_values = shares[symbol]
        ages = fundamental_age_days[symbol]
        available = share_values.notna() & ages.notna()
        for timestamp in raw_close.index[available]:
            age = float(ages.loc[timestamp])
            if age < 0.0 or not age.is_integer():
                raise RuntimeError("SEC fundamental age must be a non-negative whole day")
            filed_date = timestamp.date() - timedelta(days=int(age))
            later_splits = split_series[split_series.index.date > filed_date]
            factor = float(later_splits.prod()) if not later_splits.empty else 1.0
            if not math.isfinite(factor) or factor <= 0.0:
                raise RuntimeError("Yahoo stock-split normalization factor is invalid")
            result.loc[timestamp, symbol] = (
                float(raw_close.loc[timestamp, symbol])
                * float(share_values.loc[timestamp])
                * factor
            )
    return result


def _historical_share_basis_panels(
    *,
    raw_close: pd.DataFrame,
    normalized_volume: pd.DataFrame,
    splits: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Restore each bar's contemporaneous pre-split price/share units.

    Yahoo's historical Close and Volume use today's split-adjusted share basis.
    That pair preserves dollar volume, but applying a nominal price screen to
    Close alone would make an old decision depend on later splits.  Multiplying
    price and dividing volume by all splits strictly after the bar restores the
    trading unit used on that date while preserving dollar volume exactly.
    """

    historical_close = raw_close.copy()
    historical_volume = normalized_volume.copy()
    for symbol in raw_close.columns:
        split_series = splits[symbol]
        split_series = split_series[split_series > 0.0]
        for timestamp in raw_close.index:
            later_splits = split_series[split_series.index > timestamp]
            factor = float(later_splits.prod()) if not later_splits.empty else 1.0
            if not math.isfinite(factor) or factor <= 0.0:
                raise RuntimeError("Yahoo stock-split normalization factor is invalid")
            historical_close.loc[timestamp, symbol] = (
                float(raw_close.loc[timestamp, symbol]) * factor
            )
            historical_volume.loc[timestamp, symbol] = (
                float(normalized_volume.loc[timestamp, symbol]) / factor
            )
    for name, frame in (
        ("historical close", historical_close),
        ("historical volume", historical_volume),
    ):
        values = frame.to_numpy(dtype=float, copy=False)
        if not np.isfinite(values).all() or (values < 0.0).any():
            raise RuntimeError(f"Yahoo {name} panel is invalid")
    if (historical_close.to_numpy(dtype=float, copy=False) <= 0.0).any():
        raise RuntimeError("Yahoo historical close panel must be positive")
    return historical_close, historical_volume


def fetch_sec_fundamental_snapshot(
    *,
    symbols: Sequence[str],
    required_fields: Sequence[str],
    benchmark_symbol: str,
    start: str,
    end_exclusive: str,
    interval: str = "1d",
    user_agent: str | None = None,
    ciks: Mapping[str, str] | None = None,
    cache_dir: str | Path | None = None,
) -> tuple[MarketSnapshot, SecCompanyFactsSnapshot]:
    """Fetch Yahoo price bases plus annual SEC facts as one hashed snapshot."""

    if interval != "1d":
        raise ValueError("SEC fundamental snapshots support daily bars only")
    requested_symbols = _normalized_symbols(symbols)
    normalized_fields = tuple(
        dict.fromkeys(field.strip().lower() for field in required_fields)
    )
    unsupported = sorted(set(normalized_fields) - set(SEC_REQUIRED_FIELDS))
    if unsupported or "close" not in normalized_fields:
        raise ValueError(
            "unsupported SEC fundamental fields: " + ", ".join(unsupported)
            if unsupported
            else "SEC fundamental snapshots require close"
        )

    adjusted_close, raw_close, normalized_volume, splits, benchmark_close = _price_panels(
        symbols=requested_symbols,
        benchmark_symbol=benchmark_symbol,
        start=start,
        end_exclusive=end_exclusive,
    )
    fact_panels, coverage, payload_hash = _fetch_sec_facts(
        symbols=requested_symbols,
        index=adjusted_close.index,
        user_agent=user_agent,
        ciks=ciks,
        cache_dir=cache_dir,
    )
    market_cap = _market_cap_panel(
        raw_close=raw_close,
        shares=fact_panels["shares_outstanding"],
        fundamental_age_days=fact_panels["fundamental_age_days"],
        splits=splits,
    )
    screening_close, historical_volume = _historical_share_basis_panels(
        raw_close=raw_close,
        normalized_volume=normalized_volume,
        splits=splits,
    )
    sec_panels = {
        "market_cap": market_cap,
        "net_income_latest_annual": fact_panels["net_income_latest_annual"],
        "operating_cash_flow_latest_annual": fact_panels[
            "operating_cash_flow_latest_annual"
        ],
        "total_equity": fact_panels["total_equity"],
        "total_assets": fact_panels["total_assets"],
        "fundamental_age_days": fact_panels["fundamental_age_days"],
        "fundamentals_available": fact_panels["fundamentals_available"],
    }
    supplied = {
        "close": adjusted_close,
        "screening_close": screening_close,
        "volume": historical_volume,
        **sec_panels,
    }
    market_data = {field: supplied[field] for field in normalized_fields}
    unavailable = [
        symbol for symbol, item in coverage.items() if item.available_row_count == 0
    ]
    warnings = [
        "SEC fundamentals use complete annual 10-K accessions and become available on the next trading session after filing.",
        "Latest annual flow facts remain in force until the next complete 10-K and are not quarterly-updated TTM values; amendments apply prospectively and never backfill prior rows.",
        "Price and volume screens use Yahoo's contemporaneous historical share basis; later splits change units without changing dollar volume.",
        "Screening market capitalization is a proxy built from Yahoo split-adjusted raw Close and SEC diluted weighted-average shares normalized to the same share basis; it can differ from period-end equity market capitalization.",
        "Raw SEC and Yahoo responses are fetched at run time and are not bundled; the normalized input panels are content-hashed.",
    ]
    if unavailable:
        warnings.append(
            "No complete annual SEC snapshot was available for: "
            + ", ".join(unavailable)
            + "."
        )
    sec_snapshot = SecCompanyFactsSnapshot(
        panels=sec_panels,
        provider="sec-edgar-companyfacts",
        provider_version="annual-10k-next-session-v1",
        data_sha256=snapshot_data_hash(sec_panels, None),
        payload_sha256=payload_hash,
        coverage=coverage,
        warnings=tuple(warnings),
    )
    snapshot = MarketSnapshot(
        market_data=market_data,
        benchmark_close=benchmark_close,
        provider="yfinance+sec-edgar-companyfacts",
        provider_version=f"yfinance={yf.__version__};sec=annual-10k-v1",
        interval=interval,
        adjustment="Adj Close execution; historical share-basis screens; SEC diluted-share market-cap proxy",
        requested_start=start,
        requested_end_exclusive=end_exclusive,
        actual_start=adjusted_close.index[0].strftime("%Y-%m-%d"),
        actual_end=adjusted_close.index[-1].strftime("%Y-%m-%d"),
        data_sha256=snapshot_data_hash(market_data, benchmark_close),
        benchmark_sha256=frame_data_hash(benchmark_close.to_frame("benchmark")),
    )
    return snapshot, sec_snapshot


__all__ = [
    "SEC_PANEL_FIELDS",
    "SEC_REQUIRED_FIELDS",
    "REVIEWED_CIK_BY_SYMBOL",
    "SecCompanyFactsSnapshot",
    "SecSymbolCoverage",
    "build_sec_companyfacts_panels",
    "fetch_sec_fundamental_snapshot",
]
