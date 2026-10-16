"""Shared producer contract, pagination, read-only and availability regressions."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1] / "api/tradingview-websocket/shared_data.py"
SPEC = importlib.util.spec_from_file_location("shared_data", MODULE)
assert SPEC and SPEC.loader
shared = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(shared)

REVISION = "20260906T120000.000000Z-1234abcd"
REVISION_TWO = "20260907T120000.000000Z-1234abcd"
NOW = "2026-09-06T12:00:00+00:00"


class Store:
    def __init__(self, root: Path, family: str):
        self.root = root
        self.family = family
        self.path = root / "finance" / family
        (self.path / "state").mkdir(parents=True)
        (self.path / ".snapshots-forbidden").write_text("No snapshots.\n")
        self.database = self.path / "state/producer.sqlite"
        self.connection = sqlite3.connect(self.database)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript("""
            CREATE TABLE producer_meta(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE producer_runs(run_id TEXT PRIMARY KEY,slot_key TEXT,status TEXT,
              outcome TEXT,published_revision TEXT,domain_sha256 TEXT);
            CREATE TABLE schedule_slots(slot_key TEXT PRIMARY KEY,status TEXT,current_run_id TEXT);
        """)
        if family == "13f":
            self.connection.execute("CREATE TABLE publication_pending(table_name TEXT,entity_key TEXT,PRIMARY KEY(table_name,entity_key))")
        for definition in shared.DEFINITIONS.values():
            if definition["family"] == family:
                columns = ",".join('"' + field + '" TEXT' for field in definition["fields"])
                self.connection.execute("CREATE TABLE " + definition["table"] + "(" + columns + ")")
        if family == "x":
            self.connection.execute("CREATE TABLE x_mention_llm_judgments(mention_id TEXT,model TEXT,prompt_version TEXT," 
                                    "sentiment TEXT,is_relevant INTEGER,updated_at TEXT,PRIMARY KEY(mention_id,model,prompt_version))")
            self.connection.execute("CREATE UNIQUE INDEX posts_raw_key ON x_posts_raw(raw_id)")
            self.connection.execute("CREATE INDEX price_symbol ON prices_daily(symbol,trade_date)")
            self.connection.execute("CREATE INDEX mentions_symbol ON x_symbol_mentions(symbol,published_at)")
        else:
            self.connection.execute("CREATE UNIQUE INDEX filing_accession ON sec_13f_filings(accession)")
            self.connection.execute("CREATE INDEX position_accession ON sec_13f_ownership_positions(accession)")
        self.publish()

    def add(self, table: str, **values):
        columns = ",".join(values)
        self.connection.execute("INSERT INTO " + table + "(" + columns + ") VALUES(" + ",".join("?" for _ in values) + ")", list(values.values()))
        self.connection.commit()

    def publish(self, revision=REVISION):
        self.connection.execute("DELETE FROM producer_runs")
        self.connection.execute("DELETE FROM schedule_slots")
        self.connection.execute("INSERT INTO producer_runs VALUES('run','slot','succeeded','published_direct_state',?,'domain')", (revision,))
        self.connection.execute("INSERT INTO schedule_slots VALUES('slot','succeeded','run')")
        manifest = dict(revision=revision, created_at=NOW, database="state/producer.sqlite",
                        schema_sha256=shared._schema_digest(self.connection, self.family), row_counts={})
        if self.family == "13f":
            manifest.update(manifest_version=1, contract_version=1, kind="direct_state", mutable=True,
                            publication_mode="direct_state_no_copy", producer_run_id="run", schedule_slot="slot",
                            domain_sha256="domain", quality_gate={"ok": True}, provenance={"source_providers": {"canonical_holdings": "sec_edgar_complete_submission"}})
            self.connection.execute("INSERT OR REPLACE INTO producer_meta VALUES('direct_state_manifest_v1',?)", (json.dumps(manifest),))
        else:
            manifest.update(manifest_version=3, contract_version="1.2.0", consumer_schema_version=2,
                            publication_mode="direct-state", database_mutable=True, consistency_model="live-wal-progressive",
                            provenance={"quality_gate": {"decision": "pass"}, "classifier": {
                                "judgment_model": "test-model", "prompt_version": "test-prompt"}}, watermarks={})
            self.connection.execute("INSERT OR REPLACE INTO producer_meta VALUES('published_revision:run',?)", (revision,))
            (self.path / "current.json").write_text(json.dumps(manifest))
        self.connection.commit()
        self.manifest = manifest

    def close(self):
        self.connection.close()


class SharedDataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.x = Store(self.root, "x")
        self.f = Store(self.root, "13f")

    def tearDown(self):
        self.x.close()
        self.f.close()
        self.temp.cleanup()

    def read(self, dataset, **query):
        return shared.load_dataset(dataset, query, root=self.root)

    def assert_error(self, code, fn):
        with self.assertRaises(shared.SharedDataError) as context:
            fn()
        self.assertEqual(context.exception.code, code)
        self.assertNotIn(str(self.root), str(context.exception))
        return context.exception

    def post(self, raw_id, **other):
        values = dict(raw_id=raw_id, author_handle="reader", published_at="2025-01-01T00:00:00Z",
                      ingested_at="2025-01-02T00:00:00Z", available_to_hermes_at="2025-01-01T00:00:00Z",
                      updated_at="2025-01-02T00:00:00Z", created_at="2025-01-02T00:00:00Z",
                      symbols_json='["AAPL"]', text="A public post", content_hash="hash")
        values.update(other)
        self.x.add("x_posts_raw", **values)

    def filing(self, accession="0001067983-26-000001", **other):
        values = dict(accession=accession, cik="0001067983", manager="Berkshire", form_type="13F-HR",
                      report_period="2026-06-30", filing_date="2026-08-14", accepted_at="2026-08-14T20:00:00Z",
                      ingested_at="2026-08-15T00:00:00Z", is_amendment="0")
        values.update(other)
        self.f.add("sec_13f_filings", **values)
        return accession

    def test_all_dataset_contracts_resolve(self):
        for dataset in shared.DEFINITIONS:
            with self.subTest(dataset=dataset):
                result = self.read(dataset, **({"symbol": "AAPL"} if dataset == "x-prices" else {}))
                self.assertEqual(result["schemaVersion"], "trader.shared-data.v1")
                self.assertEqual(result["dataset"], dataset)
                self.assertEqual(result["coverage"]["status"], "empty")
                self.assertFalse(result["pagination"]["hasMore"])
                self.assertFalse(result["coverage"]["pointInTimeComplete"])

    def test_live_wal_is_visible_without_database_copy(self):
        # Writer remains open, so a readonly immutable connection would miss the
        # new row still committed in WAL.
        self.post("wal-post")
        before_hash = hashlib.sha256(self.x.database.read_bytes()).hexdigest()
        before_paths = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        result = self.read("x-posts")
        self.assertEqual(result["rows"][0]["raw_id"], "wal-post")
        self.assertEqual(hashlib.sha256(self.x.database.read_bytes()).hexdigest(), before_hash)
        self.assertEqual(sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*")), before_paths)

    def test_validation_rejects_sql_paths_and_invalid_dates(self):
        for query in ({"sql": "DROP TABLE x_posts_raw"}, {"from": "2026-02-30"}, {"from": "2026-02-01", "to": "2026-01-01"},
                      {"limit": "0"}, {"limit": "1001"}, {"account": "a' OR 1=1"}, {"asOf": "2026-01-01"},
                      {"symbol": "AAPL;SELECT"}, {"cursor": "a" * 2049}, {"root": "/tmp"}):
            with self.subTest(query=query):
                self.assert_error("invalid_shared_query", lambda: self.read("x-posts", **query))
        self.assert_error("shared_dataset_not_found", lambda: self.read("../../state/producer.sqlite"))
        self.assert_error("invalid_shared_query", lambda: self.read("x-prices"))

    def test_marker_and_symlink_fail_closed(self):
        marker = self.x.path / ".snapshots-forbidden"
        marker.unlink()
        self.assert_error("shared_data_unavailable", lambda: self.read("x-posts"))
        marker.write_text("no-copy")
        target = self.root / "linked.sqlite"
        target.symlink_to(self.x.database)
        with patch.object(shared, "_family_path", return_value=self.root):
            self.assert_error("shared_data_unavailable", lambda: self.read("x-posts"))
        marker.unlink()
        marker.symlink_to(self.x.database)
        self.assert_error("shared_data_unavailable", lambda: self.read("x-posts"))

    def test_uncommitted_x_manifest_is_rejected(self):
        self.x.connection.execute("UPDATE schedule_slots SET status='running'")
        self.x.connection.commit()
        error = self.assert_error("shared_publication_uncommitted", lambda: self.read("x-posts"))
        self.assertEqual(error.status, 409)

    def test_uncommitted_13f_manifest_is_rejected(self):
        self.f.connection.execute("UPDATE producer_runs SET domain_sha256='wrong'")
        self.f.connection.commit()
        self.assert_error("shared_publication_uncommitted", lambda: self.read("institutional-filings"))

    def test_schema_change_without_publication_is_rejected(self):
        self.x.connection.execute("CREATE TABLE unexpected(value TEXT)")
        self.x.connection.commit()
        self.assert_error("shared_schema_mismatch", lambda: self.read("x-posts"))

    def test_pending_13f_filing_and_its_positions_are_withheld(self):
        accession = self.filing()
        self.f.add("sec_13f_ownership_positions", position_id="position", accession=accession, symbol="AAPL", market_value="12345")
        self.f.add("publication_pending", table_name="accession", entity_key=accession)
        for dataset in ("institutional-filings", "institutional-holdings"):
            result = self.read(dataset)
            self.assertEqual(result["rows"], [])
            self.assertEqual(result["coverage"]["status"], "partial")
            self.assertEqual(result["coverage"]["pendingKeys"], 1)
        self.f.connection.execute("DELETE FROM publication_pending")
        self.f.connection.commit()
        result = self.read("institutional-holdings")
        self.assertEqual(result["rows"][0]["accepted_at"], "2026-08-14T20:00:00Z")
        self.assertEqual(result["rows"][0]["market_value"], "12345")

    def test_amendments_and_missing_acceptance_are_not_collapsed(self):
        self.filing(accepted_at=None)
        self.filing("0001067983-26-000002", is_amendment="1", amendment_type="RESTATEMENT")
        result = self.read("institutional-filings", institution="1067983", period="2026-06-30")
        self.assertEqual(len(result["rows"]), 2)
        self.assertIsNone(result["rows"][1]["accepted_at"])
        strict = self.read("institutional-filings", asOf="2026-09-01T00:00:00Z")
        self.assertEqual(len(strict["rows"]), 1)

    def test_from_to_use_event_date_and_asof_uses_real_ingestion(self):
        self.post("backfill")
        history = self.read("x-posts", **{"from": "2025-01-01", "to": "2025-01-01"})
        self.assertEqual(len(history["rows"]), 1)
        self.assertEqual(self.read("x-posts", asOf="2025-01-01T23:59:59Z")["rows"], [])
        self.assertEqual(len(self.read("x-posts", asOf="2025-01-02T00:00:00Z")["rows"]), 1)

    def test_asof_preserves_timezone_offsets_and_rejects_unknown_zones(self):
        self.post("offset", published_at="2025-01-01T01:00:00+01:00", ingested_at="2025-01-01T01:00:00+01:00",
                  available_to_hermes_at="2025-01-01T01:00:00+01:00", updated_at="2025-01-01T01:00:00+01:00")
        self.post("naive", published_at="2025-01-01T00:00:00", ingested_at="2025-01-01T00:00:00", updated_at="2025-01-01T00:00:00")
        rows = self.read("x-posts", asOf="2025-01-01T00:00:00Z")["rows"]
        self.assertEqual([r["raw_id"] for r in rows], ["offset"])

    def test_mention_retains_original_and_current_classification(self):
        self.post("raw")
        self.x.add("x_symbol_mentions", mention_id="mention", raw_id="raw", symbol="AAPL", author_handle="reader",
                   signal_direction="bullish", published_at="2025-01-01T00:00:00Z", available_to_hermes_at="2025-01-01T00:00:00Z",
                   created_at="2025-01-02T00:00:00Z", updated_at="2025-01-02T00:00:00Z")
        self.x.add("x_mention_llm_judgments", mention_id="mention", model="test-model", prompt_version="test-prompt",
                   sentiment="neutral", is_relevant=1, updated_at="2025-01-03T00:00:00Z")
        row = self.read("x-mentions", symbol="AAPL")["rows"][0]
        self.assertEqual(row["signal_direction"], "bullish")
        self.assertEqual(row["judgment_sentiment"], "neutral")
        self.assertEqual(self.read("x-mentions", asOf="2025-01-02T12:00:00Z")["rows"], [])

    def test_asof_does_not_round_future_microseconds_into_the_past(self):
        self.post("one-microsecond-later", published_at="2025-01-01T00:00:00.000001Z",
                  ingested_at="2025-01-01T00:00:00.000001Z", available_to_hermes_at="2025-01-01T00:00:00.000001Z",
                  updated_at="2025-01-01T00:00:00.000001Z")
        self.assertEqual(self.read("x-posts", asOf="2025-01-01T00:00:00.000000Z")["rows"], [])
        self.assertEqual(len(self.read("x-posts", asOf="2025-01-01T00:00:00.000001Z")["rows"]), 1)

    def test_exact_raw_symbol_filter_does_not_match_substrings(self):
        self.post("apple", symbols_json='["AAPL"]')
        self.post("notapple", symbols_json='["AAPLC"]')
        self.post("invalidjson", symbols_json='not json')
        self.assertEqual([r["raw_id"] for r in self.read("x-posts", symbol="aapl")["rows"]], ["apple"])

    def test_cursor_pages_do_not_repeat_rows_or_include_new_inserts(self):
        for value in range(5):
            self.post(str(value))
        result = self.read("x-posts", limit="2")
        observed = [r["raw_id"] for r in result["rows"]]
        self.post("new-after-first-page")
        while result["pagination"]["nextCursor"]:
            result = self.read("x-posts", limit="2", cursor=result["pagination"]["nextCursor"])
            observed += [r["raw_id"] for r in result["rows"]]
        self.assertEqual(observed, ["4", "3", "2", "1", "0"])

    def test_sparse_filter_continues_after_empty_pages(self):
        for value in range(5):
            self.post(str(value), symbols_json='["AAPL"]' if value == 0 else '["MSFT"]')
        with patch.object(shared, "MAX_SCAN_ROWS", 2):
            result = self.read("x-posts", symbol="AAPL")
            self.assertEqual(result["rows"], [])
            self.assertTrue(result["pagination"]["nextCursor"])
            result = self.read("x-posts", symbol="AAPL", cursor=result["pagination"]["nextCursor"])
            self.assertEqual(result["rows"], [])
            result = self.read("x-posts", symbol="AAPL", cursor=result["pagination"]["nextCursor"])
            self.assertEqual(result["rows"][0]["raw_id"], "0")
            self.assertFalse(result["pagination"]["hasMore"])

    def test_cursor_bound_to_filters_dataset_and_revision(self):
        self.post("1")
        self.post("2")
        cursor = self.read("x-posts", limit="1")["pagination"]["nextCursor"]
        self.assert_error("invalid_shared_cursor", lambda: self.read("x-posts", cursor=cursor, symbol="AAPL"))
        self.assert_error("invalid_shared_cursor", lambda: self.read("x-mentions", cursor=cursor))
        self.x.publish(REVISION_TWO)
        self.assert_error("shared_cursor_revision_changed", lambda: self.read("x-posts", cursor=cursor))

    def test_result_tables_include_current_author_scores_and_native_units(self):
        self.x.add("source_scores", source_type="x_author", source_name="X/@reader", scope_type="symbol", scope_key="AAPL", horizon_days="20", hit_rate="0.6")
        self.x.add("source_scores", source_type="x", source_name="X/@reader", scope_type="source", scope_key="X/@reader", horizon_days="20", hit_rate="0.5")
        self.x.add("source_scores", source_type="news", source_name="X/@reader", scope_type="symbol", scope_key="AAPL", horizon_days="20")
        result = self.read("x-author-scores", account="@Reader", symbol="AAPL", horizonDays="20")
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["rows"][0]["hit_rate"], "0.6")
        self.assertEqual(result["provenance"]["dataKind"], "result")
        self.assertEqual(next(c for c in result["columns"] if c["key"] == "hit_rate")["unit"], "fraction")

    def test_response_byte_limit_returns_continuation_without_truncating_text(self):
        self.post("one", text="a" * 2000)
        self.post("two", text="b" * 2000)
        with patch.object(shared, "MAX_ROWS_BYTES", 3000):
            result = self.read("x-posts")
            self.assertEqual(len(result["rows"]), 1)
            self.assertEqual(result["rows"][0]["text"], "b" * 2000)
            self.assertTrue(result["coverage"]["responseByteLimited"])
            next_page = self.read("x-posts", cursor=result["pagination"]["nextCursor"])
            self.assertEqual(next_page["rows"][0]["text"], "a" * 2000)

    def test_query_deadline_fails_instead_of_silently_returning_empty(self):
        with patch.object(shared, "QUERY_TIMEOUT_SECONDS", -1):
            error = self.assert_error("shared_query_timeout", lambda: self.read("x-posts"))
            self.assertEqual(error.status, 504)

    def test_external_symbol_mapping_binding_is_verified_when_present(self):
        self.x.manifest["watermarks"] = {"producer_meta": {"x_symbol_resolution_contract_sha256": "0" * 64}}
        (self.x.path / "current.json").write_text(json.dumps(self.x.manifest))
        self.assert_error("shared_publication_uncommitted", lambda: self.read("x-mentions"))

    def test_environment_root_means_data_directory(self):
        self.post("from-env")
        with patch.dict("os.environ", {"TRADER_SHARED_DATA_ROOT": str(self.root)}):
            result = shared.load_dataset("x-posts", {})
        self.assertEqual(result["rows"][0]["raw_id"], "from-env")


if __name__ == "__main__":
    unittest.main()
