"""Exercise the real authenticated TA-Lib HTTP endpoints on a temporary port."""

import http.client
import importlib.util
import json
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "trader_talib_http_test", Path(__file__).resolve().parents[1] / "api" / "tradingview-websocket" / "sidecar.py"
)
sidecar = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sidecar)
TOKEN = "trader-test-only-timestamp-contract"


def payload():
    return {"bars": [{"time": f"2026-01-0{day}", "open": day, "high": day + 1,
                      "low": day - 1, "close": day, "volume": 100} for day in range(1, 5)],
            "indicators": [{"id": "SMA", "parameters": {"timeperiod": 3}}, {"id": "CDLDOJI"}]}


class TalibSidecarHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = sidecar.TradingViewSidecarServer(("127.0.0.1", 0), TOKEN, 5.0, ("NASDAQ",))
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        cls.thread.start()
        cls.logging = patch.object(sidecar.TradingViewSidecarHandler, "log_message")
        cls.logging.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.logging.stop()

    def request(self, method, path, value=None, *, authorization=f"Bearer {TOKEN}", raw=None, extra_headers=None):
        headers = {"Content-Type": "application/json"}
        if authorization is not None:
            headers["Authorization"] = authorization
        if extra_headers:
            headers.update(extra_headers)
        body = raw if raw is not None else json.dumps(value).encode() if value is not None else None
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            connection.close()

    def test_authenticated_catalog_uses_installed_talib_without_an_upstream_request(self):
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("TA-Lib must not fetch data")):
            status, headers, body = self.request("GET", "/v1/indicators")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(body["engine"], "TA-Lib")
        self.assertEqual(len(body["indicators"]), 129)
        self.assertEqual(sum(row["group"] == "Pattern Recognition" for row in body["indicators"]), 61)

    def test_authenticated_calculation_preserves_time_strings_and_warmup_nulls(self):
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("TA-Lib must not fetch data")):
            status, headers, body = self.request("POST", "/v1/indicators/calculate", payload())
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(body["schemaVersion"], "trader.talib.v1")
        self.assertEqual(body["times"], [row["time"] for row in payload()["bars"]])
        self.assertEqual(body["barCount"], 4)
        self.assertEqual(body["results"][0]["series"][0]["values"], [None, None, 2.0, 3.0])
        self.assertEqual(body["results"][1]["series"][0]["values"], [None] * 4)
        json.dumps(body, allow_nan=False)

    def test_missing_and_invalid_authentication_never_reaches_calculation(self):
        with patch.object(sidecar, "local_research_module", side_effect=AssertionError("authentication first")):
            for authorization in [None, "Bearer incorrect", "Basic ignored"]:
                for method, path, value in [("GET", "/v1/indicators", None), ("POST", "/v1/indicators/calculate", payload())]:
                    with self.subTest(method=method, authorization=authorization):
                        status, _, body = self.request(method, path, value, authorization=authorization)
                        self.assertEqual(status, 401)
                        self.assertEqual(body, {"error": "unauthorized"})

    def test_unconfigured_token_does_not_enable_anonymous_computation(self):
        with patch.object(self.server, "auth_token", ""):
            for method, path, value in [("GET", "/v1/indicators", None), ("POST", "/v1/indicators/calculate", payload())]:
                self.assertEqual(self.request(method, path, value, authorization=None)[0], 401)

    def test_unknown_queries_payload_keys_and_native_parameter_ranges_return_400(self):
        self.assertEqual(self.request("GET", "/v1/indicators?source=remote")[0], 400)
        self.assertEqual(self.request("POST", "/v1/indicators/calculate?source=remote", payload())[0], 400)
        for value in [{**payload(), "source": "https://example.com"},
                      {**payload(), "indicators": [{"id": "SMA", "parameters": {"unknown": 1}}]},
                      {**payload(), "indicators": [{"id": "SMA", "parameters": {"timeperiod": 1}}]},
                      {**payload(), "indicators": [{"id": "SMA", "parameters": {"timeperiod": True}}]},
                      {**payload(), "bars": [{**payload()["bars"][0], "time": "2026-02-30"}]}]:
            with self.subTest(value=value):
                status, _, body = self.request("POST", "/v1/indicators/calculate", value)
                self.assertEqual(status, 400)
                self.assertEqual(body, {"error": "invalid_request"})

    def test_oversized_and_malformed_bodies_are_rejected_without_waiting_for_them(self):
        status, _, body = self.request("POST", "/v1/indicators/calculate", raw=b"{}", extra_headers={"Content-Length": "3000001"})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "invalid_request"})
        for raw in [b"{broken", b"[]", b"null", b"\xff"]:
            with self.subTest(raw=raw):
                self.assertEqual(self.request("POST", "/v1/indicators/calculate", raw=raw)[0], 400)

    def test_busy_capacity_returns_429_and_releases_after_invalid_requests(self):
        first = sidecar.TALIB_CAPACITY.acquire(blocking=False)
        second = sidecar.TALIB_CAPACITY.acquire(blocking=False)
        self.assertTrue(first and second)
        try:
            self.assertEqual(self.request("POST", "/v1/indicators/calculate", payload())[0], 429)
        finally:
            if second:
                sidecar.TALIB_CAPACITY.release()
            if first:
                sidecar.TALIB_CAPACITY.release()
        for _ in range(3):
            self.assertEqual(self.request("POST", "/v1/indicators/calculate", {})[0], 400)
        self.assertEqual(self.request("POST", "/v1/indicators/calculate", payload())[0], 200)

    def test_obsolete_option_archive_routes_are_absent(self):
        self.assertEqual(self.request("GET", "/v1/research/options?symbol=AAPL")[0], 404)
        self.assertEqual(self.request("POST", "/v1/research/options", {"snapshot": {}})[0], 404)


if __name__ == "__main__":
    unittest.main()
