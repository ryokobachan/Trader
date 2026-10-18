#!/usr/bin/env python3
"""Authenticated local bridge for Market data provider bars and yfinance company data.

This process is deliberately separate from the Vinext/Cloudflare runtime:
Cloudflare Workers cannot import CPython packages.  Trader talks to this
sidecar through a small, versioned HTTP contract and can replace it with a
licensed market-data service without changing the browser UI.

The upstream package has no request timeout.  Each websocket fetch therefore
runs in an isolated child process which is terminated when the configured
deadline is reached.
"""

from __future__ import annotations

import argparse
import hmac
import importlib.util
import json
import math
import multiprocessing
import os
import queue
import random
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfo



SCHEMA_VERSION = "trader.tradingview-sidecar.v1"
YAHOO_SCHEMA_VERSION = "trader.yahoo-sidecar.v1"
MIN_CANDLE_COUNT = 2
MAX_CANDLE_COUNT = 10_000
MAX_LATEST_CLOSE_SYMBOLS = 50
MAX_LATEST_CLOSE_BODY_BYTES = 8_192
REALTIME_SCHEMA_VERSION = "trader.tradingview-realtime-quotes.v1"
MAX_REALTIME_SYMBOLS = 50
MAX_REALTIME_BODY_BYTES = 16_384
MAX_REALTIME_SUBSCRIBERS = 32
MAX_REALTIME_SUBSCRIBERS_PER_OWNER = 16
MAX_REALTIME_STREAM_SUBSCRIBERS = 16
MAX_REALTIME_SNAPSHOT_SUBSCRIBERS = 16
MAX_HTTP_REQUEST_THREADS = 64
REALTIME_SUBSCRIBER_QUEUE_SIZE = 512
REALTIME_KEEPALIVE_SECONDS = 15.0
# Local development runtimes do not always propagate a browser EventSource
# disconnect to an in-flight Worker response. Rotate the upstream stream so an
# abandoned response cannot occupy a broker slot for the previous one-hour
# lifetime. EventSource reconnects automatically after this bounded rotation.
REALTIME_STREAM_TTL_SECONDS = 60.0
REALTIME_RECONNECT_MAX_SECONDS = 30.0
REALTIME_UPSTREAM_LIVENESS_SECONDS = 45.0
REALTIME_ACTIVE_STALE_SECONDS = 5.0 * 60.0
REALTIME_FUTURE_SKEW_SECONDS = 60.0
REALTIME_QUOTE_FIELDS = (
    "lp",
    "lp_time",
    "ch",
    "chp",
    "current_session",
    "currency_code",
    "volume",
    "open_price",
    "high_price",
    "low_price",
    "prev_close_price",
    "update_mode",
    "exchange",
    "pro_name",
)
MAX_YAHOO_EARNINGS = 100
YAHOO_PROFILE_CACHE_SECONDS = 15 * 60
YAHOO_EARNINGS_CACHE_SECONDS = 5 * 60
SYMBOL_PATTERN = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")
SYNTHETIC_EXCHANGE_PATTERN = re.compile(r"^[A-Z][A-Z0-9._-]{0,14}$")
ALLOWED_EXCHANGES = frozenset({"NASDAQ", "NYSE", "AMEX", "CBOE"})
MIC_TO_TRADINGVIEW_EXCHANGE = {
    "XNAS": "NASDAQ",
    "XNYS": "NYSE",
    "XASE": "AMEX",
    "ARCX": "AMEX",
    "BATS": "CBOE",
}
DEFAULT_LATEST_CLOSE_EXCHANGES = ("BINANCE", "BITGET", "KUCOIN", "MEXC")
MAX_LATEST_CLOSE_EXCHANGES = 8
MAX_REALTIME_SOURCES = MAX_REALTIME_SYMBOLS * (MAX_LATEST_CLOSE_EXCHANGES + 1)
INTERVAL_TO_TRADINGVIEW = {
    "1m": "1",
    "5m": "5",
    "15m": "15",
    "1h": "1H",
    "4h": "4H",
    "1d": "1D",
    "1wk": "1W",
    "1mo": "1M",
}
ALLOWED_RANGES = frozenset({"1d", "5d", "1mo", "3mo", "6mo", "1y", "5y"})


class YahooInFlight:
    """One sanitized sidecar result shared by concurrent requests for one key."""

    def __init__(self) -> None:
        self.event = threading.Event()
        self.payload: dict[str, Any] | None = None
        self.failed = False


def configured_latest_close_exchanges(value: str | None) -> tuple[str, ...]:
    """Parse the server-owned ordered fallback list for synthetic symbols."""
    if value is None or not value.strip():
        return DEFAULT_LATEST_CLOSE_EXCHANGES
    exchanges = tuple(part.strip().upper() for part in value.split(","))
    if (
        not (1 <= len(exchanges) <= MAX_LATEST_CLOSE_EXCHANGES)
        or any(not SYNTHETIC_EXCHANGE_PATTERN.fullmatch(exchange) for exchange in exchanges)
        or len(set(exchanges)) != len(exchanges)
    ):
        raise ValueError("TRADER_TRADINGVIEW_SYNTHETIC_EXCHANGES is invalid")
    return exchanges


