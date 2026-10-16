"""Bounded, read-only consumers of the independent finance producers.

There are no producer imports, SQLite copies, HTTP fallbacks or arbitrary query
interfaces here. Each response reads one SQLite transaction. Publication
revisions identify successful producer publications, NOT immutable DB versions.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
from datetime import date, datetime, timezone
from typing import Any


MAX_LIMIT = 1000
DEFAULT_LIMIT = 100
MAX_SCAN_ROWS = 20_000
QUERY_TIMEOUT_SECONDS = 8.0
MAX_MANIFEST_BYTES = 1_048_576
MAX_ROWS_BYTES = 6 * 1024 * 1024
REVISION_PATTERN = re.compile(r"[0-9]{8}T[0-9]{6}\.[0-9]{6}Z-[0-9a-f]{8}")
COMMON_PARAMETERS = {"limit", "cursor"}
EVENT_PARAMETERS = COMMON_PARAMETERS | {"from", "to", "asOf"}


class SharedDataError(Exception):
    """A public-safe error; never includes SQL, filesystem paths or payloads."""

    def __init__(self, code: str, message: str, status: int = 503) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _definition(family: str, table: str, columns: str, parameters: set[str],
                time_field: str | None = None, *, date_fields: tuple[str, ...] = (),
                kind: str = "input") -> dict[str, Any]:
    return dict(family=family, table=table, fields=columns.split(),
                parameters=parameters, time_field=time_field,
                availability_fields=date_fields, kind=kind)


DEFINITIONS = {
    "institutional-filings": _definition(
        "13f", "sec_13f_filings",
        "accession cik manager form_type report_period filing_date accepted_at filing_url "
        "total_value total_holdings is_amendment amendment_number amendment_type "
        "is_confidential_omitted source_provider parser_version ingested_at",
        EVENT_PARAMETERS | {"institution", "accession", "period"}, "filing_date",
        date_fields=("p.accepted_at", "p.ingested_at")),
    "institutional-holdings": _definition(
        "13f", "sec_13f_ownership_positions",
        "position_id accession cik manager issuer_name title_of_class cusip figi symbol "
        "shares market_value shares_type put_call other_manager report_period filing_date "
        "source_provider ingested_at",
        EVENT_PARAMETERS | {"institution", "accession", "period", "symbol"}, "filing_date",
        date_fields=("f.accepted_at", "f.ingested_at", "p.ingested_at")),
    "institutional-managers": _definition(
        "13f", "alt_13f_popular_managers",
        "cik manager manager_url location latest_filing_url latest_accession latest_period "
        "num_holdings holdings_value_text observed_at source_url popular_rank",
        COMMON_PARAMETERS | {"institution"}, kind="directory"),
    "x-posts": _definition(
        "x", "x_posts_raw",
        "raw_id source_id provider collection_method post_id canonical_url provider_url "
        "author_handle author_name text published_at ingested_at available_to_hermes_at "
        "symbols_json metrics_json is_spam exclusion_reason created_at updated_at is_backfill content_hash",
        EVENT_PARAMETERS | {"account", "symbol"}, "published_at",
        date_fields=("p.published_at", "p.ingested_at", "p.available_to_hermes_at", "p.updated_at")),
    "x-mentions": _definition(
        "x", "x_symbol_mentions",
        "mention_id source_id raw_id post_id symbol author_handle published_at available_to_hermes_at "
        "mention_text mention_type signal_direction action_type direction_confidence is_tradeable_signal "
        "market_session entry_policy language extraction_version confidence dedupe_group is_spam "
        "is_excluded_from_scoring exclusion_reason created_at updated_at is_backfill superseded",
        EVENT_PARAMETERS | {"account", "symbol"}, "published_at",
        date_fields=("p.published_at", "p.available_to_hermes_at", "p.created_at", "p.updated_at",
                     "r.ingested_at", "r.updated_at")),
    "x-mention-outcomes": _definition(
        "x", "x_mention_outcomes",
        "mention_id symbol author_handle horizon_days benchmark_symbol strategy_version entry_at entry_price "
        "exit_at exit_price trading_day_horizon price_source adjustment_policy is_price_available liquidity_pass "
        "cost_bps slippage_bps gross_return net_return benchmark_return relative_net_return computed_at",
        EVENT_PARAMETERS | {"account", "symbol", "horizonDays", "strategy"}, "entry_at",
        date_fields=("p.computed_at",), kind="result"),
    "x-author-scores": _definition(
        "x", "source_scores",
        "source_type source_name scope_type scope_key horizon_days sample_count hit_rate avg_alpha "
        "avg_forward_return updated_at median_alpha payoff_ratio t_stat bootstrap_ci_low bootstrap_ci_high "
        "walkforward_score multiple_testing_adjusted_p min_sample_warning score_status",
        EVENT_PARAMETERS | {"account", "symbol", "horizonDays"}, "updated_at",
        date_fields=("p.updated_at",), kind="result"),
    "x-author-strategies": _definition(
        "x", "x_author_shadow_runs",
        "run_id author_handle strategy_version horizon_days benchmark_symbol entry_rule exit_rule position_sizing "
        "cost_bps slippage_bps liquidity_filter_json dedupe_window max_positions gross_return net_return "
        "benchmark_return relative_net_return max_drawdown turnover hit_rate sample_count coverage_status "
        "created_at updated_at",
        EVENT_PARAMETERS | {"account", "horizonDays", "strategy"}, "updated_at",
        date_fields=("p.created_at", "p.updated_at"), kind="result"),
    "x-accounts": _definition(
        "x", "x_accounts",
        "account_id platform_user_id handle display_name status tier created_at updated_at",
        COMMON_PARAMETERS | {"account"}, kind="directory"),
    "x-prices": _definition(
        "x", "prices_daily", "symbol trade_date open high low close volume source updated_at",
        EVENT_PARAMETERS | {"symbol"}, "trade_date", date_fields=("p.updated_at",)),
}


def _validate_query(dataset_id: str, query: dict[str, str]) -> dict[str, str]:
    if dataset_id not in DEFINITIONS:
        raise SharedDataError("shared_dataset_not_found", "Unknown shared dataset.", 404)
    if not isinstance(query, dict) or any(not isinstance(k, str) or not isinstance(v, str)
                                         for k, v in query.items()):
        raise SharedDataError("invalid_shared_query", "Query parameters must be strings.", 400)
    if set(query) - DEFINITIONS[dataset_id]["parameters"]:
        raise SharedDataError("invalid_shared_query", "Unsupported query parameter.", 400)
    q = dict(query)
    for key, value in q.items():
        if not value or len(value) > (2048 if key == "cursor" else 160):
            raise SharedDataError("invalid_shared_query", "Empty or oversized query parameter.", 400)
    for key in ("from", "to", "period"):
        if key in q:
            try:
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", q[key]):
                    raise ValueError
                date.fromisoformat(q[key])
            except ValueError:
                raise SharedDataError("invalid_shared_query", "Dates must be valid YYYY-MM-DD values.", 400) from None
    if "from" in q and "to" in q and q["from"] > q["to"]:
        raise SharedDataError("invalid_shared_query", "from must not be later than to.", 400)
    if "asOf" in q:
        try:
            if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)", q["asOf"]):
                raise ValueError
            as_of = datetime.fromisoformat(q["asOf"].replace("Z", "+00:00"))
            q["asOf"] = as_of.astimezone(timezone.utc).isoformat()
        except ValueError:
            raise SharedDataError("invalid_shared_query", "asOf must be an ISO timestamp with timezone.", 400) from None
    patterns = {
        "symbol": r"[A-Z0-9.^:/_-]{1,32}", "institution": r"[0-9]{1,10}",
        "account": r"[A-Za-z0-9_]{1,15}", "accession": r"[0-9]{10}-[0-9]{2}-[0-9]{6}",
        "strategy": r"[A-Za-z0-9_.:-]{1,120}",
    }
    for key, pattern in patterns.items():
        if key not in q:
            continue
        if key == "symbol":
            q[key] = q[key].upper()
        if key == "account":
            q[key] = q[key].removeprefix("@").lower()
        if not re.fullmatch(pattern, q[key]):
            raise SharedDataError("invalid_shared_query", f"Invalid {key} parameter.", 400)
        if key == "institution":
            q[key] = q[key].zfill(10)
    for key, maximum in (("limit", MAX_LIMIT), ("horizonDays", 366)):
        if key in q and (not re.fullmatch(r"[0-9]{1,4}", q[key]) or not 1 <= int(q[key]) <= maximum):
            raise SharedDataError("invalid_shared_query", f"Invalid {key} parameter.", 400)
    if dataset_id == "x-prices" and "symbol" not in q:
        raise SharedDataError("invalid_shared_query", "x-prices requires symbol.", 400)
    return q


def _safe_file(path: Path) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
        raise SharedDataError("shared_data_unavailable", "Shared data file is missing or unsafe.")


def _family_path(root: str | Path | None, family: str) -> Path:
    configured = root or os.environ.get("TRADER_SHARED_DATA_ROOT")
    if configured is None:
        configured = Path(__file__).resolve().parents[3] / ".data"
    path = Path(configured).expanduser().resolve() / "finance" / family
    for parent in (path.parent, path, path / "state"):
        if parent.is_symlink() or not parent.is_dir():
            raise SharedDataError("shared_data_unavailable", "Shared finance root is unavailable.")
    _safe_file(path / ".snapshots-forbidden")
    _safe_file(path / "state" / "producer.sqlite")
    return path


def _read_json(value: str) -> dict[str, Any]:
    if len(value.encode("utf-8")) > MAX_MANIFEST_BYTES:
        raise SharedDataError("shared_publication_invalid", "Shared publication metadata exceeds its bound.")
    try:
        decoded = json.loads(value)
    except (ValueError, TypeError):
        raise SharedDataError("shared_publication_invalid", "Shared publication metadata is invalid.") from None
    if not isinstance(decoded, dict):
        raise SharedDataError("shared_publication_invalid", "Shared publication metadata is invalid.")
    return decoded


def _schema_digest(connection: sqlite3.Connection, family: str) -> str:
    if family == "13f":
        values = connection.execute("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name")
        payload = "\n".join(str(row[0]) for row in values).encode("utf-8")
    else:
        rows = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema "
                                  "WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL "
                                  "ORDER BY type,name,tbl_name,sql").fetchall()
        payload = json.dumps([[str(v or "") for v in row] for row in rows], ensure_ascii=False,
                             separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _publication(connection: sqlite3.Connection, path: Path, family: str) -> tuple[dict[str, Any], int]:
    """Verify only bounded consumer contract checks, never scan the whole DB."""
    pending = 0
    if family == "13f":
        row = connection.execute("SELECT value FROM producer_meta WHERE key='direct_state_manifest_v1'").fetchone()
        if row is None:
            raise SharedDataError("shared_publication_invalid", "No published 13F generation is available.")
        manifest = _read_json(row[0])
        valid_shape = (manifest.get("manifest_version") == 1 and manifest.get("contract_version") == 1
                       and manifest.get("kind") == "direct_state" and manifest.get("mutable") is True
                       and manifest.get("publication_mode") == "direct_state_no_copy"
                       and manifest.get("quality_gate", {}).get("ok") is True)
        binding = connection.execute(
            "SELECT r.status,r.slot_key,r.outcome,r.published_revision,r.domain_sha256,s.status,s.current_run_id "
            "FROM producer_runs r JOIN schedule_slots s ON s.slot_key=r.slot_key WHERE r.run_id=?",
            (manifest.get("producer_run_id"),)).fetchone()
        expected = ("succeeded", manifest.get("schedule_slot"), "published_direct_state",
                    manifest.get("revision"), manifest.get("domain_sha256"), "succeeded", manifest.get("producer_run_id"))
        valid_binding = binding is not None and tuple(binding) == expected
        # Pending keys are bounded here; consumers exclude every matching key in
        # the row query even when there are more than this reporting limit.
        pending = len(connection.execute("SELECT 1 FROM publication_pending LIMIT 10001").fetchall())
    else:
        current = path / "current.json"
        _safe_file(current)
        if current.stat().st_size > MAX_MANIFEST_BYTES:
            raise SharedDataError("shared_publication_invalid", "Shared publication metadata exceeds its bound.")
        with current.open("rb") as manifest_file:
            manifest_bytes = manifest_file.read(MAX_MANIFEST_BYTES + 1)
        if len(manifest_bytes) > MAX_MANIFEST_BYTES:
            raise SharedDataError("shared_publication_invalid", "Shared publication metadata exceeds its bound.")
        manifest = _read_json(manifest_bytes.decode("utf-8"))
        valid_shape = (manifest.get("manifest_version") == 3 and manifest.get("contract_version") == "1.2.0"
                       and manifest.get("consumer_schema_version") == 2
                       and manifest.get("publication_mode") == "direct-state"
                       and manifest.get("database_mutable") is True
                       and manifest.get("consistency_model") == "live-wal-progressive"
                       and manifest.get("provenance", {}).get("quality_gate", {}).get("decision") == "pass")
        rows = connection.execute(
            "SELECT r.run_id FROM producer_meta m JOIN producer_runs r "
            "ON m.key='published_revision:'||r.run_id JOIN schedule_slots s "
            "ON s.slot_key=r.slot_key AND s.current_run_id=r.run_id "
            "WHERE m.value=? AND r.status='succeeded' AND s.status='succeeded' LIMIT 2",
            (manifest.get("revision"),)).fetchall()
        valid_binding = len(rows) == 1
        resolution_sha = manifest.get("watermarks", {}).get("producer_meta", {}).get("x_symbol_resolution_contract_sha256")
        if resolution_sha is not None:
            row = connection.execute("SELECT value FROM producer_meta WHERE key='x_symbol_resolution_contract'").fetchone()
            if row is None or hashlib.sha256(row[0].encode("utf-8")).hexdigest() != resolution_sha:
                valid_binding = False
    if (not valid_shape or manifest.get("database") != "state/producer.sqlite"
            or not isinstance(manifest.get("revision"), str)
            or not REVISION_PATTERN.fullmatch(manifest["revision"])):
        raise SharedDataError("shared_publication_invalid", "Unsupported shared publication contract.")
    if not valid_binding:
        raise SharedDataError("shared_publication_uncommitted", "Shared publication is not bound to a succeeded producer run.", 409)
    if manifest.get("schema_sha256") != _schema_digest(connection, family):
        raise SharedDataError("shared_schema_mismatch", "Shared database schema differs from its published contract.", 409)
    return manifest, pending


def _filter_signature(dataset: str, q: dict[str, str]) -> str:
    value = [dataset, {k: v for k, v in q.items() if k not in {"cursor", "limit"}}]
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _cursor_encode(dataset: str, signature: str, revision: str, upper: int, before: int) -> str:
    value = dict(v=1, d=dataset, f=signature, r=revision, u=upper, b=before)
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")


def _cursor_decode(value: str, dataset: str, signature: str, revision: str) -> tuple[int, int]:
    try:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,2048}", value):
            raise ValueError
        decoded = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        if (not isinstance(decoded, dict) or set(decoded) != {"v", "d", "f", "r", "u", "b"}
                or decoded["v"] != 1 or decoded["d"] != dataset or decoded["f"] != signature
                or type(decoded["u"]) is not int or type(decoded["b"]) is not int
                or not 0 <= decoded["u"] < 2**63 - 1 or not 0 < decoded["b"] <= decoded["u"] + 1):
            raise ValueError
        if decoded["r"] != revision:
            raise SharedDataError("shared_cursor_revision_changed", "Publication changed; restart pagination for the new revision.", 409)
        return decoded["u"], decoded["b"]
    except (ValueError, TypeError, KeyError, UnicodeDecodeError):
        raise SharedDataError("invalid_shared_cursor", "Cursor does not match this dataset and query.", 400) from None


def _known_at(column: str) -> str:
    # Do not assume UTC for legacy timezone-free timestamps. Date-only values
    # also fail this condition. They remain visible without an asOf filter.
    return f"trader_known_at({column},?)=1"


def _timestamp_known_at(value: Any, bound: str) -> int:
    """Compare instants without SQLite julianday's millisecond rounding."""
    if (not isinstance(value, str) or len(value) > 40
            or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)", value)):
        return 0
    try:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(instant <= datetime.fromisoformat(bound))
    except (ValueError, TypeError, OverflowError):
        return 0


