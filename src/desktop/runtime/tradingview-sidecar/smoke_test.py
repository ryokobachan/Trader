#!/usr/bin/env python3
"""Exercise a frozen sidecar with a Python-free child environment."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SCHEMA_VERSION = "trader.tradingview-sidecar.v1"
YAHOO_SCHEMA_VERSION = "trader.yahoo-sidecar.v1"


def available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def request_json(
    base_url: str,
    path: str,
    token: str | None,
    timeout_seconds: float,
    body: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, separators=(",", ":")).encode()
    request = Request(f"{base_url}{path}", headers=headers, data=data)
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            status = response.status
            raw_body = response.read()
    except HTTPError as error:
        status = error.code
        raw_body = error.read()
    payload = json.loads(raw_body)
    if not isinstance(payload, dict):
        raise RuntimeError(f"{path} returned a non-object JSON payload")
    return status, payload


def wait_until_healthy(
    process: subprocess.Popen[str],
    base_url: str,
    token: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(
                f"sidecar exited with {process.returncode}: {stderr.strip()}"
            )
        try:
            status, payload = request_json(base_url, "/healthz", token, 1.0)
            if status == 200:
                return payload
        except (OSError, URLError, ValueError, json.JSONDecodeError) as error:
            last_error = error
        time.sleep(0.1)
    raise RuntimeError(f"sidecar health check timed out: {last_error}")


def validate_health(payload: dict[str, Any]) -> None:
    expected = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "ok",
        "backend": "tradingview-websocket",
        "maxCandles": 10_000,
        "realtimeQuotes": True,
        "realtimeSyntheticLatestCloses": True,
        "maxRealtimeSymbols": 50,
    }
    if payload != expected:
        raise RuntimeError(f"unexpected health payload: {payload!r}")


def validate_live_tradingview(
    base_url: str,
    token: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    path = "/v1/bars?symbol=AAPL&exchange=NASDAQ&interval=1d&range=5d&count=2"
    status, payload = request_json(base_url, path, token, timeout_seconds)
    if status != 200:
        raise RuntimeError(f"Market data provider smoke returned HTTP {status}: {payload!r}")
    items = payload.get("items")
    if (
        payload.get("schemaVersion") != SCHEMA_VERSION
        or payload.get("sourceSymbol") != "NASDAQ:AAPL"
        or payload.get("requestedCount") != 2
        or not isinstance(items, list)
        or not items
    ):
        raise RuntimeError(f"unexpected Market data provider payload: {payload!r}")
    return {
        "sourceSymbol": payload["sourceSymbol"],
        "returnedCount": len(items),
        "asOf": payload.get("asOf"),
    }


def validate_live_yfinance(
    base_url: str,
    token: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    status, payload = request_json(
        base_url,
        "/v1/yahoo/profile?symbol=AAPL",
        token,
        timeout_seconds,
    )
    if status != 200:
        raise RuntimeError(f"yfinance smoke returned HTTP {status}: {payload!r}")
    if (
        payload.get("schemaVersion") != YAHOO_SCHEMA_VERSION
        or payload.get("symbol") != "AAPL"
        or "profile" not in payload
        or not isinstance(payload.get("ingestedAt"), str)
    ):
        raise RuntimeError(f"unexpected yfinance payload: {payload!r}")
    profile = payload.get("profile")
    earnings_status, earnings_payload = request_json(
        base_url,
        "/v1/yahoo/earnings?symbol=AAPL&limit=2",
        token,
        timeout_seconds,
    )
    earnings = earnings_payload.get("earnings")
    if (
        earnings_status != 200
        or earnings_payload.get("schemaVersion") != YAHOO_SCHEMA_VERSION
        or earnings_payload.get("symbol") != "AAPL"
        or not isinstance(earnings, list)
    ):
        raise RuntimeError(
            f"unexpected yfinance earnings payload: {earnings_payload!r}"
        )
    return {
        "symbol": payload["symbol"],
        "profileFields": sorted(profile) if isinstance(profile, dict) else [],
        "earningsRows": len(earnings),
        "asOf": payload.get("asOf"),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--startup-timeout", type=float, default=30.0)
    parser.add_argument("--upstream-timeout", type=float, default=45.0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    binary = args.binary.resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise SystemExit(f"executable not found: {binary}")

    port = available_port()
    token = secrets.token_urlsafe(32)
    base_url = f"http://127.0.0.1:{port}"
    # Deliberately omit HOME and expose no usable PATH. Successful live child
    # workers therefore prove the frozen process does not shell out to Python.
    child_environment = {
        "PATH": "/nonexistent",
        "TRADER_TRADINGVIEW_SIDECAR_TOKEN": token,
    }
    process = subprocess.Popen(
        [
            str(binary),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--timeout",
            str(args.upstream_timeout),
        ],
        env=child_environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    summary: dict[str, Any] = {"binary": str(binary), "pythonFreePath": True}
    try:
        health = wait_until_healthy(
            process,
            base_url,
            token,
            args.startup_timeout,
        )
        validate_health(health)
        summary["health"] = "ok"

        unauthorized_status, unauthorized_payload = request_json(
            base_url,
            "/healthz",
            None,
            2.0,
        )
        if unauthorized_status != 401 or unauthorized_payload != {
            "error": "unauthorized"
        }:
            raise RuntimeError("health endpoint did not enforce bearer auth")
        summary["authentication"] = "ok"

        if args.live:
            summary["tradingview"] = validate_live_tradingview(
                base_url,
                token,
                args.upstream_timeout + 10.0,
            )
            summary["yfinance"] = validate_live_yfinance(
                base_url,
                token,
                args.upstream_timeout + 10.0,
            )

        if process.stdin is None:
            raise RuntimeError("sidecar stdin pipe was not created")
        process.stdin.close()
        return_code = process.wait(timeout=5)
        if return_code != 0:
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(
                f"sidecar did not exit cleanly on stdin EOF ({return_code}): "
                f"{stderr.strip()}"
            )
        summary["stdinEofShutdown"] = "ok"
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"smoke test failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