class RealtimeSubscriptionError(Exception):
    """Sanitized client-facing failure for the internal realtime boundary."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class RealtimeSubscriber:
    """One bounded downstream consumer of the process-wide quote broker."""

    def __init__(
        self,
        subscriber_id: int,
        owner: str,
        items: tuple[dict[str, str], ...],
        transient: bool,
    ) -> None:
        self.subscriber_id = subscriber_id
        self.owner = owner
        self.transient = transient
        self.items = items
        self.sources = frozenset(item["sourceSymbol"] for item in items)
        self.events: queue.Queue[dict[str, Any]] = queue.Queue(
            maxsize=REALTIME_SUBSCRIBER_QUEUE_SIZE
        )
        self.closed = threading.Event()


def parse_realtime_items(payload: dict[str, Any] | None) -> tuple[dict[str, str], ...]:
    """Validate symbols and derive Market data provider identifiers from allowlisted MICs."""
    if payload is None or set(payload) != {"items"}:
        raise ValueError("invalid realtime payload")
    raw_items = payload.get("items")
    if (
        not isinstance(raw_items, list)
        or isinstance(raw_items, (str, bytes))
        or not (1 <= len(raw_items) <= MAX_REALTIME_SYMBOLS)
    ):
        raise ValueError("invalid realtime items")

    items: list[dict[str, str]] = []
    seen_symbols: set[str] = set()
    seen_sources: set[str] = set()
    for raw_item in raw_items:
        if not isinstance(raw_item, dict) or set(raw_item) != {"symbol", "mic"}:
            raise ValueError("invalid realtime item")
        raw_symbol = raw_item.get("symbol")
        raw_mic = raw_item.get("mic")
        if not isinstance(raw_symbol, str) or not isinstance(raw_mic, str):
            raise ValueError("invalid realtime item")
        symbol = raw_symbol.strip().upper()
        mic = raw_mic.strip().upper()
        exchange = MIC_TO_TRADINGVIEW_EXCHANGE.get(mic)
        if (
            not SYMBOL_PATTERN.fullmatch(symbol)
            or exchange is None
            or symbol in seen_symbols
        ):
            raise ValueError("invalid realtime item")
        seen_symbols.add(symbol)
        # Yahoo-style US class-share tickers use a hyphen while Market data provider's
        # listing identifiers use a dot (for example BRK-B -> NYSE:BRK.B).
        # This deterministic server-owned alias keeps raw upstream IDs out of
        # the request boundary.
        tradingview_symbol = symbol.replace("-", ".")
        source_symbol = f"{exchange}:{tradingview_symbol}"
        if source_symbol in seen_sources:
            raise ValueError("duplicate realtime source")
        seen_sources.add(source_symbol)
        items.append(
            {
                "symbol": symbol,
                "mic": mic,
                "sourceSymbol": source_symbol,
                "currency": "USD",
                "marketMode": "us_extended",
            }
        )
    return tuple(items)


def synthetic_realtime_items(
    symbols: list[str],
    exchanges: tuple[str, ...],
) -> tuple[dict[str, str], ...]:
    """Derive every server-allowlisted perpetual candidate for ordered fallback."""
    return tuple(
        {
            "symbol": symbol,
            "mic": "",
            "sourceSymbol": f"{exchange}:{symbol}USDT.P",
            "currency": "USDT",
            "marketMode": "continuous",
        }
        for symbol in symbols
        for exchange in exchanges
    )


def parse_latest_close_symbols(payload: dict[str, Any] | None) -> list[str]:
    if payload is None or set(payload) != {"symbols"}:
        raise ValueError("invalid latest-close payload")
    raw_symbols = payload.get("symbols")
    if (
        not isinstance(raw_symbols, list)
        or isinstance(raw_symbols, (str, bytes))
        or not (1 <= len(raw_symbols) <= MAX_LATEST_CLOSE_SYMBOLS)
    ):
        raise ValueError("invalid latest-close symbols")
    symbols: list[str] = []
    seen: set[str] = set()
    for value in raw_symbols:
        if not isinstance(value, str):
            raise ValueError("invalid latest-close symbol")
        symbol = value.strip().upper()
        if not SYMBOL_PATTERN.fullmatch(symbol) or symbol in seen:
            raise ValueError("invalid latest-close symbol")
        seen.add(symbol)
        symbols.append(symbol)
    return symbols


def synthetic_latest_close_item(
    symbol: str,
    exchanges: tuple[str, ...],
    values: dict[str, dict[str, Any]],
    observed_at: datetime | None = None,
) -> dict[str, Any]:
    """Select a fresh ordered source without relabeling USDT as USD."""
    candidates: list[tuple[str, float, str, datetime]] = []
    for exchange in exchanges:
        source_symbol = f"{exchange}:{symbol}USDT.P"
        value = values.get(source_symbol)
        if not isinstance(value, dict):
            continue
        close = finite_number(value.get("price"))
        updated_at = value.get("updatedAt")
        if (
            close is not None
            and close > 0
            and value.get("currency") == "USDT"
            and value.get("stale") is False
            and isinstance(updated_at, str)
            and continuous_reference_is_fresh(updated_at, observed_at)
        ):
            parsed_updated_at = parse_utc_datetime(updated_at)
            if parsed_updated_at is not None:
                candidates.append((source_symbol, close, updated_at, parsed_updated_at))
    if candidates:
        freshest = max(candidate[3] for candidate in candidates)
        selected = next(
            candidate
            for candidate in candidates
            if (freshest - candidate[3]).total_seconds() < REALTIME_ACTIVE_STALE_SECONDS
        )
        return {
            "symbol": symbol,
            "sourceSymbol": selected[0],
            "close": selected[1],
            "currency": "USDT",
            "source": "tradingview-websocket",
            "updatedAt": selected[2],
        }
    return {
        "symbol": symbol,
        "sourceSymbol": f"{exchanges[0]}:{symbol}USDT.P",
        "close": None,
        "currency": "USDT",
        "source": "tradingview-websocket",
        "updatedAt": None,
    }


class RealtimeQuoteBroker:
    """Fan one persistent Market data provider quote session out to bounded local clients.

    The browser never chooses a raw Market data provider identifier. Direct sources are
    derived from a validated US listing symbol and allowlisted MIC; synthetic
    sources come only from the server-owned exchange order. The broker owns the
    sole upstream websocket, reconnects it in one worker, and replays the active
    subscription set after a disconnect.
    """

    def __init__(self, connect_timeout_seconds: float) -> None:
        self.connect_timeout_seconds = min(10.0, max(2.0, connect_timeout_seconds))
        self._condition = threading.Condition(threading.Lock())
        self._subscribers: dict[int, RealtimeSubscriber] = {}
        self._source_refcounts: dict[str, int] = {}
        self._source_items: dict[str, dict[str, str]] = {}
        self._source_generations: dict[str, int] = {}
        self._next_source_generation = 1
        self._latest: dict[str, dict[str, Any]] = {}
        self._raw_quote_values: dict[str, dict[str, Any]] = {}
        self._latest_epoch: dict[str, float] = {}
        self._next_subscriber_id = 1
        self._connection_state = "disconnected"
        self._stopping = False
        self._active_websocket: Any = None
        self._worker = threading.Thread(
            target=self._run,
            name="tradingview-realtime-broker",
            daemon=True,
        )
        self._worker.start()

    def close(self) -> None:
        websocket = None
        with self._condition:
            if self._stopping:
                return
            self._stopping = True
            websocket = self._active_websocket
            for subscriber in self._subscribers.values():
                subscriber.closed.set()
            self._subscribers.clear()
            self._source_refcounts.clear()
            self._source_items.clear()
            self._condition.notify_all()
        try:
            if websocket is not None and websocket.ws is not None:
                websocket.ws.close()
        except Exception:
            pass
        self._worker.join(timeout=self.connect_timeout_seconds + 2.0)

    def subscribe(
        self,
        items: tuple[dict[str, str], ...],
        owner: str,
        transient: bool = False,
    ) -> tuple[RealtimeSubscriber, list[dict[str, Any]]]:
        with self._condition:
            if self._stopping:
                raise RealtimeSubscriptionError("unavailable")
            if len(self._subscribers) >= MAX_REALTIME_SUBSCRIBERS:
                raise RealtimeSubscriptionError("subscriber_limit")
            subscription_kind_count = sum(
                1
                for subscriber in self._subscribers.values()
                if subscriber.transient == transient
            )
            subscription_kind_limit = (
                MAX_REALTIME_SNAPSHOT_SUBSCRIBERS
                if transient
                else MAX_REALTIME_STREAM_SUBSCRIBERS
            )
            if subscription_kind_count >= subscription_kind_limit:
                raise RealtimeSubscriptionError("subscriber_limit")
            owner_count = sum(
                1
                for subscriber in self._subscribers.values()
                if subscriber.owner == owner and subscriber.transient == transient
            )
            if owner_count >= MAX_REALTIME_SUBSCRIBERS_PER_OWNER:
                raise RealtimeSubscriptionError("subscriber_limit")
            requested_sources = {item["sourceSymbol"] for item in items}
            if len(set(self._source_refcounts).union(requested_sources)) > MAX_REALTIME_SOURCES:
                raise RealtimeSubscriptionError("symbol_limit")
            for item in items:
                existing = self._source_items.get(item["sourceSymbol"])
                if existing is not None and existing != item:
                    raise RealtimeSubscriptionError("source_conflict")

            subscriber = RealtimeSubscriber(
                self._next_subscriber_id,
                owner,
                items,
                transient,
            )
            self._next_subscriber_id += 1
            self._subscribers[subscriber.subscriber_id] = subscriber
            for item in items:
                source = item["sourceSymbol"]
                self._source_refcounts[source] = self._source_refcounts.get(source, 0) + 1
                self._source_items[source] = item
                # A source may still exist in the worker's local `subscribed`
                # set when its final downstream subscriber disappears and a
                # new one arrives before the worker observes the zero-refcount
                # state. Every unresolved subscription gets a new generation
                # so the worker can distinguish that race from an upstream
                # subscription that has already been applied. Multiple new
                # subscribers are coalesced to the latest generation.
                if source not in self._latest:
                    self._source_generations[source] = self._next_source_generation
                    self._next_source_generation += 1
            snapshot = self._ordered_snapshot_locked(items)
            self._condition.notify_all()
            return subscriber, snapshot

    def unsubscribe(self, subscriber_id: int) -> None:
        with self._condition:
            self._remove_subscriber_locked(subscriber_id)
            self._condition.notify_all()

    def connection_state(self) -> str:
        with self._condition:
            return self._connection_state

    def wait_for_snapshot(
        self,
        items: tuple[dict[str, str], ...],
        owner: str,
        timeout_seconds: float,
    ) -> tuple[list[dict[str, Any]], str]:
        # One-shot quote snapshots have reserved capacity separate from the
        # long-lived SSE pool. A burst of abandoned local EventSource requests
        # therefore cannot make symbol workspaces lose their current quote.
        subscriber, initial = self.subscribe(items, owner, transient=True)
        values = {
            item["sourceSymbol"]: value
            for item, value in zip(items, initial, strict=True)
            if value["price"] is not None
        }
        resolved = set(values)
        deadline = time.monotonic() + timeout_seconds
        try:
            while len(resolved) < len(items):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or subscriber.closed.is_set():
                    break
                try:
                    event = subscriber.events.get(timeout=remaining)
                except queue.Empty:
                    break
                if event.get("type") != "quote":
                    continue
                item = event.get("item")
                if not isinstance(item, dict):
                    continue
                source = item.get("sourceSymbol")
                if source not in subscriber.sources:
                    continue
                values[source] = item
                resolved.add(source)
            with self._condition:
                ordered = []
                stale = self._connection_state != "connected"
                for requested in items:
                    # `_latest` is the authoritative current websocket
                    # generation. A value captured in this call's local map
                    # may belong to the prior generation if a reconnect
                    # happened while another requested symbol was unresolved.
                    value = self._latest.get(requested["sourceSymbol"])
                    ordered.append(self._response_item(requested, value, stale))
                state = self._connection_state
            return ordered, state
        finally:
            self.unsubscribe(subscriber.subscriber_id)

    def _remove_subscriber_locked(self, subscriber_id: int) -> None:
        subscriber = self._subscribers.pop(subscriber_id, None)
        if subscriber is None:
            return
        subscriber.closed.set()
        for source in subscriber.sources:
            remaining = self._source_refcounts.get(source, 0) - 1
            if remaining > 0:
                self._source_refcounts[source] = remaining
                continue
            self._source_refcounts.pop(source, None)
            self._source_items.pop(source, None)
            self._source_generations.pop(source, None)
            self._latest.pop(source, None)
            self._raw_quote_values.pop(source, None)
            self._latest_epoch.pop(source, None)

    def _ordered_snapshot_locked(
        self,
        items: tuple[dict[str, str], ...],
    ) -> list[dict[str, Any]]:
        stale = self._connection_state != "connected"
        return [
            self._response_item(item, self._latest.get(item["sourceSymbol"]), stale)
            for item in items
        ]

    @staticmethod
    def _response_item(
        requested: dict[str, str],
        value: dict[str, Any] | None,
        stale: bool,
    ) -> dict[str, Any]:
        if value is None:
            return {
                "symbol": requested["symbol"],
                "sourceSymbol": requested["sourceSymbol"],
                "price": None,
                "previousClose": None,
                "change": None,
                "changePercent": None,
                "open": None,
                "high": None,
                "low": None,
                "volume": None,
                "currency": requested["currency"],
                "session": None,
                "updatedAt": None,
                "stale": True,
            }
        response = dict(value)
        response["stale"] = (
            stale
            or bool(value.get("stale"))
            or realtime_quote_is_stale(
                str(response.get("updatedAt", "")),
                not stale,
                requested["marketMode"] == "continuous",
            )
        )
        return response

    def _offer_locked(self, subscriber: RealtimeSubscriber, event: dict[str, Any]) -> None:
        if subscriber.closed.is_set():
            return
        try:
            subscriber.events.put_nowait(event)
        except queue.Full:
            # A slow consumer must not stall the shared upstream reader or grow
            # memory without bound. Its handler observes closed and cleans up.
            self._remove_subscriber_locked(subscriber.subscriber_id)

    def _publish_status(self, state: str) -> None:
        with self._condition:
            if state == "reconnecting":
                # Values from the prior websocket generation must not be
                # re-stamped as a fresh session observation. Subscribers keep
                # their last displayed price; snapshots remain missing until
                # the new quote session supplies a fresh qsd payload.
                for source in tuple(self._source_refcounts):
                    self._latest.pop(source, None)
                    self._raw_quote_values.pop(source, None)
                    self._latest_epoch.pop(source, None)
            if self._connection_state == state:
                return
            self._connection_state = state
            event = {
                "schemaVersion": REALTIME_SCHEMA_VERSION,
                "type": "status",
                "state": state,
                "ingestedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
            for subscriber in tuple(self._subscribers.values()):
                self._offer_locked(subscriber, event)

    def _publish_quote(self, source: str, quote_values: dict[str, Any]) -> bool:
        with self._condition:
            requested = self._source_items.get(source)
            if requested is None:
                return False
            previous_values = self._raw_quote_values.get(source, {})
            merged = dict(previous_values)
            for field in REALTIME_QUOTE_FIELDS:
                if field in quote_values:
                    merged[field] = quote_values[field]
            price = finite_number(merged.get("lp"))
            quote_epoch = finite_number(merged.get("lp_time"))
            currency = merged.get("currency_code")
            expected_currency = requested["currency"]
            if price is None or price <= 0 or quote_epoch is None or quote_epoch <= 0:
                if currency in {None, expected_currency}:
                    self._raw_quote_values[source] = merged
                return False
            if currency != expected_currency:
                return False
            previous_epoch = self._latest_epoch.get(source)
            if previous_epoch is not None and quote_epoch < previous_epoch:
                return False
            try:
                updated_at = utc_iso(quote_epoch)
            except (ValueError, OverflowError, OSError):
                return False
            self._raw_quote_values[source] = merged

            def optional_positive(field: str) -> float | None:
                value = finite_number(merged.get(field))
                return value if value is not None and value > 0 else None

            change = finite_number(merged.get("ch"))
            previous_close = optional_positive("prev_close_price")
            if previous_close is not None:
                change = price - previous_close
            change_percent = finite_number(merged.get("chp"))
            if previous_close is not None:
                change_percent = (change / previous_close) * 100
            volume = finite_number(merged.get("volume"))
            if volume is not None and volume < 0:
                volume = None
            raw_session = merged.get("current_session")
            session = (
                raw_session
                if isinstance(raw_session, str)
                and re.fullmatch(r"[a-z][a-z0-9_]{0,31}", raw_session)
                else None
            )
            item = {
                "symbol": requested["symbol"],
                "sourceSymbol": source,
                "price": price,
                "previousClose": previous_close,
                "change": change,
                "changePercent": change_percent,
                "open": optional_positive("open_price"),
                "high": optional_positive("high_price"),
                "low": optional_positive("low_price"),
                "volume": volume,
                "currency": expected_currency,
                "session": session,
                "updatedAt": updated_at,
                "stale": realtime_quote_is_stale(
                    updated_at,
                    True,
                    requested["marketMode"] == "continuous",
                ),
            }
            if self._latest.get(source) == item:
                return True
            self._latest[source] = item
            self._latest_epoch[source] = quote_epoch
            event = {
                "schemaVersion": REALTIME_SCHEMA_VERSION,
                "type": "quote",
                "item": item,
                "ingestedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
            for subscriber in tuple(self._subscribers.values()):
                if source in subscriber.sources:
                    self._offer_locked(subscriber, event)
            return True

    def _publish_missing(self, source: str) -> None:
        with self._condition:
            requested = self._source_items.get(source)
            if requested is None:
                return
            item = self._response_item(requested, None, True)
            event = {
                "schemaVersion": REALTIME_SCHEMA_VERSION,
                "type": "quote",
                "item": item,
                "ingestedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
            for subscriber in tuple(self._subscribers.values()):
                if source in subscriber.sources:
                    self._offer_locked(subscriber, event)

    def _desired_sources(self) -> frozenset[str]:
        with self._condition:
            return frozenset(self._source_refcounts)

    def _synchronize_quote_symbols(
        self,
        websocket: Any,
        quote_session: str,
        subscribed: set[str],
        applied_generations: dict[str, int],
        desired: frozenset[str],
    ) -> None:
        """Apply current sources and re-request unresolved newer generations."""
        with self._condition:
            generations = {
                source: self._source_generations.get(source, 0)
                for source in desired
            }
            unresolved = {
                source for source in desired if source not in self._latest
            }

        removed = subscribed.difference(desired)
        refresh = {
            source
            for source in subscribed.intersection(unresolved)
            if generations.get(source, 0) > applied_generations.get(source, 0)
        }
        upstream_removals = removed.union(refresh)
        if upstream_removals:
            websocket.send_message(
                "quote_remove_symbols",
                [quote_session, *sorted(upstream_removals)],
            )
            subscribed.difference_update(upstream_removals)
        for source in removed:
            applied_generations.pop(source, None)

        for source in sorted(desired.difference(subscribed)):
            # tradingview-websocket 0.6 currently rejects its own
            # force_permission flags; the two-argument form is the accepted
            # guest quote protocol.
            websocket.send_message("quote_add_symbols", [quote_session, source])
            subscribed.add(source)
            applied_generations[source] = generations.get(source, 0)

    def _wait_for_sources(self) -> frozenset[str]:
        with self._condition:
            while not self._stopping and not self._source_refcounts:
                self._connection_state = "disconnected"
                self._condition.wait()
            return frozenset(self._source_refcounts)

    def _wait_before_reconnect(self, delay_seconds: float) -> None:
        jittered = delay_seconds * random.uniform(0.8, 1.2)
        with self._condition:
            if not self._stopping and self._source_refcounts:
                self._condition.wait(timeout=jittered)

    def _run(self) -> None:
        reconnect_delay = 0.5
        while True:
            sources = self._wait_for_sources()
            with self._condition:
                if self._stopping:
                    return
            if not sources:
                continue
            websocket = None
            try:
                from tradingview_websocket import TradingViewWebSocket
                import websocket as websocket_client
                from websocket import WebSocketTimeoutException

                websocket = TradingViewWebSocket(sorted(sources)[0], "1", 1)
                previous_default_timeout = websocket_client.getdefaulttimeout()
                websocket_client.setdefaulttimeout(self.connect_timeout_seconds)
                try:
                    websocket.connect()
                finally:
                    websocket_client.setdefaulttimeout(previous_default_timeout)
                if websocket.ws is None:
                    raise RuntimeError("Market data provider websocket did not connect")
                websocket.ws.settimeout(1.0)
                with self._condition:
                    if self._stopping:
                        websocket.ws.close()
                        return
                    self._active_websocket = websocket
                quote_session = websocket.generate_session()
                websocket.send_message("set_auth_token", ["unauthorized_user_token"])
                websocket.send_message("quote_create_session", [quote_session])
                websocket.send_message(
                    "quote_set_fields",
                    [quote_session, *REALTIME_QUOTE_FIELDS],
                )
                subscribed: set[str] = set()
                applied_generations: dict[str, int] = {}
                connected_at = time.monotonic()
                last_received_at = connected_at
                self._publish_status("connected")

                while True:
                    with self._condition:
                        if self._stopping:
                            return
                    desired = self._desired_sources()
                    if not desired:
                        break
                    self._synchronize_quote_symbols(
                        websocket,
                        quote_session,
                        subscribed,
                        applied_generations,
                        desired,
                    )
                    try:
                        raw_message = websocket.ws.recv()
                    except WebSocketTimeoutException:
                        # No quote during a closed market is normal and must not
                        # be treated as a broken connection. Missing both quote
                        # traffic and heartbeat frames for the liveness window
                        # does indicate a half-open socket.
                        now = time.monotonic()
                        if now - last_received_at > REALTIME_UPSTREAM_LIVENESS_SECONDS:
                            raise RuntimeError("Market data provider websocket became unresponsive")
                        if now - connected_at >= 30.0:
                            reconnect_delay = 0.5
                        continue
                    if not isinstance(raw_message, str):
                        continue
                    last_received_at = time.monotonic()
                    if last_received_at - connected_at >= 30.0:
                        reconnect_delay = 0.5
                    for packet in re.split(r"~m~\d+~m~", raw_message):
                        if not packet:
                            continue
                        if packet.startswith("~h~"):
                            heartbeat = f"~m~{len(packet)}~m~{packet}"
                            websocket.ws.send(heartbeat)
                            continue
                        try:
                            message = json.loads(packet)
                        except (TypeError, json.JSONDecodeError):
                            continue
                        if not isinstance(message, dict):
                            continue
                        message_type = message.get("m")
                        parameters = message.get("p")
                        if (
                            message_type == "qsd"
                            and isinstance(parameters, list)
                            and len(parameters) >= 2
                            and parameters[0] == quote_session
                        ):
                            quote = parameters[1]
                            if not isinstance(quote, dict):
                                continue
                            source = quote.get("n")
                            if not isinstance(source, str) or source not in desired:
                                continue
                            values = quote.get("v")
                            if quote.get("s") == "ok" and isinstance(values, dict):
                                if self._publish_quote(source, values):
                                    reconnect_delay = 0.5
                            elif quote.get("s") in {"error", "permission_denied"}:
                                self._publish_missing(source)
                            continue
                        if (
                            message_type in {"critical_error", "protocol_error"}
                            and isinstance(parameters, list)
                            and parameters
                            and parameters[0] == quote_session
                        ):
                            raise RuntimeError("Market data provider quote session failed")
            except Exception:
                with self._condition:
                    should_reconnect = bool(self._source_refcounts) and not self._stopping
                if should_reconnect:
                    try:
                        if websocket is not None and websocket.ws is not None:
                            websocket.ws.close()
                    except Exception:
                        pass
                    self._publish_status("reconnecting")
                    self._wait_before_reconnect(reconnect_delay)
                    reconnect_delay = min(
                        REALTIME_RECONNECT_MAX_SECONDS,
                        reconnect_delay * 2.0,
                    )
            finally:
                with self._condition:
                    if self._active_websocket is websocket:
                        self._active_websocket = None
                    stopping = self._stopping
                    has_sources = bool(self._source_refcounts)
                try:
                    if websocket is not None and websocket.ws is not None:
                        websocket.ws.close()
                except Exception:
                    pass
                if not stopping and not has_sources:
                    self._publish_status("disconnected")


def utc_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc_datetime(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def continuous_reference_is_fresh(
    updated_at: str,
    observed_at: datetime | None = None,
) -> bool:
    """Return whether a continuous USDT.P tick is current at the 5m boundary."""
    quote_time = parse_utc_datetime(updated_at)
    now = observed_at or datetime.now(timezone.utc)
    if quote_time is None or now.tzinfo is None:
        return False
    age_seconds = (now.astimezone(timezone.utc) - quote_time).total_seconds()
    return -REALTIME_FUTURE_SKEW_SECONDS <= age_seconds <= REALTIME_ACTIVE_STALE_SECONDS


def realtime_quote_is_stale(
    updated_at: str,
    connected: bool,
    continuous: bool = False,
) -> bool:
    """Conservatively flag age during the normal US extended-session window.

    Exchange holidays and early closes intentionally remain conservative here;
    the exact provider timestamp is always returned so a future calendar-aware
    market-session layer can refine this without changing the stream contract.
    """
    if not connected:
        return True
    if continuous:
        return not continuous_reference_is_fresh(updated_at)
    quote_time = parse_utc_datetime(updated_at)
    if quote_time is None:
        return True
    now = datetime.now(timezone.utc)
    market_now = now.astimezone(ZoneInfo("America/New_York"))
    active = market_now.weekday() < 5 and 4 <= market_now.hour < 20
    return active and (now - quote_time).total_seconds() > REALTIME_ACTIVE_STALE_SECONDS


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return None
    return parsed


def normalize_rows(result_data: Any) -> list[dict[str, float | str]]:
    if not isinstance(result_data, list):
        raise ValueError("Market data provider returned an invalid series payload")
    rows: list[dict[str, float | str]] = []
    for entry in result_data:
        if not isinstance(entry, dict) or not isinstance(entry.get("v"), list):
            continue
        values = entry["v"]
        if len(values) < 6:
            continue
        timestamp = finite_number(values[0])
        open_value = finite_number(values[1])
        high_value = finite_number(values[2])
        low_value = finite_number(values[3])
        close_value = finite_number(values[4])
        volume_value = finite_number(values[5]) if len(values) > 5 else None
        if None in (timestamp, open_value, high_value, low_value, close_value, volume_value):
            continue
        if (
            open_value <= 0
            or high_value <= 0
            or low_value <= 0
            or close_value <= 0
            or volume_value < 0
            or high_value < max(open_value, close_value, low_value)
            or low_value > min(open_value, close_value, high_value)
        ):
            continue
        rows.append(
            {
                "time": utc_iso(timestamp),
                "open": open_value,
                "high": high_value,
                "low": low_value,
                "close": close_value,
                "volume": volume_value,
            }
        )
    rows.sort(key=lambda row: str(row["time"]))
    deduplicated = {str(row["time"]): row for row in rows}
    normalized = list(deduplicated.values())
    if not normalized:
        raise ValueError("Market data provider returned no usable bars")
    return normalized


def fetch_in_child(
    result_queue: multiprocessing.Queue,
    tradingview_symbol: str,
    timeframe: str,
    count: int,
) -> None:
    websocket = None
    try:
        from tradingview_websocket import TradingViewWebSocket

        websocket = TradingViewWebSocket(tradingview_symbol, timeframe, count)
        websocket.connect()
        websocket.run()
        result_queue.put({"ok": True, "items": normalize_rows(websocket.result_data)})
    except Exception as error:  # The child never returns an upstream body or secret.
        result_queue.put({"ok": False, "error": type(error).__name__})
    finally:
        try:
            if websocket is not None and websocket.ws is not None:
                websocket.ws.close()
        except Exception:
            pass


def fetch_bars(
    exchange: str,
    symbol: str,
    interval: str,
    count: int,
    timeout_seconds: float,
) -> list[dict[str, float | str]]:
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue(maxsize=1)
    process = context.Process(
        target=fetch_in_child,
        args=(result_queue, f"{exchange}:{symbol}", INTERVAL_TO_TRADINGVIEW[interval], count),
        daemon=True,
    )
    process.start()
    try:
        # Drain the queue before joining. A 10,000-row payload is larger than a
        # typical multiprocessing pipe buffer; joining first can deadlock while
        # the child feeder thread waits for the parent to read.
        result = result_queue.get(timeout=timeout_seconds)
    except queue.Empty as error:
        if process.is_alive():
            process.terminate()
            process.join(2)
            raise TimeoutError("Market data provider websocket timed out") from error
        raise RuntimeError("Market data provider websocket exited without data") from error
    finally:
        process.join(2)
        if process.is_alive():
            process.terminate()
            process.join(2)
        result_queue.close()
        result_queue.join_thread()
    if not result.get("ok"):
        raise RuntimeError("Market data provider websocket fetch failed")
    return result["items"]


def fetch_latest_closes_in_child(
    result_queue: multiprocessing.Queue,
    symbols: list[str],
    exchanges: tuple[str, ...],
    timeout_seconds: float,
) -> None:
    websocket = None
    try:
        from tradingview_websocket import TradingViewWebSocket
        from websocket import WebSocketTimeoutException

        # Guest chart sessions permit one series each, but several chart
        # sessions can share one websocket. This keeps a whole watchlist to one
        # upstream connection and avoids intermittent failures caused by an
        # N-connection fan-out.
        first_source_symbol = f"{exchanges[0]}:{symbols[0]}USDT.P"
        websocket = TradingViewWebSocket(
            first_source_symbol,
            INTERVAL_TO_TRADINGVIEW["1m"],
            1,
        )
        websocket.connect()
        if websocket.ws is None:
            raise RuntimeError("Market data provider websocket did not connect")
        resolution_window = min(8.0, max(2.0, timeout_seconds - 1.0))
        candidate_timeout = max(0.5, resolution_window / len(exchanges))
        # A short receive timeout gives silent/unsupported candidates a bounded
        # opportunity before the resolver advances to the next configured
        # exchange. Market data provider normally emits symbol_error, but that signal is
        # not guaranteed for every exchange adapter.
        websocket.ws.settimeout(min(0.5, candidate_timeout))
        websocket.send_message("set_auth_token", ["unauthorized_user_token"])

        session_symbols: dict[str, tuple[str, int]] = {}
        active_candidates: dict[str, int] = {}
        candidate_started_at: dict[str, float] = {}
        pending = set(symbols)
        values: dict[str, dict[str, float | str] | None] = {
            symbol: None for symbol in symbols
        }

        request_sequence = 0

        def request_candidate(symbol: str, exchange_index: int) -> None:
            nonlocal request_sequence
            exchange = exchanges[exchange_index]
            chart_session = websocket.generate_chart_session()
            session_symbols[chart_session] = (symbol, exchange_index)
            alias = f"symbol_{request_sequence}"
            request_sequence += 1
            source_symbol = f"{exchange}:{symbol}USDT.P"
            symbol_definition = "=" + json.dumps(
                {"symbol": source_symbol, "adjustment": "splits"},
                separators=(",", ":"),
            )
            websocket.send_message("chart_create_session", [chart_session, ""])
            websocket.send_message(
                "resolve_symbol",
                [chart_session, alias, symbol_definition],
            )
            websocket.send_message(
                "create_series",
                [chart_session, "s1", "s1", alias, INTERVAL_TO_TRADINGVIEW["1m"], 1],
            )
            active_candidates[symbol] = exchange_index
            candidate_started_at[symbol] = time.monotonic()

        def advance_candidate(symbol: str, observed_index: int) -> None:
            if symbol not in pending or active_candidates.get(symbol) != observed_index:
                return
            if observed_index + 1 < len(exchanges):
                request_candidate(symbol, observed_index + 1)
            else:
                pending.discard(symbol)

        def advance_silent_candidates() -> None:
            now = time.monotonic()
            for symbol in tuple(pending):
                exchange_index = active_candidates[symbol]
                if now - candidate_started_at[symbol] >= candidate_timeout:
                    advance_candidate(symbol, exchange_index)

        for symbol in symbols:
            request_candidate(symbol, 0)

        deadline = time.monotonic() + resolution_window
        while pending and time.monotonic() < deadline:
            try:
                raw_message = websocket.ws.recv()
            except WebSocketTimeoutException:
                advance_silent_candidates()
                continue
            except Exception:
                # Preserve completed symbols and represent any unfinished
                # symbols as explicit nulls in this batch.
                break
            if not isinstance(raw_message, str):
                continue
            for packet in re.split(r"~m~\d+~m~", raw_message):
                try:
                    message = json.loads(packet)
                except (TypeError, json.JSONDecodeError):
                    continue
                if not isinstance(message, dict):
                    continue
                parameters = message.get("p")
                if not isinstance(parameters, list) or not parameters:
                    continue
                chart_session = parameters[0]
                resolved_session = session_symbols.get(chart_session)
                if resolved_session is None:
                    continue
                symbol, exchange_index = resolved_session
                if active_candidates.get(symbol) != exchange_index:
                    continue
                message_type = message.get("m")
                if message_type in {"symbol_error", "series_error", "critical_error"}:
                    advance_candidate(symbol, exchange_index)
                    continue
                if message_type != "timescale_update" or len(parameters) < 2:
                    continue
                update = parameters[1]
                if not isinstance(update, dict):
                    continue
                series = update.get("s1")
                rows = series.get("s") if isinstance(series, dict) else None
                try:
                    latest = normalize_rows(rows)[-1]
                except (TypeError, ValueError):
                    continue
                close_value = finite_number(latest["close"])
                if (
                    close_value is not None
                    and close_value > 0
                    and continuous_reference_is_fresh(str(latest["time"]))
                ):
                    values[symbol] = {
                        "close": close_value,
                        "updatedAt": latest["time"],
                        "sourceSymbol": f"{exchanges[exchange_index]}:{symbol}USDT.P",
                    }
                    pending.discard(symbol)
                else:
                    advance_candidate(symbol, exchange_index)
            advance_silent_candidates()
        result_queue.put({"ok": True, "values": values})
    except Exception as error:
        result_queue.put({"ok": False, "error": type(error).__name__})
    finally:
        try:
            if websocket is not None and websocket.ws is not None:
                websocket.ws.close()
        except Exception:
            pass


def fetch_latest_closes(
    symbols: list[str],
    exchanges: tuple[str, ...],
    timeout_seconds: float,
) -> dict[str, dict[str, float | str] | None]:
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue(maxsize=1)
    process = context.Process(
        target=fetch_latest_closes_in_child,
        args=(result_queue, symbols, exchanges, timeout_seconds),
        daemon=True,
    )
    process.start()
    try:
        result = result_queue.get(timeout=timeout_seconds)
    except queue.Empty as error:
        if process.is_alive():
            process.terminate()
            process.join(2)
            raise TimeoutError("Market data provider latest-close batch timed out") from error
        raise RuntimeError("Market data provider latest-close batch exited without data") from error
    finally:
        process.join(2)
        if process.is_alive():
            process.terminate()
            process.join(2)
        result_queue.close()
        result_queue.join_thread()
    if not result.get("ok"):
        raise RuntimeError("Market data provider latest-close batch failed")
    return result["values"]


def yahoo_text(value: Any, maximum_length: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    return normalized[:maximum_length] if normalized else None


def yahoo_url(value: Any) -> str | None:
    candidate = yahoo_text(value, 2_048)
    if candidate is None:
        return None
    try:
        parsed = urlsplit(candidate)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            return None
        _ = parsed.port
    except ValueError:
        return None
    return candidate


def yahoo_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if math.isfinite(parsed) else None


def yahoo_date(value: Any) -> str | None:
    try:
        if hasattr(value, "to_pydatetime"):
            value = value.to_pydatetime()
        if isinstance(value, datetime):
            return value.date().isoformat()
        candidate = str(value).strip()[:10]
        return datetime.strptime(candidate, "%Y-%m-%d").date().isoformat()
    except (TypeError, ValueError, OverflowError):
        return None


def yahoo_ipo_date(info: dict[str, Any]) -> str | None:
    seconds = yahoo_number(info.get("firstTradeDateEpochUtc"))
    if seconds is None or seconds <= 0:
        return None
    try:
        return datetime.fromtimestamp(seconds, timezone.utc).date().isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def load_yahoo_profile(symbol: str) -> dict[str, Any]:
    import yfinance as yf

    raw_info = yf.Ticker(symbol).info or {}
    if not isinstance(raw_info, dict):
        raise RuntimeError("Yahoo profile was invalid")
    profile: dict[str, Any] = {}
    text_fields = (
        ("description", "longBusinessSummary", 20_000),
        ("sector", "sector", 200),
        ("industry", "industry", 300),
        ("country", "country", 200),
        ("city", "city", 200),
    )
    for target, source, maximum_length in text_fields:
        value = yahoo_text(raw_info.get(source), maximum_length)
        if value is not None:
            profile[target] = value
    website = yahoo_url(raw_info.get("website"))
    if website is not None:
        profile["website"] = website
    employees = yahoo_number(raw_info.get("fullTimeEmployees"))
    if employees is not None and 0 <= employees <= 1_000_000_000:
        profile["employees"] = int(employees)
    beta = yahoo_number(raw_info.get("beta"))
    if beta is not None and abs(beta) <= 1_000:
        profile["beta"] = beta
    market_cap = yahoo_number(raw_info.get("marketCap"))
    if market_cap is not None and 0 < market_cap <= 1e18:
        profile["marketCap"] = market_cap
    ipo_date = yahoo_ipo_date(raw_info)
    if ipo_date is not None:
        profile["ipoDate"] = ipo_date

    ingested_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "schemaVersion": YAHOO_SCHEMA_VERSION,
        "symbol": symbol,
        "profile": profile or None,
        "asOf": ingested_at,
        "ingestedAt": ingested_at,
    }


def yahoo_quarterly_revenues(ticker: Any) -> list[tuple[str, float]]:
    try:
        frame = ticker.quarterly_income_stmt
    except Exception:
        return []
    if frame is None or not hasattr(frame, "index") or "Total Revenue" not in frame.index:
        return []
    try:
        series = frame.loc["Total Revenue"]
    except Exception:
        return []
    revenues: list[tuple[str, float]] = []
    for fiscal_value, raw_revenue in series.items():
        fiscal_date = yahoo_date(fiscal_value)
        revenue = yahoo_number(raw_revenue)
        if fiscal_date is None or revenue is None or revenue < 0:
            continue
        revenues.append((fiscal_date, revenue))
    revenues.sort(key=lambda item: item[0], reverse=True)
    return revenues


def yahoo_revenue_estimates(ticker: Any) -> dict[str, float]:
    try:
        frame = ticker.get_revenue_estimate()
    except Exception:
        try:
            frame = ticker.revenue_estimate
        except Exception:
            return {}
    if frame is None or not hasattr(frame, "index") or "avg" not in frame.columns:
        return {}
    estimates: dict[str, float] = {}
    for period in ("0q", "+1q"):
        try:
            estimate = yahoo_number(frame.loc[period, "avg"])
        except Exception:
            estimate = None
        if estimate is not None and estimate >= 0:
            estimates[period] = estimate
    return estimates


def attach_yahoo_revenues(rows: list[dict[str, Any]], ticker: Any) -> None:
    revenues = yahoo_quarterly_revenues(ticker)
    unused_fiscal_dates = {fiscal_date for fiscal_date, _ in revenues}
    for row in rows:
        if "epsActual" not in row:
            continue
        report_time = datetime.strptime(row["reportDate"], "%Y-%m-%d").date()
        closest: tuple[str, float] | None = None
        closest_lag = 131
        for fiscal_date, revenue in revenues:
            if fiscal_date not in unused_fiscal_dates:
                continue
            fiscal_time = datetime.strptime(fiscal_date, "%Y-%m-%d").date()
            lag_days = (report_time - fiscal_time).days
            if 0 <= lag_days <= 130 and lag_days < closest_lag:
                closest = (fiscal_date, revenue)
                closest_lag = lag_days
        if closest is not None:
            row["revenueActual"] = closest[1]
            unused_fiscal_dates.remove(closest[0])

    future_rows = sorted(
        (row for row in rows if "epsActual" not in row),
        key=lambda row: row["reportDate"],
    )
    estimates = yahoo_revenue_estimates(ticker)
    for row, period in zip(future_rows, ("0q", "+1q")):
        if period in estimates:
            row["revenueEstimate"] = estimates[period]


def load_yahoo_earnings(symbol: str, limit: int) -> dict[str, Any]:
    import yfinance as yf

    ticker = yf.Ticker(symbol)
    frame = ticker.get_earnings_dates(limit=limit)
    rows: list[dict[str, Any]] = []
    seen_dates: set[str] = set()
    if frame is not None and hasattr(frame, "iterrows"):
        try:
            frame = frame.sort_index(ascending=False)
        except Exception:
            pass
        for raw_date, values in frame.iterrows():
            report_date = yahoo_date(raw_date)
            if report_date is None or report_date in seen_dates:
                continue
            eps_actual = yahoo_number(values.get("Reported EPS"))
            eps_estimate = yahoo_number(values.get("EPS Estimate"))
            if eps_actual is None and eps_estimate is None:
                continue
            row: dict[str, Any] = {"reportDate": report_date}
            if eps_actual is not None:
                row["epsActual"] = eps_actual
            if eps_estimate is not None:
                row["epsEstimate"] = eps_estimate
            rows.append(row)
            seen_dates.add(report_date)
            if len(rows) >= limit:
                break

    attach_yahoo_revenues(rows, ticker)

    ingested_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "schemaVersion": YAHOO_SCHEMA_VERSION,
        "symbol": symbol,
        "earnings": rows,
        "asOf": rows[0]["reportDate"] if rows else ingested_at,
        "ingestedAt": ingested_at,
    }


def load_yahoo_in_child(
    result_queue: multiprocessing.Queue,
    kind: str,
    symbol: str,
    limit: int,
) -> None:
    try:
        payload = (
            load_yahoo_profile(symbol)
            if kind == "profile"
            else load_yahoo_earnings(symbol, limit)
        )
        result_queue.put({"ok": True, "payload": payload})
    except Exception as error:
        # Only the exception class crosses the process boundary; upstream
        # bodies, request cookies and crumbs never do.
        result_queue.put({"ok": False, "error": type(error).__name__})


def fetch_yahoo_payload(
    kind: str,
    symbol: str,
    limit: int,
    timeout_seconds: float,
) -> dict[str, Any]:
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue(maxsize=1)
    process = context.Process(
        target=load_yahoo_in_child,
        args=(result_queue, kind, symbol, limit),
        daemon=True,
    )
    process.start()
    try:
        result = result_queue.get(timeout=timeout_seconds)
    except queue.Empty as error:
        if process.is_alive():
            process.terminate()
            process.join(2)
            raise TimeoutError("Yahoo sidecar timed out") from error
        raise RuntimeError("Yahoo sidecar exited without data") from error
    finally:
        process.join(2)
        if process.is_alive():
            process.terminate()
            process.join(2)
        result_queue.close()
        result_queue.join_thread()
    if not result.get("ok") or not isinstance(result.get("payload"), dict):
        raise RuntimeError("Yahoo sidecar fetch failed")
    return result["payload"]


def cached_yahoo_payload(
    server: Any,
    key: tuple[str, str, int],
    ttl_seconds: float,
    loader: Callable[[], dict[str, Any]],
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Share one upstream request and cache only its normalized response."""
    now = time.monotonic()
    with server.yahoo_lock:
        cached = server.yahoo_cache.get(key)
        if not force_refresh and cached is not None and cached[0] > now:
            return cached[1]
        inflight = server.yahoo_inflight.get(key)
        leader = inflight is None
        if inflight is None:
            inflight = YahooInFlight()
            server.yahoo_inflight[key] = inflight

    if leader:
        try:
            payload = loader()
        except Exception:
            with server.yahoo_lock:
                inflight.failed = True
                server.yahoo_inflight.pop(key, None)
                inflight.event.set()
            raise
        with server.yahoo_lock:
            inflight.payload = payload
            server.yahoo_cache[key] = (time.monotonic() + ttl_seconds, payload)
            server.yahoo_inflight.pop(key, None)
            inflight.event.set()
        return payload

    if not inflight.event.wait(server.fetch_timeout_seconds):
        raise TimeoutError("Yahoo sidecar request timed out")
    if inflight.failed or inflight.payload is None:
        raise RuntimeError("Yahoo sidecar request failed")
    return inflight.payload


class TradingViewSidecarServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = MAX_HTTP_REQUEST_THREADS

    def __init__(
        self,
        address: tuple[str, int],
        token: str,
        timeout_seconds: float,
        latest_close_exchanges: tuple[str, ...],
    ) -> None:
        super().__init__(address, TradingViewSidecarHandler)
        self.auth_token = token
        self.fetch_timeout_seconds = timeout_seconds
        self.latest_close_exchanges = latest_close_exchanges
        self.request_semaphore = threading.BoundedSemaphore(MAX_HTTP_REQUEST_THREADS)
        self.realtime_quotes = RealtimeQuoteBroker(timeout_seconds)
        self.yahoo_lock = threading.Lock()
        self.yahoo_cache: dict[
            tuple[str, str, int],
            tuple[float, dict[str, Any]],
        ] = {}
        self.yahoo_inflight: dict[tuple[str, str, int], YahooInFlight] = {}

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self.request_semaphore.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.request_semaphore.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_semaphore.release()

    def server_close(self) -> None:
        self.realtime_quotes.close()
        super().server_close()


USASPENDING_AWARDS_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
MAX_USASPENDING_RESPONSE_BYTES = 2_000_000


class _UsaspendingNoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never follow an official endpoint redirect to another destination.
        return None


def fetch_usaspending_awards(payload: dict, timeout_seconds: float = 12, opener=None) -> dict:
    """Return a bounded raw award response; TypeScript owns normalization."""
    if not isinstance(payload, dict) or set(payload) != {"recipient", "endDate"}:
        raise ValueError("Invalid USAspending request.")
    recipient = payload["recipient"]
    end_date = payload["endDate"]
    if not isinstance(recipient, str) or re.search(r"[\x00-\x1f\x7f]", recipient):
        raise ValueError("Invalid USAspending request.")
    recipient = recipient.strip()
    if not 2 <= len(recipient) <= 120:
        raise ValueError("Invalid USAspending request.")
    if not isinstance(end_date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end_date):
        raise ValueError("Invalid USAspending request.")
    try:
        end = datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise ValueError("Invalid USAspending request.") from None
    if end.strftime("%Y-%m-%d") != end_date or not "2008-10-01" <= end_date <= datetime.now(timezone.utc).date().isoformat():
        raise ValueError("Invalid USAspending request.")
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (float, int)) or not math.isfinite(timeout_seconds):
        raise ValueError("Invalid USAspending timeout.")
    timeout = min(12.0, max(1.0, float(timeout_seconds)))
    start_date = (end - timedelta(days=365)).date().isoformat()
    body = {
        "filters": {
            "time_period": [{"start_date": start_date, "end_date": end_date}],
            "award_type_codes": ["A", "B", "C", "D"],
            "recipient_search_text": [recipient],
        },
        "fields": [
            "Award ID", "Recipient Name", "Recipient UEI", "Award Amount",
            "Awarding Agency", "Start Date", "Last Modified Date", "generated_internal_id",
        ],
        "page": 1,
        "limit": 50,
        "sort": "Last Modified Date",
        "order": "desc",
        "subawards": False,
    }
    request = Request(
        USASPENDING_AWARDS_URL,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "TraderResearch/1.0"},
        method="POST",
    )
    client = opener if opener is not None else build_opener(_UsaspendingNoRedirect())
    deadline = time.monotonic() + timeout
    try:
        with client.open(request, timeout=timeout) as response:
            if response.getcode() != 200 or response.geturl() != USASPENDING_AWARDS_URL:
                raise RuntimeError("USAspending unavailable.")
            declared_size = response.headers.get("Content-Length")
            if declared_size is not None and (not re.fullmatch(r"\d+", str(declared_size)) or int(declared_size) > MAX_USASPENDING_RESPONSE_BYTES):
                raise RuntimeError("USAspending unavailable.")
            # read1 avoids waiting for a whole 64 KiB buffer while a server
            # trickles bytes, permitting deadline checks between socket reads.
            read = getattr(response, "read1", response.read)
            chunks = []
            size = 0
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError("USAspending timeout.")
                chunk = read(min(65_536, MAX_USASPENDING_RESPONSE_BYTES + 1 - size))
                if time.monotonic() >= deadline:
                    raise TimeoutError("USAspending timeout.")
                if not chunk:
                    break
                if not isinstance(chunk, bytes):
                    raise RuntimeError("USAspending unavailable.")
                size += len(chunk)
                if size > MAX_USASPENDING_RESPONSE_BYTES:
                    raise RuntimeError("USAspending unavailable.")
                chunks.append(chunk)
            def reject_nonfinite(_value):
                raise ValueError("Invalid upstream number.")

            result = json.loads(b"".join(chunks).decode("utf-8"), parse_constant=reject_nonfinite)
            if not isinstance(result, dict) or result.get("spending_level") != "awards" or not isinstance(result.get("results"), list) or len(result["results"]) > 50:
                raise RuntimeError("USAspending unavailable.")
            return result
    except TimeoutError:
        raise TimeoutError("USAspending timeout.") from None
    except URLError as error:
        if isinstance(error.reason, TimeoutError):
            raise TimeoutError("USAspending timeout.") from None
        raise RuntimeError("USAspending unavailable.") from None
    except (HTTPError, OSError, ValueError, UnicodeError, RuntimeError):
        raise RuntimeError("USAspending unavailable.") from None