def _query_parts(dataset: str, q: dict[str, str], manifest: dict[str, Any]) -> tuple[str, list[str], list[Any], list[str]]:
    definition = DEFINITIONS[dataset]
    selected = ["p." + column for column in definition["fields"]]
    joins = ""
    where: list[str] = []
    values: list[Any] = []
    extras: list[str] = []
    if dataset == "institutional-holdings":
        joins = " JOIN sec_13f_filings f ON f.accession=p.accession"
        extras = ["accepted_at", "filing_ingested_at", "filing_url", "is_amendment", "amendment_number", "amendment_type", "is_confidential_omitted"]
        selected += ["f.accepted_at", "f.ingested_at AS filing_ingested_at", "f.filing_url", "f.is_amendment",
                     "f.amendment_number", "f.amendment_type", "f.is_confidential_omitted"]
    if definition["family"] == "13f":
        if dataset == "institutional-managers":
            where.append("NOT EXISTS(SELECT 1 FROM publication_pending pending "
                         "WHERE pending.table_name='alt_13f_popular_managers' AND pending.entity_key=p.cik)")
        else:
            where.append("NOT EXISTS(SELECT 1 FROM publication_pending pending "
                         "WHERE pending.table_name='accession' AND pending.entity_key=p.accession)")
    if dataset == "x-mentions":
        joins += " LEFT JOIN x_posts_raw r ON r.raw_id=p.raw_id"
        classifier = manifest.get("provenance", {}).get("classifier", {})
        model = classifier.get("judgment_model", "")
        prompt = classifier.get("prompt_version", "")
        # The current producer classification is additional evidence, never a
        # replacement for the original extraction direction/version.
        joins += (" LEFT JOIN x_mention_llm_judgments j ON j.mention_id=p.mention_id "
                  "AND j.model=? AND j.prompt_version=?")
        values.extend([model, prompt])
        selected += ["r.ingested_at AS raw_ingested_at", "r.updated_at AS raw_updated_at",
                     "r.canonical_url", "j.sentiment AS judgment_sentiment", "j.is_relevant AS judgment_is_relevant",
                     "j.model AS judgment_model", "j.prompt_version AS judgment_prompt_version",
                     "j.updated_at AS judgment_updated_at"]
        extras = ["raw_ingested_at", "raw_updated_at", "canonical_url", "judgment_sentiment", "judgment_is_relevant",
                  "judgment_model", "judgment_prompt_version", "judgment_updated_at"]
    mappings = {"institution": "p.cik", "accession": "p.accession", "period": "p.report_period",
                "horizonDays": "p.horizon_days", "strategy": "p.strategy_version"}
    for parameter, column in mappings.items():
        if parameter in q:
            where.append(column + "=?")
            values.append(int(q[parameter]) if parameter == "horizonDays" else q[parameter])
    if "account" in q:
        if dataset == "x-author-scores":
            where.append("p.source_name=? COLLATE NOCASE")
            values.append("X/@" + q["account"])
        else:
            where.append(("p.handle" if dataset == "x-accounts" else "p.author_handle") + "=? COLLATE NOCASE")
            values.append(q["account"])
    if dataset == "x-author-scores":
        where.append("p.source_type IN ('x','x_author')")
    if "symbol" in q:
        if dataset == "x-posts":
            where.append("EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.symbols_json) "
                         "THEN p.symbols_json ELSE '[]' END) WHERE value=? COLLATE NOCASE)")
        elif dataset == "x-author-scores":
            where.append("p.scope_type='symbol' AND p.scope_key=?")
        else:
            where.append("p.symbol=?")
        values.append(q["symbol"])
    time_field = definition["time_field"]
    for parameter, comparator in (("from", ">="), ("to", "<=")):
        if parameter in q:
            where.append(f"substr(p.{time_field},1,10){comparator}?")
            values.append(q[parameter])
    if "asOf" in q:
        for column in definition["availability_fields"]:
            where.append(_known_at(column))
            values.append(q["asOf"])
        if dataset == "x-mentions":
            where.append("(j.mention_id IS NULL OR " + _known_at("j.updated_at") + ")")
            values.append(q["asOf"])
    select = "SELECT p.rowid AS _row_id," + ",".join(selected) + " FROM " + definition["table"] + " p" + joins
    return select, where, values, extras


