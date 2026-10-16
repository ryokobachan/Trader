"""Trader data discovery and retrieval. Native metadata and missing values survive unchanged."""
from __future__ import annotations
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class TraderDataError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 0):
        super().__init__(message)
        self.code, self.status = code, status


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TraderDataClient:
    """Connect to an already running Trader server; never runs a backtest or writes datasets."""
    def __init__(self, base_url: str | None = None, *, timeout: float = 60, headers: dict | None = None):
        base_url = base_url or os.environ.get("TRADER_BASE_URL", "http://localhost:3001")
        parts = urlsplit(base_url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
            raise ValueError("base_url must be an HTTP(S) origin without credentials")
        if not 0 < timeout <= 120:
            raise ValueError("timeout must be greater than 0 and at most 120 seconds")
        self.base_url, self.timeout = base_url.rstrip("/"), timeout
        self.headers = {"Accept": "application/json", **(headers or {})}
        self._opener = build_opener(_NoRedirect())

    @staticmethod
    def _dataset(dataset):
        import re
        if not isinstance(dataset, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", dataset):
            raise ValueError("Invalid dataset ID")
        return dataset

    def _request(self, path, parameters=None):
        query = urlencode({key: "1" if value is True else value for key, value in (parameters or {}).items() if value is not None and value is not False})
        request = Request(self.base_url + path + ("?" + query if query else ""), headers=self.headers)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(20 * 1024 * 1024 + 1)
                if len(raw) > 20 * 1024 * 1024:
                    raise TraderDataError("response_too_large", "Response exceeds 20 MiB")
                payload = json.loads(raw)
        except HTTPError as error:
            try:
                failure = json.loads(error.read(65536)).get("error", {})
                if not isinstance(failure, dict):
                    failure = {}
            except (ValueError, AttributeError):
                failure = {}
            finally:
                error.close()
            raise TraderDataError(failure.get("code", "http_error"), failure.get("message", "Trader request failed"), error.code) from None
        except (URLError, TimeoutError, OSError):
            raise TraderDataError("network_error", "Trader server is unavailable or timed out") from None
        except (ValueError, UnicodeError):
            raise TraderDataError("invalid_response", "Trader did not return valid JSON") from None
        if not isinstance(payload, dict):
            raise TraderDataError("invalid_response", "Expected a JSON object")
        if isinstance(payload.get("error"), dict):
            raise TraderDataError(payload["error"].get("code", "api_error"), payload["error"].get("message", "Trader request failed"))
        return payload

    def sources(self, **filters):
        return self._request("/api/v1/data", filters)

    def describe(self, dataset):
        return self._request(f"/api/v1/data/{self._dataset(dataset)}/describe")

    def get(self, dataset, **parameters):
        return self._request(f"/api/v1/data/{self._dataset(dataset)}", parameters)

    def iter_pages(self, dataset, *, max_pages=10, **parameters):
        """Yield complete responses; do not stop on empty rows when nextCursor exists."""
        if not isinstance(max_pages, int) or isinstance(max_pages, bool) or not 1 <= max_pages <= 1000:
            raise ValueError("max_pages must be an integer from 1 to 1000")
        seen = set()
        for _ in range(max_pages):
            page = self.get(dataset, **parameters)
            yield page
            cursor = page.get("pagination", {}).get("nextCursor")
            if cursor is None:
                return
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                raise TraderDataError("invalid_cursor", "Cursor is empty or repeated")
            seen.add(cursor)
            parameters["cursor"] = cursor
        raise TraderDataError("page_limit", "Pagination limit reached; resume explicitly with the last nextCursor")