TALIB_CAPACITY = threading.BoundedSemaphore(2)
FINANCIALS_CAPACITY = threading.BoundedSemaphore(4)
SHARED_DATA_CAPACITY = threading.BoundedSemaphore(4)


def local_research_module(name: str):
    """Load only reviewed bundled modules, including importlib-based test runners."""
    if name not in {"talib_indicators", "financial_history", "shared_data"}:
        raise ValueError("invalid module")
    if name in sys.modules:
        return sys.modules[name]
    try:
        return __import__(name)
    except ModuleNotFoundError:
        from pathlib import Path
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
        if spec is None or spec.loader is None:
            raise RuntimeError("research module unavailable") from None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules[name] = module
        return module


class TradingViewSidecarHandler(BaseHTTPRequestHandler):
    server: TradingViewSidecarServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        # Query strings and Authorization headers are intentionally omitted.
        del format_string, args
        sys.stderr.write(
            f"tradingview-sidecar {self.client_address[0]} "
            f"{self.command} {urlsplit(self.path).path}\n"
        )

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def authenticated(self) -> bool:
        token = self.server.auth_token
        if not token:
            return True
        provided = self.headers.get("Authorization", "")
        return hmac.compare_digest(provided, f"Bearer {token}")

    def read_json_body(
        self,
        maximum_bytes: int = MAX_LATEST_CLOSE_BODY_BYTES,
    ) -> dict[str, Any] | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.close_connection = True
            return None
        if content_length <= 0 or content_length > maximum_bytes:
            self.close_connection = True
            return None
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def send_sse_event(self, event_name: str, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        self.wfile.write(f"event: {event_name}\ndata: {data}\n\n".encode("utf-8"))
        self.wfile.flush()

    def send_realtime_stream(
        self,
        items: tuple[dict[str, str], ...],
    ) -> None:
        try:
            subscriber, snapshot = self.server.realtime_quotes.subscribe(
                items,
                self.client_address[0],
            )
        except RealtimeSubscriptionError as error:
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": error.code})
            return

        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.connection.settimeout(5.0)
        deadline = time.monotonic() + REALTIME_STREAM_TTL_SECONDS
        try:
            self.send_sse_event(
                "ready",
                {
                    "schemaVersion": REALTIME_SCHEMA_VERSION,
                    "type": "ready",
                    "state": self.server.realtime_quotes.connection_state(),
                    "items": snapshot,
                    "ingestedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                },
            )
            while not subscriber.closed.is_set() and time.monotonic() < deadline:
                remaining = min(
                    REALTIME_KEEPALIVE_SECONDS,
                    max(0.0, deadline - time.monotonic()),
                )
                if remaining <= 0:
                    break
                try:
                    event = subscriber.events.get(timeout=remaining)
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                event_type = event.get("type")
                if event_type not in {"quote", "status"}:
                    continue
                self.send_sse_event(str(event_type), event)
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        finally:
            self.server.realtime_quotes.unsubscribe(subscriber.subscriber_id)
            self.close_connection = True

    def send_latest_close_stream(self, symbols: list[str]) -> None:
        """Stream ordered-fallback USDT perpetual reference prices."""
        exchanges = self.server.latest_close_exchanges
        broker_items = synthetic_realtime_items(symbols, exchanges)
        try:
            subscriber, snapshot = self.server.realtime_quotes.subscribe(
                broker_items,
                self.client_address[0],
            )
        except RealtimeSubscriptionError as error:
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": error.code})
            return

        values = {
            requested["sourceSymbol"]: value
            for requested, value in zip(broker_items, snapshot, strict=True)
        }
        selected = {
            symbol: synthetic_latest_close_item(symbol, exchanges, values)
            for symbol in symbols
        }
        source_to_symbol = {
            item["sourceSymbol"]: item["symbol"]
            for item in broker_items
        }

        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.connection.settimeout(5.0)
        deadline = time.monotonic() + REALTIME_STREAM_TTL_SECONDS
        try:
            self.send_sse_event(
                "ready",
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "type": "ready",
                    "exchange": exchanges[0],
                    "exchanges": list(exchanges),
                    "resolutionStrategy": "ordered_fallback",
                    "state": self.server.realtime_quotes.connection_state(),
                    "items": [selected[symbol] for symbol in symbols],
                    "ingestedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                },
            )
            while not subscriber.closed.is_set() and time.monotonic() < deadline:
                remaining = min(
                    REALTIME_KEEPALIVE_SECONDS,
                    max(0.0, deadline - time.monotonic()),
                )
                if remaining <= 0:
                    break
                try:
                    event = subscriber.events.get(timeout=remaining)
                except queue.Empty:
                    emitted_expiry = False
                    for symbol in symbols:
                        next_item = synthetic_latest_close_item(symbol, exchanges, values)
                        if next_item == selected[symbol]:
                            continue
                        selected[symbol] = next_item
                        self.send_sse_event(
                            "quote",
                            {
                                "schemaVersion": SCHEMA_VERSION,
                                "type": "quote",
                                "exchange": exchanges[0],
                                "exchanges": list(exchanges),
                                "resolutionStrategy": "ordered_fallback",
                                "item": next_item,
                                "ingestedAt": datetime.now(timezone.utc).isoformat().replace(
                                    "+00:00", "Z"
                                ),
                            },
                        )
                        emitted_expiry = True
                    if not emitted_expiry:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    continue

                event_type = event.get("type")
                ingested_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                if event_type == "status":
                    self.send_sse_event(
                        "status",
                        {
                            "schemaVersion": SCHEMA_VERSION,
                            "type": "status",
                            "state": event.get("state"),
                            "ingestedAt": event.get("ingestedAt", ingested_at),
                        },
                    )
                    continue
                if event_type != "quote":
                    continue
                value = event.get("item")
                if not isinstance(value, dict):
                    continue
                source_symbol = value.get("sourceSymbol")
                symbol = source_to_symbol.get(source_symbol)
                if symbol is None:
                    continue
                values[source_symbol] = value
                next_item = synthetic_latest_close_item(symbol, exchanges, values)
                if next_item == selected[symbol]:
                    continue
                selected[symbol] = next_item
                self.send_sse_event(
                    "quote",
                    {
                        "schemaVersion": SCHEMA_VERSION,
                        "type": "quote",
                        "exchange": exchanges[0],
                        "exchanges": list(exchanges),
                        "resolutionStrategy": "ordered_fallback",
                        "item": next_item,
                        "ingestedAt": event.get("ingestedAt", ingested_at),
                    },
                )
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        finally:
            self.server.realtime_quotes.unsubscribe(subscriber.subscriber_id)
            self.close_connection = True

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/v1/shared-data/"):
            if not self.server.auth_token or not self.authenticated():
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            dataset = parsed.path.removeprefix("/v1/shared-data/")
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", dataset) or len(parsed.query) > 8192:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            params = parse_qs(parsed.query, keep_blank_values=True)
            if any(len(values) != 1 or len(values[0]) > 4096 for values in params.values()):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            if not SHARED_DATA_CAPACITY.acquire(blocking=False):
                self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "capacity"})
                return
            try:
                module = local_research_module("shared_data")
                result = module.load_dataset(dataset, {key: values[0] for key, values in params.items()})
                if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 8 * 1024 * 1024:
                    self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "invalid_response"})
                    return
                self.send_json(HTTPStatus.OK, result)
            except Exception as error:
                status = getattr(error, "status", 503)
                code = getattr(error, "code", "unavailable")
                if status not in {400, 404, 409, 429, 503, 504}:
                    status = 503
                if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,64}", code):
                    code = "unavailable"
                self.send_json(HTTPStatus(status), {"error": code})
            finally:
                SHARED_DATA_CAPACITY.release()
            return
        if parsed.path in {"/v1/indicators", "/v1/tradingview/financials"}:
            if not self.server.auth_token or not self.authenticated():
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            if parsed.path == "/v1/indicators":
                if parsed.query:
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                    return
                try:
                    result = local_research_module("talib_indicators").catalog()
                except Exception:
                    self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "talib_unavailable"})
                    return
                self.send_json(HTTPStatus.OK, result)
                return
            params = parse_qs(parsed.query, keep_blank_values=True)
            if set(params) != {"symbol", "mic"} or any(len(values) != 1 for values in params.values()):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            symbol, mic = params["symbol"][0], params["mic"][0]
            if not SYMBOL_PATTERN.fullmatch(symbol) or mic not in MIC_TO_TRADINGVIEW_EXCHANGE:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            if not FINANCIALS_CAPACITY.acquire(blocking=False):
                self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "capacity"})
                return
            try:
                result = local_research_module("financial_history").fetch_financial_history(symbol, mic, timeout_seconds=12.0)
                self.send_json(HTTPStatus.OK, result)
            except TimeoutError:
                self.send_json(HTTPStatus.GATEWAY_TIMEOUT, {"error": "upstream_timeout"})
            except Exception:
                self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "upstream_error"})
            finally:
                FINANCIALS_CAPACITY.release()
            return
        if parsed.path == "/healthz":
            if not self.authenticated():
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            self.send_json(
                HTTPStatus.OK,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "status": "ok",
                    "backend": "tradingview-websocket",
                    "maxCandles": MAX_CANDLE_COUNT,
                    "realtimeQuotes": True,
                    "realtimeSyntheticLatestCloses": True,
                    "maxRealtimeSymbols": MAX_REALTIME_SYMBOLS,
                },
            )
            return

        if parsed.path in {"/v1/yahoo/profile", "/v1/yahoo/earnings"}:
            if not self.authenticated():
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            parameters = parse_qs(parsed.query, keep_blank_values=False)
            if any(len(values) != 1 for values in parameters.values()):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            symbol = parameters.get("symbol", [""])[0].strip().upper()
            if not SYMBOL_PATTERN.fullmatch(symbol):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            try:
                if parsed.path == "/v1/yahoo/profile":
                    if not set(parameters).issubset({"symbol", "fresh"}):
                        raise ValueError("invalid profile parameters")
                    force_refresh = parameters.get("fresh", [""])[0] == "1"
                    if "fresh" in parameters and not force_refresh:
                        raise ValueError("invalid profile parameters")
                    payload = cached_yahoo_payload(
                        self.server,
                        ("profile", symbol, 0),
                        YAHOO_PROFILE_CACHE_SECONDS,
                        lambda: fetch_yahoo_payload(
                            "profile",
                            symbol,
                            0,
                            self.server.fetch_timeout_seconds,
                        ),
                        force_refresh,
                    )
                else:
                    if not set(parameters).issubset({"symbol", "limit", "fresh"}):
                        raise ValueError("invalid earnings parameters")
                    force_refresh = parameters.get("fresh", [""])[0] == "1"
                    if "fresh" in parameters and not force_refresh:
                        raise ValueError("invalid earnings parameters")
                    try:
                        limit = int(parameters.get("limit", ["24"])[0])
                    except ValueError as error:
                        raise ValueError("invalid earnings limit") from error
                    if not (1 <= limit <= MAX_YAHOO_EARNINGS):
                        raise ValueError("invalid earnings limit")
                    payload = cached_yahoo_payload(
                        self.server,
                        ("earnings", symbol, limit),
                        YAHOO_EARNINGS_CACHE_SECONDS,
                        lambda: fetch_yahoo_payload(
                            "earnings",
                            symbol,
                            limit,
                            self.server.fetch_timeout_seconds,
                        ),
                        force_refresh,
                    )
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            except TimeoutError:
                self.send_json(HTTPStatus.GATEWAY_TIMEOUT, {"error": "upstream_timeout"})
                return
            except Exception:
                self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "upstream_error"})
                return
            self.send_json(HTTPStatus.OK, payload)
            return

        if parsed.path != "/v1/bars":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self.authenticated():
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        parameters = parse_qs(parsed.query, keep_blank_values=False)
        symbol = parameters.get("symbol", [""])[0].strip().upper()
        exchange = parameters.get("exchange", [""])[0].strip().upper()
        interval = parameters.get("interval", [""])[0].strip()
        requested_range = parameters.get("range", [""])[0].strip()
        try:
            count = int(parameters.get("count", ["0"])[0])
        except ValueError:
            count = 0

        if (
            not SYMBOL_PATTERN.fullmatch(symbol)
            or exchange not in ALLOWED_EXCHANGES
            or interval not in INTERVAL_TO_TRADINGVIEW
            or requested_range not in ALLOWED_RANGES
            or count < MIN_CANDLE_COUNT
            or count > MAX_CANDLE_COUNT
        ):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
            return

        try:
            items = fetch_bars(
                exchange,
                symbol,
                interval,
                count,
                self.server.fetch_timeout_seconds,
            )
        except TimeoutError:
            self.send_json(HTTPStatus.GATEWAY_TIMEOUT, {"error": "upstream_timeout"})
            return
        except Exception:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "upstream_error"})
            return

        self.send_json(
            HTTPStatus.OK,
            {
                "schemaVersion": SCHEMA_VERSION,
                "symbol": symbol,
                "exchange": exchange,
                "sourceSymbol": f"{exchange}:{symbol}",
                "interval": interval,
                "range": requested_range,
                "requestedCount": count,
                "returnedCount": len(items),
                "items": items,
                "asOf": items[-1]["time"],
                "ingestedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
        )

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        if parsed.path not in {
            "/v1/indicators/calculate",
            "/v1/research/usaspending",
            "/v1/latest-closes",
            "/v1/latest-closes/stream",
            "/v1/realtime-quotes",
            "/v1/realtime-quotes/stream",
        }:
            self.close_connection = True
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if parsed.query:
            self.close_connection = True
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
            return
        if not self.authenticated():
            self.close_connection = True
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        if parsed.path == "/v1/indicators/calculate":
            if not self.server.auth_token:
                self.close_connection = True
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            if not TALIB_CAPACITY.acquire(blocking=False):
                self.close_connection = True
                self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "capacity"})
                return
            try:
                self.connection.settimeout(20.0)
                payload = self.read_json_body(3_000_000)
                result = local_research_module("talib_indicators").calculate(payload)
                self.send_json(HTTPStatus.OK, result)
            except (ValueError, TypeError):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
            except Exception:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "talib_unavailable"})
            finally:
                TALIB_CAPACITY.release()
            return

        if parsed.path == "/v1/research/usaspending":
            if not self.server.auth_token:
                self.close_connection = True
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            request_payload = self.read_json_body(1_024)
            try:
                result = fetch_usaspending_awards(request_payload)
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            except TimeoutError:
                self.send_json(HTTPStatus.GATEWAY_TIMEOUT, {"error": "upstream_timeout"})
                return
            except Exception:
                self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "upstream_error"})
                return
            self.send_json(HTTPStatus.OK, {
                "schemaVersion": "trader.usaspending.v1",
                "recipient": request_payload["recipient"].strip(),
                "endDate": request_payload["endDate"],
                "payload": result,
            })
            return

        if parsed.path == "/v1/latest-closes/stream":
            try:
                symbols = parse_latest_close_symbols(self.read_json_body())
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            self.send_latest_close_stream(symbols)
            return

        if parsed.path in {"/v1/realtime-quotes", "/v1/realtime-quotes/stream"}:
            try:
                realtime_items = parse_realtime_items(
                    self.read_json_body(MAX_REALTIME_BODY_BYTES)
                )
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            if parsed.path == "/v1/realtime-quotes/stream":
                self.send_realtime_stream(realtime_items)
                return
            try:
                snapshot, state = self.server.realtime_quotes.wait_for_snapshot(
                    realtime_items,
                    self.client_address[0],
                    min(5.0, self.server.fetch_timeout_seconds),
                )
            except RealtimeSubscriptionError as error:
                self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": error.code})
                return
            self.send_json(
                HTTPStatus.OK,
                {
                    "schemaVersion": REALTIME_SCHEMA_VERSION,
                    "state": state,
                    "items": snapshot,
                    "ingestedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                },
            )
            return

        try:
            symbols = parse_latest_close_symbols(self.read_json_body())
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
            return

        try:
            values = fetch_latest_closes(
                symbols,
                self.server.latest_close_exchanges,
                self.server.fetch_timeout_seconds,
            )
        except TimeoutError:
            self.send_json(HTTPStatus.GATEWAY_TIMEOUT, {"error": "upstream_timeout"})
            return
        except Exception:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "upstream_error"})
            return

        ingested_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        items = []
        for symbol in symbols:
            value = values.get(symbol)
            if value and not continuous_reference_is_fresh(str(value.get("updatedAt", ""))):
                value = None
            items.append(
                {
                    "symbol": symbol,
                    "sourceSymbol": (
                        value["sourceSymbol"]
                        if value
                        else f"{self.server.latest_close_exchanges[0]}:{symbol}USDT.P"
                    ),
                    "close": value["close"] if value else None,
                    "currency": "USDT",
                    "source": "tradingview-websocket",
                    "updatedAt": value["updatedAt"] if value else None,
                }
            )
        self.send_json(
            HTTPStatus.OK,
            {
                "schemaVersion": SCHEMA_VERSION,
                "exchange": self.server.latest_close_exchanges[0],
                "exchanges": list(self.server.latest_close_exchanges),
                "resolutionStrategy": "ordered_fallback",
                "items": items,
                "ingestedAt": ingested_at,
            },
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Trader Market data provider websocket sidecar")
    parser.add_argument("--host", default=os.environ.get("TRADER_TRADINGVIEW_SIDECAR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("TRADER_TRADINGVIEW_SIDECAR_PORT", "8791")))
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("TRADER_TRADINGVIEW_FETCH_TIMEOUT_SECONDS", "20")),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    token = os.environ.get("TRADER_TRADINGVIEW_SIDECAR_TOKEN", "").strip()
    if args.host not in {"127.0.0.1", "::1", "localhost"} and not token:
        raise SystemExit("A sidecar token is required when binding outside loopback")
    if not (1 <= args.port <= 65_535):
        raise SystemExit("Port must be between 1 and 65535")
    timeout_seconds = min(60.0, max(2.0, args.timeout))
    try:
        latest_close_exchanges = configured_latest_close_exchanges(
            os.environ.get("TRADER_TRADINGVIEW_SYNTHETIC_EXCHANGES")
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error

    server = TradingViewSidecarServer(
        (args.host, args.port),
        token,
        timeout_seconds,
        latest_close_exchanges,
    )
    sys.stderr.write(f"tradingview-sidecar listening on {args.host}:{args.port}\n")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
