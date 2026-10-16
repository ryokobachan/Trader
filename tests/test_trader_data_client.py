import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("trader_client_test", Path(__file__).resolve().parents[1] / "clients/python/trader_data.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ClientTests(unittest.TestCase):
    def test_paths_parameters_and_native_payload(self):
        client = module.TraderDataClient()
        value = {"rows": [{"value": None}], "coverage": {"status": "partial"}}
        with patch.object(client, "_request", return_value=value) as request:
            self.assertIs(client.get("bars", symbol="AAPL"), value)
            request.assert_called_once_with("/api/v1/data/bars", {"symbol": "AAPL"})
        for url in ["file:///tmp/data", "http://user:password@localhost", "http://localhost/path"]:
            with self.assertRaises(ValueError):
                module.TraderDataClient(url)

    def test_empty_page_with_cursor_is_not_exhaustion(self):
        client = module.TraderDataClient()
        pages = [{"rows": [], "pagination": {"nextCursor": "next"}}, {"rows": [{"value": None}], "pagination": {"nextCursor": None}}]
        with patch.object(client, "get", side_effect=pages) as getter:
            self.assertEqual(list(client.iter_pages("x-mentions", symbol="AAPL", max_pages=2)), pages)
            self.assertEqual(getter.call_args_list[1].kwargs, {"symbol": "AAPL", "cursor": "next"})

    def test_repeated_cursor_and_page_limit_are_explicit(self):
        client = module.TraderDataClient()
        with patch.object(client, "get", return_value={"pagination": {"nextCursor": "same"}}):
            for limit, code in [(1, "page_limit"), (5, "invalid_cursor")]:
                with self.assertRaises(module.TraderDataError) as error:
                    list(client.iter_pages("x-posts", max_pages=limit))
                self.assertEqual(error.exception.code, code)


if __name__ == "__main__":
    unittest.main()
