"""Bounded, read-only TradingView financial quote session; no local archive."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import re
import secrets
import time

SCHEMA_VERSION = "trader.tradingview-financials.v1"
MAX_BYTES = 2_000_000
MAX_PERIODS = 40
EXCHANGES = {"XNAS": "NASDAQ", "XNYS": "NYSE", "XASE": "AMEX", "ARCX": "AMEX", "BATS": "CBOE"}
STATEMENTS = (
    "total_revenue", "gross_profit", "oper_income", "ebitda", "net_income",
    "earnings_per_share_diluted", "research_and_dev", "sell_gen_admin_exp_other",
    "total_assets", "total_liabilities", "total_debt", "net_debt", "total_equity",
    "cash_n_short_term_invest", "cash_f_operating_activities", "capital_expenditures",
    "free_cash_flow", "cash_f_investing_activities", "cash_f_financing_activities",
)
FIELDS = (
    "currency_code", "fundamental_currency_code", "fiscal_period_fy_h", "fiscal_period_fq_h",
    "fiscal_period_end_fy_h", "fiscal_period_end_fq_h",
    *(f"{field}_{period}_h" for period in ("fy", "fq") for field in STATEMENTS),
    "earnings_fiscal_period_fq_h", "earnings_release_date_fq_h", "earnings_per_share_fq_h",
    "earnings_per_share_forecast_fq_h", "revenue_fq_h", "revenue_forecast_fq_h",
)


def source_symbol(symbol: str, mic: str) -> str:
    if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)?", symbol) or len(symbol) > 10 or mic not in EXCHANGES:
        raise ValueError("invalid financial listing")
    return f"{EXCHANGES[mic]}:{symbol.replace('-', '.')}"


def clean_values(values: dict) -> dict:
    result = {}
    for field in FIELDS:
        value = values.get(field)
        if field in ("currency_code", "fundamental_currency_code"):
            if isinstance(value, str) and re.fullmatch(r"[A-Z]{3}", value):
                result[field] = value
        elif isinstance(value, list) and len(value) <= MAX_PERIODS:
            # Keep positions and nulls; never shift a shorter series.
            result[field] = [item if item is None or isinstance(item, str) and len(item) <= 20
                             or type(item) in (int, float) and math.isfinite(item) else None for item in value]
    return result


def fetch_financial_history(symbol: str, mic: str, timeout_seconds: float = 12.0) -> dict:
    import websocket

    source = source_symbol(symbol, mic)
    if not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 20:
        raise ValueError("invalid financial timeout")
    deadline = time.monotonic() + timeout_seconds
    ws = websocket.create_connection("wss://data.tradingview.com/socket.io/websocket",
                                     timeout=min(5.0, timeout_seconds), origin="https://data.tradingview.com")
    session = f"qs_trader_{secrets.token_hex(6)}"
    values = {}
    total_bytes = 0
    buffer = ""

    def send(method, params):
        body = json.dumps({"m": method, "p": params}, separators=(",", ":"))
        ws.send(f"~m~{len(body)}~m~{body}")

    try:
        send("set_auth_token", ["unauthorized_user_token"])
        send("quote_create_session", [session])
        send("quote_set_fields", [session, *FIELDS])
        send("quote_add_symbols", [session, source])
        while time.monotonic() < deadline:
            ws.settimeout(min(1.0, max(0.001, deadline - time.monotonic())))
            try:
                raw = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if not isinstance(raw, str) or not raw:
                raise ValueError("invalid financial frame")
            total_bytes += len(raw.encode("utf-8"))
            if total_bytes > MAX_BYTES:
                raise ValueError("financial response exceeds limit")
            buffer += raw
            while buffer:
                header = re.match(r"~m~(\d{1,7})~m~", buffer)
                if not header:
                    if len(buffer) > 16:
                        raise ValueError("invalid financial frame")
                    break
                length = int(header[1])
                if length > MAX_BYTES:
                    raise ValueError("financial response exceeds limit")
                end = header.end() + length
                if len(buffer) < end:
                    break
                body, buffer = buffer[header.end():end], buffer[end:]
                if body.startswith("~h~"):
                    ws.send(f"~m~{len(body)}~m~{body}")
                    continue
                event = json.loads(body)
                if not isinstance(event, dict):
                    raise ValueError("invalid financial event")
                params = event.get("p", [])
                if event.get("m") == "qsd" and len(params) == 2 and params[0] == session:
                    item = params[1]
                    if not isinstance(item, dict) or item.get("n") != source or item.get("s") != "ok" or not isinstance(item.get("v"), dict):
                        raise ValueError("invalid financial listing response")
                    values.update(clean_values(item["v"]))
                elif event.get("m") == "quote_completed" and params == [session, source]:
                    return {"schemaVersion": SCHEMA_VERSION, "sourceSymbol": source,
                            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "values": values}
                elif event.get("m") in ("critical_error", "protocol_error", "quote_error"):
                    raise ValueError("financial upstream unavailable")
        raise TimeoutError("financial request timed out")
    finally:
        ws.close(timeout=0)
