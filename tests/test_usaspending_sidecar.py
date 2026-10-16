"""Helper tests; root can point MODULE_PATH at the integrated sidecar module."""

import importlib.util
import io
import json
import os
import unittest
import threading
import http.client
from http.server import ThreadingHTTPServer
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch


MODULE_PATH = Path(os.environ.get("TRADER_USASPENDING_TEST_MODULE", str(Path(__file__).resolve().parents[1] / "api" / "tradingview-websocket" / "sidecar.py")))
spec = importlib.util.spec_from_file_location("trader_usaspending_test", MODULE_PATH)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class Response:
    def __init__(self, body=None, code=200, url=None, headers=None):
        self.body = io.BytesIO(body if body is not None else json.dumps({"spending_level": "awards", "results": [], "page_metadata": {"page": 1, "hasNext": False}}).encode())
        self.code = code
        self.url = url or helper.USASPENDING_AWARDS_URL
        self.headers = headers or {}
        self.closed = False
        self.read_sizes = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True

    def getcode(self):
        return self.code

    def geturl(self):
        return self.url

    def read(self, size):
        self.read_sizes.append(size)
        return self.body.read(size)

    read1 = read


class Opener:
    def __init__(self, response=None, error=None):
        self.response = response or Response()
        self.error = error
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if self.error:
            raise self.error
        return self.response


