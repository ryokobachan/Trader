import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("financial_history", Path(__file__).resolve().parents[1] / "api/tradingview-websocket/financial_history.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def frame(event):
    body = json.dumps(event, separators=(",", ":"))
    return f"~m~{len(body)}~m~{body}"


class FakeSocket:
    def __init__(self, listing="NASDAQ:AAPL", complete=True):
        self.listing = listing
        self.complete = complete
        self.sent = []
        self.closed = False
        self.frames = []

    def send(self, body):
        self.sent.append(body)
        if '"quote_create_session"' in body:
            self.session = json.loads(body.split("~m~", 2)[2])["p"][0]
        if '"quote_add_symbols"' in body:
            event = frame({"m": "qsd", "p": [self.session, {"n": self.listing, "s": "ok", "v": {
                "currency_code": "USD", "fundamental_currency_code": "USD", "fiscal_period_fq_h": ["2026-Q3"],
                "cash_f_operating_activities_fq_h": [0], "cash_f_investing_activities_fq_h": [-20],
            }}]})
            # A frame can be split across reads, and completion can share a read.
            self.frames = [event[:9], event[9:] + (frame({"m": "quote_completed", "p": [self.session, self.listing]}) if self.complete else "")]

    def recv(self):
        if self.frames:
            return self.frames.pop(0)
        raise TimeoutError("idle")

    def settimeout(self, _timeout):
        pass

    def close(self, **_kwargs):
        self.closed = True


class FinancialHistoryTests(unittest.TestCase):
    def run_fetch(self, socket):
        transport = types.SimpleNamespace(create_connection=lambda *args, **kwargs: socket, WebSocketTimeoutException=TimeoutError)
        with patch.dict(sys.modules, {"websocket": transport}):
            return module.fetch_financial_history("AAPL", "XNAS", timeout_seconds=0.02)

    def test_validates_exact_listing_and_restricts_fields(self):
        for symbol, mic in [("../AAPL", "XNAS"), ("AAPL", "UNKNOWN"), ("AAPL USD", "XNAS"), ("aapl", "XNAS")]:
            with self.assertRaises(ValueError):
                module.source_symbol(symbol, mic)
        self.assertEqual(module.source_symbol("BRK-B", "XNYS"), "NYSE:BRK.B")
        result = module.clean_values({"fiscal_period_fq_h": ["2026-Q3", None], "cash_f_operating_activities_fq_h": [0, -20, True, float("inf")], "unrequested": [123]})
        self.assertNotIn("unrequested", result)
        self.assertEqual(result["cash_f_operating_activities_fq_h"], [0, -20, None, None])
        self.assertEqual(module.clean_values({"fiscal_period_fq_h": ["2025-Q1"] * 41}), {})

    def test_bounded_quote_session_preserves_zero_signs_and_closes(self):
        socket = FakeSocket()
        result = self.run_fetch(socket)
        self.assertEqual(result["sourceSymbol"], "NASDAQ:AAPL")
        self.assertEqual(result["values"]["cash_f_operating_activities_fq_h"], [0])
        self.assertEqual(result["values"]["cash_f_investing_activities_fq_h"], [-20])
        self.assertTrue(socket.closed)
        self.assertTrue(any('"quote_set_fields"' in item for item in socket.sent))

    def test_wrong_listing_and_incomplete_response_fail_and_close(self):
        wrong = FakeSocket(listing="NYSE:AAPL")
        with self.assertRaises(ValueError):
            self.run_fetch(wrong)
        self.assertTrue(wrong.closed)
        incomplete = FakeSocket(complete=False)
        with self.assertRaises(TimeoutError):
            self.run_fetch(incomplete)
        self.assertTrue(incomplete.closed)

    def test_response_bound_applies_before_json_parsing(self):
        socket = FakeSocket()
        with patch.object(module, "MAX_BYTES", 30):
            with self.assertRaises(ValueError):
                self.run_fetch(socket)
        self.assertTrue(socket.closed)


if __name__ == "__main__":
    unittest.main()
