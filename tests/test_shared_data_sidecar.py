"""The real shared-data HTTP handler; all data reads are isolated test doubles."""

import http.client
import importlib.util
import json
from pathlib import Path
import threading
import types
import unittest
from unittest.mock import Mock, patch


SIDECAR_PATH = Path(__file__).resolve().parents[1] / "api/tradingview-websocket/sidecar.py"
SIDECAR_SPEC = importlib.util.spec_from_file_location("trader_shared_http_test", SIDECAR_PATH)
sidecar = importlib.util.module_from_spec(SIDECAR_SPEC)
SIDECAR_SPEC.loader.exec_module(sidecar)
ORIGINAL_LOG_MESSAGE = sidecar.TradingViewSidecarHandler.log_message
READER_SPEC = importlib.util.spec_from_file_location("trader_shared_reader_http_test", SIDECAR_PATH.with_name("shared_data.py"))
reader = importlib.util.module_from_spec(READER_SPEC)
READER_SPEC.loader.exec_module(reader)
TOKEN = "shared-http-test-only-token"


def envelope(dataset="x-mentions"):
    return {
        "schemaVersion": "trader.shared-data.v1", "dataset": dataset, "status": "ok",
        "rows": [{"symbol": "AAPL", "published_at": "2025-01-01T00:00:00Z", "available_to_hermes_at": "2025-01-02T00:00:00Z",
                  "judgment_updated_at": "2025-01-03T00:00:00Z", "market_value": None, "is_backfill": 1}],
        "columns": [{"key": "symbol", "label": "symbol", "nullable": True}],
        "source": {"id": "x-finance", "kind": "shared-store", "storage": "finance/x/state/producer.sqlite", "access": "read-only-sqlite"},
        "provenance": {"revision": "20260906T120000.000000Z-1234abcd", "publishedAt": "2026-09-06T12:00:00Z",
                       "readAt": "2026-09-06T13:00:00Z", "databaseMutable": True, "consistencyModel": "live-wal-progressive"},
        "coverage": {"status": "partial", "returned": 1, "pointInTimeComplete": False},
        "pagination": {"limit": 100, "nextCursor": "test-cursor", "hasMore": True, "order": "storage-rowid-desc"},
        "warnings": ["Mutable producer state; retain publication and ingestion timestamps separately."],
    }


class SharedDataSidecarHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Port zero asks the OS for a temporary port. The user-owned 3001 server
        # and actual shared finance store are never touched by this suite.
        cls.server = sidecar.TradingViewSidecarServer(("127.0.0.1", 0), TOKEN, 5.0, ("NASDAQ",))
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def setUp(self):
        self.calls = []

        def load(dataset, query):
            # Run the actual reader's pure validation, without resolving paths,
            # opening SQLite or making external requests.
            reader._validate_query(dataset, query)
            self.calls.append((dataset, query))
            return envelope(dataset)

        self.module = types.SimpleNamespace(load_dataset=Mock(side_effect=load))
        self.loader_patch = patch.object(sidecar, "local_research_module", return_value=self.module)
        self.loader = self.loader_patch.start()
        self.addCleanup(self.loader_patch.stop)
        self.log_patch = patch.object(sidecar.TradingViewSidecarHandler, "log_message")
        self.log_patch.start()
        self.addCleanup(self.log_patch.stop)

    def request(self, path, *, authorization=f"Bearer {TOKEN}", method="GET"):
        headers = {"Accept": "application/json"}
        if authorization is not None:
            headers["Authorization"] = authorization
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            connection.close()

    def test_native_envelope_dates_nulls_and_provenance_pass_through(self):
        with patch("sqlite3.connect", side_effect=AssertionError("no actual database access")), \
                patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("no network fetch")):
            status, headers, body = self.request("/v1/shared-data/x-mentions?symbol=AAPL&account=reader&limit=5&asOf=2026-09-06T00%3A00%3A00Z")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(body, envelope())
        self.loader.assert_called_once_with("shared_data")
        self.assertEqual(self.calls, [("x-mentions", {"symbol": "AAPL", "account": "reader", "limit": "5", "asOf": "2026-09-06T00:00:00Z"})])

    def test_missing_or_invalid_auth_never_loads_module(self):
        self.loader.side_effect = AssertionError("auth must run before loading")
        for authorization in (None, "Bearer incorrect", "Basic ignored", f"Bearer {TOKEN}suffix"):
            with self.subTest(authorization=authorization):
                status, _, body = self.request("/v1/shared-data/x-posts?root=%2Fprivate", authorization=authorization)
                self.assertEqual((status, body), (401, {"error": "unauthorized"}))
        self.loader.assert_not_called()

    def test_no_configured_token_disables_even_loopback_and_supplied_token(self):
        self.loader.side_effect = AssertionError("unconfigured auth must fail closed")
        with patch.object(self.server, "auth_token", ""):
            for authorization in (None, f"Bearer {TOKEN}"):
                self.assertEqual(self.request("/v1/shared-data/x-posts", authorization=authorization)[0], 401)
        self.loader.assert_not_called()

    def test_duplicate_params_invalid_route_and_oversized_query_fail_before_loading(self):
        self.loader.side_effect = AssertionError("transport validation first")
        for path in (
            "/v1/shared-data/x-posts?limit=1&limit=2",
            "/v1/shared-data/x-posts?symbol=AAPL&symbol=MSFT",
            "/v1/shared-data/x-posts?%6cimit=1&limit=2",
            "/v1/shared-data/../x-posts",
            "/v1/shared-data/x-posts/extra",
            "/v1/shared-data/x-posts?cursor=" + "a" * 4097,
            "/v1/shared-data/x-posts?x=" + "a" * 8200,
        ):
            with self.subTest(path=path[:100]):
                self.assertEqual(self.request(path)[0], 400)
        self.loader.assert_not_called()

    def test_unknown_parameters_and_invalid_values_retain_reader_errors(self):
        for path in (
            "/v1/shared-data/x-posts?sql=SELECT",
            "/v1/shared-data/x-posts?root=%2Fprivate",
            "/v1/shared-data/x-posts?limit=",
            "/v1/shared-data/x-posts?from=2026-02-30",
            "/v1/shared-data/x-prices",
        ):
            with self.subTest(path=path):
                status, _, body = self.request(path)
                self.assertEqual((status, body), (400, {"error": "invalid_shared_query"}))
        self.assertEqual(self.calls, [])
        status, _, body = self.request("/v1/shared-data/missing-dataset")
        self.assertEqual((status, body), (404, {"error": "shared_dataset_not_found"}))

    def test_publication_cursor_and_timeout_codes_and_statuses_are_retained(self):
        for code, expected_status in (("shared_publication_uncommitted", 409), ("shared_schema_mismatch", 409),
                                      ("shared_cursor_revision_changed", 409), ("shared_query_timeout", 504),
                                      ("shared_data_unavailable", 503)):
            with self.subTest(code=code):
                self.module.load_dataset.side_effect = reader.SharedDataError(code, "/private/path must never be sent", expected_status)
                status, _, body = self.request("/v1/shared-data/x-posts")
                self.assertEqual(status, expected_status)
                self.assertEqual(body, {"error": code})
                self.assertNotIn("private", json.dumps(body))

    def test_unexpected_exceptions_and_unsafe_error_codes_are_sanitized(self):
        failures = [RuntimeError("secret /private/db.sqlite " + TOKEN),
                    reader.SharedDataError("private/path?token=" + TOKEN, "secret", 500),
                    reader.SharedDataError("UPPERCASE_UNSAFE", "secret", 200)]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                self.module.load_dataset.side_effect = failure
                status, _, body = self.request("/v1/shared-data/x-posts")
                self.assertEqual((status, body), (503, {"error": "unavailable"}))

    def test_capacity_429_precedes_loading_and_is_restored_after_failures(self):
        acquired = []
        try:
            for _ in range(4):
                self.assertTrue(sidecar.SHARED_DATA_CAPACITY.acquire(blocking=False))
                acquired.append(True)
            status, _, body = self.request("/v1/shared-data/x-posts")
            self.assertEqual((status, body), (429, {"error": "capacity"}))
            self.loader.assert_not_called()
        finally:
            for _ in acquired:
                sidecar.SHARED_DATA_CAPACITY.release()
        self.module.load_dataset.side_effect = reader.SharedDataError("shared_publication_uncommitted", "not ready", 409)
        for _ in range(5):
            self.assertEqual(self.request("/v1/shared-data/x-posts")[0], 409)
        self.module.load_dataset.side_effect = None
        self.module.load_dataset.return_value = envelope("x-posts")
        self.assertEqual(self.request("/v1/shared-data/x-posts")[0], 200)

    def test_oversized_envelope_and_nonfinite_json_are_not_sent(self):
        self.module.load_dataset.side_effect = None
        self.module.load_dataset.return_value = {**envelope(), "too_large": "a" * (8 * 1024 * 1024)}
        status, _, body = self.request("/v1/shared-data/x-mentions")
        self.assertEqual((status, body), (502, {"error": "invalid_response"}))
        self.module.load_dataset.return_value = {**envelope(), "nonfinite": float("inf")}
        status, _, body = self.request("/v1/shared-data/x-mentions")
        self.assertEqual((status, body), (503, {"error": "unavailable"}))

    def test_request_logging_does_not_include_token_or_query_values(self):
        # Exercise the actual log_message implementation separately from the
        # per-request log stub; no request path or data-root value is printed.
        handler = object.__new__(sidecar.TradingViewSidecarHandler)
        handler.client_address = ("127.0.0.1", 12345)
        handler.command = "GET"
        handler.path = "/v1/shared-data/x-posts?cursor=private-cursor&root=%2Fprivate"
        with patch.object(sidecar.sys.stderr, "write") as write:
            ORIGINAL_LOG_MESSAGE(handler, "ignored %s", TOKEN)
        message = "".join(call.args[0] for call in write.call_args_list)
        self.assertEqual(message, "tradingview-sidecar 127.0.0.1 GET /v1/shared-data/x-posts\n")


if __name__ == "__main__":
    unittest.main()