class UsaspendingTransportTests(unittest.TestCase):
    def setUp(self):
        self.payload = {"recipient": "LOCKHEED MARTIN", "endDate": "2026-01-01"}

    def test_fixed_endpoint_and_bounded_post_match_typescript_adapter(self):
        opener = Opener()
        result = helper.fetch_usaspending_awards(self.payload, opener=opener)
        self.assertEqual(result["results"], [])
        self.assertEqual(len(opener.calls), 1)
        request, timeout = opener.calls[0]
        self.assertEqual(request.full_url, "https://api.usaspending.gov/api/v2/search/spending_by_award/")
        self.assertEqual(request.method, "POST")
        self.assertEqual(timeout, 12)
        body = json.loads(request.data)
        self.assertEqual(body["filters"], {"time_period": [{"start_date": "2025-01-01", "end_date": "2026-01-01"}], "award_type_codes": ["A", "B", "C", "D"], "recipient_search_text": ["LOCKHEED MARTIN"]})
        self.assertEqual(body["limit"], 50)
        self.assertEqual(body["page"], 1)
        self.assertEqual(body["sort"], "Last Modified Date")
        self.assertEqual(body["order"], "desc")
        self.assertFalse(body["subawards"])
        self.assertEqual(body["fields"], ["Award ID", "Recipient Name", "Recipient UEI", "Award Amount", "Awarding Agency", "Start Date", "Last Modified Date", "generated_internal_id"])
        self.assertTrue(opener.response.closed)

    def test_strict_input_keys_dates_and_recipient_before_network(self):
        tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).date().isoformat()
        invalid = [None, [], {}, {"recipient": "ACME"}, {**self.payload, "endpoint": "https://attacker.example"},
                   {**self.payload, "recipient": "x"}, {**self.payload, "recipient": "A" * 121},
                   {**self.payload, "recipient": "ACME\n"}, {**self.payload, "recipient": "AC\x7fME"},
                   {**self.payload, "recipient": 123}, {**self.payload, "endDate": "2026-02-30"},
                   {**self.payload, "endDate": "2026-1-01"}, {**self.payload, "endDate": "2008-09-30"},
                   {**self.payload, "endDate": tomorrow}]
        for payload in invalid:
            with self.subTest(payload=payload):
                opener = Opener()
                with self.assertRaises(ValueError):
                    helper.fetch_usaspending_awards(payload, opener=opener)
                self.assertEqual(opener.calls, [])

    def test_deadline_is_clamped_and_invalid_numeric_timeouts_rejected(self):
        for proposed, expected in [(500, 12), (0.01, 1), (2.5, 2.5)]:
            opener = Opener()
            helper.fetch_usaspending_awards(self.payload, timeout_seconds=proposed, opener=opener)
            self.assertEqual(opener.calls[0][1], expected)
        for timeout in [float("nan"), float("inf"), True, "12"]:
            with self.assertRaises(ValueError):
                helper.fetch_usaspending_awards(self.payload, timeout_seconds=timeout, opener=Opener())

    def test_redirect_handler_refuses_following_and_response_destination_is_verified(self):
        handler = helper._UsaspendingNoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "redirect", {}, "https://attacker.example"))
        for response in [Response(code=302), Response(url="https://attacker.example"), Response(url=helper.USASPENDING_AWARDS_URL + "other")]:
            with self.assertRaisesRegex(RuntimeError, "^USAspending unavailable\\.$"):
                helper.fetch_usaspending_awards(self.payload, opener=Opener(response))
            self.assertTrue(response.closed)

    def test_default_opener_installs_no_redirect_handler(self):
        opener = Opener()
        with patch.object(helper, "build_opener", return_value=opener) as build:
            helper.fetch_usaspending_awards(self.payload)
        self.assertIsInstance(build.call_args.args[0], helper._UsaspendingNoRedirect)

    def test_response_size_is_bounded_even_without_content_length(self):
        for response in [Response(headers={"Content-Length": "2000001"}), Response(body=b" " * 2_000_001), Response(headers={"Content-Length": "invalid"})]:
            with self.assertRaises(RuntimeError):
                helper.fetch_usaspending_awards(self.payload, opener=Opener(response))
            self.assertTrue(response.closed)
            self.assertTrue(all(size <= 65_536 for size in response.read_sizes))
        exact = json.dumps({"spending_level": "awards", "results": []}).encode()
        response = Response(body=exact + b" " * (2_000_000 - len(exact)))
        self.assertEqual(helper.fetch_usaspending_awards(self.payload, opener=Opener(response))["results"], [])

    def test_non_json_invalid_constants_and_wrong_envelope_are_rejected(self):
        for body in [b"<html>blocked secret</html>", b"[]", b"{}", b' {"spending_level":"awards","results":[],"x":NaN}',
                     b'{"spending_level":"subawards","results":[]}', b'\xff',
                     json.dumps({"spending_level": "awards", "results": [{}] * 51}).encode()]:
            with self.assertRaisesRegex(RuntimeError, "^USAspending unavailable\\.$"):
                helper.fetch_usaspending_awards(self.payload, opener=Opener(Response(body=body)))

    def test_timeout_and_upstream_errors_do_not_expose_upstream_details(self):
        with self.assertRaisesRegex(TimeoutError, "^USAspending timeout\\.$"):
            helper.fetch_usaspending_awards(self.payload, opener=Opener(error=TimeoutError("secret")))
        error = HTTPError("https://attacker.example/secret", 403, "secret", {}, None)
        with self.assertRaisesRegex(RuntimeError, "^USAspending unavailable\\.$"):
            helper.fetch_usaspending_awards(self.payload, opener=Opener(error=error))
        with patch.object(helper.time, "monotonic", side_effect=[0, 13]):
            with self.assertRaisesRegex(TimeoutError, "^USAspending timeout\\.$"):
                helper.fetch_usaspending_awards(self.payload, opener=Opener())


class AuthenticatedHandlerTests(unittest.TestCase):
    def test_token_required_and_request_bound_to_fixed_dataset(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), helper.TradingViewSidecarHandler)
        server.auth_token = "test-only-token"
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        payload = {"recipient": "LOCKHEED MARTIN", "endDate": "2026-09-04"}
        try:
            with patch.object(helper, "fetch_usaspending_awards", return_value={"spending_level": "awards", "results": []}) as fetcher:
                for token, expected in [(None, 401), ("wrong", 401), ("test-only-token", 200)]:
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                    headers = {"Content-Type": "application/json"}
                    if token:
                        headers["Authorization"] = "Bearer " + token
                    connection.request("POST", "/v1/research/usaspending", json.dumps(payload), headers)
                    response = connection.getresponse()
                    result = json.loads(response.read())
                    self.assertEqual(response.status, expected)
                    if expected == 200:
                        self.assertEqual(result["schemaVersion"], "trader.usaspending.v1")
                        self.assertEqual(result["recipient"], payload["recipient"])
                    connection.close()
                fetcher.assert_called_once_with(payload)
            server.auth_token = ""
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            connection.request("POST", "/v1/research/usaspending", json.dumps(payload), {"Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 401)
            response.read()
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
