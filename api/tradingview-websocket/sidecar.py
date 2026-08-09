#!/usr/bin/env python3
"""Local OHLCV bridge backed by ``tradingview-websocket``.

This process is deliberately separate from the Vinext/Cloudflare runtime:
Cloudflare Workers cannot import CPython packages.  Unicorn talks to this
sidecar through a small, versioned HTTP contract and can replace it with a
licensed market-data service without changing the browser UI.

The upstream package has no request timeout.  Each websocket fetch therefore
runs in an isolated child process which is terminated when the configured
deadline is reached.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import queue
import re
import sys
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit


SCHEMA_VERSION = "unicorn.tradingview-sidecar.v1"
MIN_CANDLE_COUNT = 2
MAX_CANDLE_COUNT = 10_000
MAX_LATEST_CLOSE_SYMBOLS = 50
MAX_LATEST_CLOSE_BODY_BYTES = 8_192
SYMBOL_PATTERN = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")
SYNTHETIC_EXCHANGE_PATTERN = re.compile(r"^[A-Z][A-Z0-9._-]{0,14}$")
ALLOWED_EXCHANGES = frozenset({"NASDAQ", "NYSE", "AMEX", "CBOE"})
DEFAULT_LATEST_CLOSE_EXCHANGES = ("BINANCE", "BITGET", "KUCOIN", "MEXC")
MAX_LATEST_CLOSE_EXCHANGES = 8
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
        raise ValueError("UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES is invalid")
    return exchanges


def utc_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return None
    return parsed


def normalize_rows(result_data: Any) -> list[dict[str, float | str]]:
    if not isinstance(result_data, list):
        raise ValueError("TradingView returned an invalid series payload")
    rows: list[dict[str, float | str]] = []
    for entry in result_data:
        if not isinstance(entry, dict) or not isinstance(entry.get("v"), list):
            continue
        values = entry["v"]
        if len(values) < 5:
            continue
        timestamp = finite_number(values[0])
        open_value = finite_number(values[1])
        high_value = finite_number(values[2])
        low_value = finite_number(values[3])
        close_value = finite_number(values[4])
        volume_value = finite_number(values[5]) if len(values) > 5 else 0.0
        if None in (timestamp, open_value, high_value, low_value, close_value):
            continue
        rows.append(
            {
                "time": utc_iso(timestamp),
                "open": open_value,
                "high": high_value,
                "low": low_value,
                "close": close_value,
                "volume": volume_value or 0.0,
            }
        )
    rows.sort(key=lambda row: str(row["time"]))
    deduplicated = {str(row["time"]): row for row in rows}
    normalized = list(deduplicated.values())
    if not normalized:
        raise ValueError("TradingView returned no usable bars")
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
            raise TimeoutError("TradingView websocket timed out") from error
        raise RuntimeError("TradingView websocket exited without data") from error
    finally:
        process.join(2)
        if process.is_alive():
            process.terminate()
            process.join(2)
        result_queue.close()
        result_queue.join_thread()
    if not result.get("ok"):
        raise RuntimeError("TradingView websocket fetch failed")
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
            raise RuntimeError("TradingView websocket did not connect")
        resolution_window = min(8.0, max(2.0, timeout_seconds - 1.0))
        candidate_timeout = max(0.5, resolution_window / len(exchanges))
        # A short receive timeout gives silent/unsupported candidates a bounded
        # opportunity before the resolver advances to the next configured
        # exchange. TradingView normally emits symbol_error, but that signal is
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
                if close_value is not None and close_value > 0:
                    values[symbol] = {
                        "close": close_value,
                        "updatedAt": latest["time"],
                        "sourceSymbol": f"{exchanges[exchange_index]}:{symbol}USDT.P",
                    }
                pending.discard(symbol)
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
            raise TimeoutError("TradingView latest-close batch timed out") from error
        raise RuntimeError("TradingView latest-close batch exited without data") from error
    finally:
        process.join(2)
        if process.is_alive():
            process.terminate()
            process.join(2)
        result_queue.close()
        result_queue.join_thread()
    if not result.get("ok"):
        raise RuntimeError("TradingView latest-close batch failed")
    return result["values"]


class TradingViewSidecarServer(ThreadingHTTPServer):
    daemon_threads = True

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


class TradingViewSidecarHandler(BaseHTTPRequestHandler):
    server: TradingViewSidecarServer

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
        return self.headers.get("Authorization", "") == f"Bearer {token}"

    def read_json_body(self) -> dict[str, Any] | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if content_length <= 0 or content_length > MAX_LATEST_CLOSE_BODY_BYTES:
            return None
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
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
                },
            )
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
        if parsed.path != "/v1/latest-closes":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self.authenticated():
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        payload = self.read_json_body()
        raw_symbols = payload.get("symbols") if payload else None
        if (
            not isinstance(raw_symbols, list)
            or isinstance(raw_symbols, (str, bytes))
            or not (1 <= len(raw_symbols) <= MAX_LATEST_CLOSE_SYMBOLS)
        ):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
            return

        symbols: list[str] = []
        seen: set[str] = set()
        for value in raw_symbols:
            if not isinstance(value, str):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            symbol = value.strip().upper()
            if not SYMBOL_PATTERN.fullmatch(symbol) or symbol in seen:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            seen.add(symbol)
            symbols.append(symbol)

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
    parser = argparse.ArgumentParser(description="Unicorn TradingView websocket sidecar")
    parser.add_argument("--host", default=os.environ.get("UNICORN_TRADINGVIEW_SIDECAR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("UNICORN_TRADINGVIEW_SIDECAR_PORT", "8791")))
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("UNICORN_TRADINGVIEW_FETCH_TIMEOUT_SECONDS", "20")),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    token = os.environ.get("UNICORN_TRADINGVIEW_SIDECAR_TOKEN", "").strip()
    if args.host not in {"127.0.0.1", "::1", "localhost"} and not token:
        raise SystemExit("A sidecar token is required when binding outside loopback")
    if not (1 <= args.port <= 65_535):
        raise SystemExit("Port must be between 1 and 65535")
    timeout_seconds = min(60.0, max(2.0, args.timeout))
    try:
        latest_close_exchanges = configured_latest_close_exchanges(
            os.environ.get("UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES")
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