def _columns(definition: dict[str, Any], extra: list[str]) -> list[dict[str, Any]]:
    result = []
    for field in definition["fields"] + extra:
        item: dict[str, Any] = {"key": field, "label": field, "nullable": True}
        if field in {"market_value", "total_value"} and definition["family"] == "13f":
            item["unit"] = "USD"
        if field.endswith("_return") or field in {"hit_rate", "avg_alpha", "median_alpha", "max_drawdown"}:
            item["unit"] = "fraction"
        if field in {"cost_bps", "slippage_bps"}:
            item["unit"] = "basis-points"
        result.append(item)
    return result


def _read_dataset(connection: sqlite3.Connection, path: Path, dataset: str, q: dict[str, str]) -> dict[str, Any]:
    definition = DEFINITIONS[dataset]
    family = definition["family"]
    manifest, pending = _publication(connection, path, family)
    revision = manifest["revision"]
    signature = _filter_signature(dataset, q)
    limit = int(q.get("limit", str(DEFAULT_LIMIT)))
    if "cursor" in q:
        upper, before = _cursor_decode(q["cursor"], dataset, signature, revision)
    else:
        upper = connection.execute("SELECT coalesce(max(rowid),0) FROM " + definition["table"]).fetchone()[0]
        before = upper + 1
    scan_upper = min(upper, before - 1)
    # These fixed predicates use the producer's existing symbol/accession/CIK
    # indexes. Other requests (notably symbol-only 13F queries) must walk small
    # row-ID windows because consumers cannot create a new producer DB index.
    indexed = (dataset in {"x-prices", "x-author-scores"}
               or dataset == "institutional-holdings" and ("accession" in q or "institution" in q)
               or dataset == "institutional-filings" and ("accession" in q or "institution" in q)
               or dataset == "x-mentions" and "symbol" in q)
    floor = 0 if indexed else max(0, scan_upper - MAX_SCAN_ROWS)
    sql, where, values, extra = _query_parts(dataset, q, manifest)
    where += ["p.rowid<=?", "p.rowid>?", "p.rowid<?"]
    values += [upper, floor, before]
    sql += " WHERE " + " AND ".join(where) + " ORDER BY p.rowid DESC LIMIT ?"
    fetched = connection.execute(sql, [*values, limit + 1]).fetchall()
    rows: list[dict[str, Any]] = []
    response_bytes = 0
    last_id = before
    byte_limited = False
    for record in fetched[:limit]:
        row = dict(record)
        record_id = row.pop("_row_id")
        size = len(json.dumps(row, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        if response_bytes + size > MAX_ROWS_BYTES:
            byte_limited = True
            break
        rows.append(row)
        response_bytes += size
        last_id = record_id
    if byte_limited and not rows:
        raise SharedDataError("shared_row_too_large", "A shared data row exceeds the response bound.")
    within_window_more = len(fetched) > len(rows)
    next_before = last_id if within_window_more else floor + 1
    has_more = within_window_more or floor > 0
    next_cursor = _cursor_encode(dataset, signature, revision, upper, next_before) if has_more else None
    warnings = [
        "The shared database is mutable. Each page is a SQLite read transaction; a publication revision is not an immutable historical snapshot.",
        "Pagination uses descending storage row IDs, not chronological order. Continue while nextCursor is present, including empty pages, then sort by the event date if needed.",
    ]
    if family == "13f":
        warnings += ["Each filing and amendment is returned separately. Holdings are reported period-end positions, not actual trades or a ready backtest performance report.",
                     "accepted_at is the SEC publication timestamp. Missing legacy acceptance timestamps are preserved; filing_date alone is not an intraday availability timestamp."]
        if pending:
            warnings.append("Unpublished pending accession bundles and directory rows are excluded; the current producer run has not published all stored changes.")
    else:
        warnings += ["Backfilled publication timestamps can precede ingestion and classification. Preserve published_at, ingested_at, available_to_hermes_at and version timestamps separately.",
                     "Current exclusions, classifications and analytical outputs may have been revised; complete historical versions are not provided."]
    if definition["kind"] == "result":
        warnings.append("This dataset contains calculated results for strategy comparison or retrospective analysis, not a contemporaneous input signal.")
    if dataset == "institutional-managers":
        warnings.append("This is the producer's observed popular-manager directory, not a complete historical universe of institutional filers.")
    if dataset == "x-posts" and "symbol" in q:
        warnings.append("The symbol filter matches the raw post's stored symbols_json; use x-mentions for classified symbol mentions.")
    if dataset == "x-prices":
        warnings.append("Stored price source and update time are preserved. Coverage and adjustment policies vary; these rows do not initiate a price refresh.")
    if "asOf" in q:
        warnings.append("asOf conservatively excludes rows or current versions with later or timezone-unknown availability timestamps. It does not recover older overwritten versions or certify a complete point-in-time universe.")
    if has_more:
        warnings.append("This is a bounded page; additional pages may be empty while scanning sparse filters.")
    read_at = datetime.now(timezone.utc).isoformat()
    return {
        "schemaVersion": "trader.shared-data.v1", "dataset": dataset, "status": "ok",
        "rows": rows, "columns": _columns(definition, extra),
        "source": {"id": "finance-13f" if family == "13f" else "x-finance", "kind": "shared-store",
                   "storage": f"finance/{family}/state/producer.sqlite", "access": "read-only-sqlite"},
        "provenance": {"revision": revision, "publishedAt": manifest.get("created_at"), "readAt": read_at,
                       "databaseMutable": True, "consistencyModel": "live-wal-progressive",
                       "validation": "publication-quality-marker-succeeded-run-binding-and-schema",
                       "contractVersion": manifest.get("contract_version"), "schemaSha256": manifest.get("schema_sha256"),
                       "dataKind": definition["kind"], "upstream": "SEC EDGAR" if family == "13f" else "X finance producer",
                       "producer": manifest.get("provenance", {}).get("source_providers") if family == "13f"
                       else manifest.get("provenance", {}).get("classifier")},
        "coverage": {"status": "partial" if has_more or pending else "complete" if rows else "empty",
                     "returned": len(rows), "dateField": definition["time_field"],
                     "from": q.get("from"), "to": q.get("to"), "asOf": q.get("asOf"),
                     "publicationRowCount": manifest.get("row_counts", {}).get(definition["table"]),
                     "pendingKeys": min(pending, 10_000), "pendingKeysCapped": pending > 10_000,
                     "scanWindow": {"mode": "indexed-filter" if indexed else "bounded-rowid-scan",
                                    "fromExclusive": floor, "toInclusive": scan_upper,
                                    "rowIdSpan": None if indexed else max(0, scan_upper - floor)},
                     "responseByteLimited": byte_limited, "pointInTimeComplete": False},
        "pagination": {"limit": limit, "nextCursor": next_cursor, "hasMore": has_more,
                       "order": "storage-rowid-desc", "upperRowId": upper},
        "warnings": warnings,
    }


def load_dataset(dataset_id: str, query: dict[str, str], *, root: str | Path | None = None) -> dict[str, Any]:
    """Read a single bounded page. root is the .data directory, never a DB path."""
    q = _validate_query(dataset_id, query)
    connection: sqlite3.Connection | None = None
    try:
        path = _family_path(root, DEFINITIONS[dataset_id]["family"])
        database = path / "state" / "producer.sqlite"
        # immutable=1 is deliberately forbidden: these are live WAL databases.
        connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2.0)
        connection.row_factory = sqlite3.Row
        connection.create_function("trader_known_at", 2, _timestamp_known_at, deterministic=True)
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA busy_timeout=2000")
        deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        connection.execute("BEGIN")
        if time.monotonic() > deadline:
            raise SharedDataError("shared_query_timeout", "Shared data query exceeded its time bound.", 504)
        return _read_dataset(connection, path, dataset_id, q)
    except SharedDataError:
        raise
    except sqlite3.OperationalError as error:
        if "interrupted" in str(error).lower():
            raise SharedDataError("shared_query_timeout", "Shared data query exceeded its time bound.", 504) from None
        raise SharedDataError("shared_data_unavailable", "Shared database could not be read.") from None
    except (OSError, sqlite3.Error, ValueError, TypeError, OverflowError, AttributeError):
        raise SharedDataError("shared_data_unavailable", "Shared data or its publication contract could not be read.") from None
    finally:
        if connection is not None:
            connection.close()
