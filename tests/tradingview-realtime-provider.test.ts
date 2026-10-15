import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SIDECAR_URL = new URL("../api/tradingview-websocket/sidecar.py", import.meta.url);

test("realtime sidecar keeps one authenticated bounded broker for snapshots and SSE", async () => {
  const source = await readFile(SIDECAR_URL, "utf8");

  assert.match(source, /REALTIME_SCHEMA_VERSION = "trader\.tradingview-realtime-quotes\.v1"/);
  assert.match(source, /MAX_REALTIME_SYMBOLS = 50/);
  assert.match(source, /MAX_REALTIME_SUBSCRIBERS = 32/);
  assert.match(source, /MAX_REALTIME_SUBSCRIBERS_PER_OWNER = 16/);
  assert.match(source, /MAX_REALTIME_STREAM_SUBSCRIBERS = 16/);
  assert.match(source, /MAX_REALTIME_SNAPSHOT_SUBSCRIBERS = 16/);
  assert.match(source, /REALTIME_STREAM_TTL_SECONDS = 60\.0/);
  assert.match(source, /self\.realtime_quotes = RealtimeQuoteBroker\(timeout_seconds\)/);
  assert.match(source, /"\/v1\/realtime-quotes"/);
  assert.match(source, /"\/v1\/realtime-quotes\/stream"/);
  assert.match(source, /"Content-Type", "text\/event-stream; charset=utf-8"/);
  assert.match(source, /hmac\.compare_digest\(provided, f"Bearer \{token\}"\)/);
  assert.match(source, /self\.request_semaphore = threading\.BoundedSemaphore/);
  assert.match(source, /subscriber\.events\.put_nowait\(event\)/);
  assert.match(source, /except queue\.Full:/);
  assert.match(source, /self\._remove_subscriber_locked\(subscriber\.subscriber_id\)/);
});

test("realtime upstream derives USD listing IDs and maintains one reconnecting quote session", async () => {
  const source = await readFile(SIDECAR_URL, "utf8");

  assert.match(source, /MIC_TO_TRADINGVIEW_EXCHANGE = \{/);
  assert.match(source, /tradingview_symbol = symbol\.replace\("-", "\."\)/);
  assert.match(source, /websocket\.send_message\("quote_create_session", \[quote_session\]\)/);
  assert.match(source, /websocket\.send_message\("quote_add_symbols", \[quote_session, source\]\)/);
  assert.doesNotMatch(source, /quote_add_symbols[^\n]+force_permission/);
  assert.match(source, /packet\.startswith\("~h~"\)/);
  assert.match(source, /REALTIME_UPSTREAM_LIVENESS_SECONDS/);
  assert.match(source, /random\.uniform\(0\.8, 1\.2\)/);
  assert.match(source, /quote_epoch < previous_epoch/);
  assert.match(source, /merged\[field\] = quote_values\[field\]/);
  assert.match(source, /currency != expected_currency/);
  assert.match(source, /"open": optional_positive\("open_price"\)/);
  assert.match(source, /"high": optional_positive\("high_price"\)/);
  assert.match(source, /"low": optional_positive\("low_price"\)/);
});

test("Python candle normalization drops incomplete or malformed OHLCV without synthesizing volume", () => {
  const script = String.raw`
import importlib.util
import sys

path = sys.argv[1]
spec = importlib.util.spec_from_file_location("trader_sidecar", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

timestamp = 1786109400
valid_zero_volume = {"v": [timestamp, 100.0, 102.0, 99.0, 101.0, 0.0]}
invalid = [
    {"v": [timestamp + 1, 100.0, 102.0, 99.0, 101.0]},
    {"v": [timestamp + 2, 100.0, 102.0, 99.0, 101.0, None]},
    {"v": [timestamp + 3, 100.0, 102.0, 99.0, 101.0, float("nan")]},
    {"v": [timestamp + 4, 100.0, 102.0, 99.0, 101.0, -1.0]},
    {"v": [timestamp + 5, 0.0, 102.0, 99.0, 101.0, 10.0]},
    {"v": [timestamp + 6, 100.0, 99.0, 98.0, 101.0, 10.0]},
    {"v": [timestamp + 7, 100.0, 102.0, 101.5, 101.0, 10.0]},
]
rows = module.normalize_rows([valid_zero_volume, *invalid])
assert len(rows) == 1
assert rows[0]["volume"] == 0.0

try:
    module.normalize_rows(invalid)
except ValueError as error:
    assert str(error) == "TradingView returned no usable bars"
else:
    raise AssertionError("malformed OHLCV rows were accepted")

print("ok")
`;
  const result = spawnSync("python3", ["-c", script, SIDECAR_URL.pathname], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), "ok");
});

test("Python realtime contract rejects raw IDs, preserves order, merges deltas, and drops stale updates", () => {
  const script = String.raw`
import importlib.util
import queue
import sys
import threading
import time

path = sys.argv[1]
spec = importlib.util.spec_from_file_location("trader_sidecar", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

items = module.parse_realtime_items({"items": [
    {"symbol": "aapl", "mic": "xnas"},
    {"symbol": "brk-b", "mic": "xnys"},
    {"symbol": "nbis", "mic": "xnas"},
]})
assert [item["symbol"] for item in items] == ["AAPL", "BRK-B", "NBIS"]
assert [item["sourceSymbol"] for item in items] == [
    "NASDAQ:AAPL", "NYSE:BRK.B", "NASDAQ:NBIS"
]

invalid = [
    {"items": []},
    {"items": [{"symbol": "AAPL", "exchange": "NASDAQ"}]},
    {"items": [{"symbol": "AAPL", "mic": "XXXX"}]},
    {"items": [{"symbol": "AAPL", "mic": "XNAS", "sourceSymbol": "CRYPTO:BTCUSD"}]},
    {"items": [{"symbol": "BRK-B", "mic": "XNYS"}, {"symbol": "BRK.B", "mic": "XNYS"}]},
]
for payload in invalid:
    try:
        module.parse_realtime_items(payload)
    except ValueError:
        pass
    else:
        raise AssertionError("unsafe realtime payload accepted")

# Keep this unit deterministic: the broker's worker is replaced before init,
# then qsd deltas are injected through the same normalization path.
original_run = module.RealtimeQuoteBroker._run
module.RealtimeQuoteBroker._run = lambda self: None
broker = module.RealtimeQuoteBroker(2.0)
subscriber, initial = broker.subscribe(items, "unit-owner")
assert [item["symbol"] for item in initial] == ["AAPL", "BRK-B", "NBIS"]
assert all(item["price"] is None for item in initial)
broker._publish_status("connected")

assert broker._publish_quote("NASDAQ:AAPL", {
    "lp": 210.0,
    "lp_time": 1786147199,
    "currency_code": "USD",
    "ch": 2.0,
    "chp": 0.96,
    "prev_close_price": 208.0,
    "open_price": 208.0,
    "high_price": 212.0,
    "low_price": 207.0,
    "volume": 1000.0,
    "current_session": "regular",
})
# A partial qsd delta must retain the previously observed quote fields.
assert broker._publish_quote("NASDAQ:AAPL", {"volume": 1001.0})
latest = broker._latest["NASDAQ:AAPL"]
assert latest["price"] == 210.0 and latest["previousClose"] == 208.0
assert latest["change"] == 2.0 and latest["open"] == 208.0 and latest["volume"] == 1001.0
# An older lp_time is rejected even if its price differs.
assert not broker._publish_quote("NASDAQ:AAPL", {
    "lp": 1.0,
    "lp_time": 1786147100,
    "currency_code": "USD",
})
assert broker._latest["NASDAQ:AAPL"]["price"] == 210.0
assert broker._publish_quote("NASDAQ:AAPL", {"volume": 1002.0})
assert broker._latest["NASDAQ:AAPL"]["volume"] == 1002.0
assert not broker._publish_quote("NASDAQ:AAPL", {
    "lp": 999.0,
    "lp_time": 1786147200,
    "currency_code": "USDT",
})

# A reconnect starts a new upstream generation. Cached quote/session fields
# from the previous socket must disappear until a fresh qsd is received.
broker._publish_status("reconnecting")
assert "NASDAQ:AAPL" not in broker._latest
assert "NASDAQ:AAPL" not in broker._raw_quote_values
assert "NASDAQ:AAPL" not in broker._latest_epoch
reconnecting_snapshot = broker._ordered_snapshot_locked(items)
assert reconnecting_snapshot[0]["price"] is None
assert reconnecting_snapshot[0]["session"] is None

broker.unsubscribe(subscriber.subscriber_id)
broker.close()

# A snapshot waiting for one symbol must not combine another symbol retained
# in its local map from the previous websocket generation with fresh data from
# the replacement connection.
race = module.RealtimeQuoteBroker(2.0)
race_subscriber, _ = race.subscribe(items, "race-stream-owner")
race._publish_status("connected")
assert race._publish_quote("NASDAQ:AAPL", {
    "lp": 210.0,
    "lp_time": 1786147199,
    "currency_code": "USD",
    "prev_close_price": 208.0,
    "current_session": "out_of_session",
})
race_result = {}

def wait_for_race_snapshot():
    race_result["items"], race_result["state"] = race.wait_for_snapshot(
        items,
        "race-snapshot-owner",
        1.0,
    )

race_thread = threading.Thread(target=wait_for_race_snapshot)
race_thread.start()
deadline = time.monotonic() + 1.0
while len(race._subscribers) < 2 and time.monotonic() < deadline:
    time.sleep(0.005)
assert len(race._subscribers) == 2
race._publish_status("reconnecting")
race._publish_status("connected")
assert race._publish_quote("NASDAQ:NBIS", {
    "lp": 187.97,
    "lp_time": 1786147200,
    "currency_code": "USD",
    "prev_close_price": 189.88,
    "current_session": "market",
})
race_thread.join(timeout=2.0)
assert not race_thread.is_alive()
assert race_result["state"] == "connected"
assert race_result["items"][0]["price"] is None
assert race_result["items"][0]["session"] is None
assert race_result["items"][2]["price"] == 187.97
assert race_result["items"][2]["session"] == "market"
race.unsubscribe(race_subscriber.subscriber_id)
race.close()

# Long-lived streams and one-shot workspace snapshots use separate bounded
# capacity. Saturating the local stream pool must not make getQuote fail.
capacity = module.RealtimeQuoteBroker(2.0)
streams = [capacity.subscribe(items, "loopback-owner")[0] for _ in range(
    module.MAX_REALTIME_STREAM_SUBSCRIBERS
)]
try:
    capacity.subscribe(items, "loopback-owner")
except module.RealtimeSubscriptionError as error:
    assert error.code == "subscriber_limit"
else:
    raise AssertionError("stream capacity was not enforced")

snapshot, state = capacity.wait_for_snapshot(
    items,
    "loopback-owner",
    0.0,
)
assert len(snapshot) == len(items)
assert len(capacity._subscribers) == len(streams)
for stream in streams:
    capacity.unsubscribe(stream.subscriber_id)
capacity.close()

# A later subscriber for an unresolved source must force one upstream
# remove/add cycle. This also covers the 1 -> 0 -> 1 race where the worker's
# local subscribed set has not observed the zero-refcount state. Generations
# coalesce multiple subscribers into one re-request.
class FakeWebSocket:
    def __init__(self):
        self.messages = []

    def send_message(self, method, parameters):
        self.messages.append((method, parameters))

nbis = module.parse_realtime_items({"items": [
    {"symbol": "NBIS", "mic": "XNAS"},
]})
recovery = module.RealtimeQuoteBroker(2.0)
fake = FakeWebSocket()
upstream_subscribed = set()
applied_generations = {}

first, first_snapshot = recovery.subscribe(nbis, "recovery-owner")
assert first_snapshot[0]["price"] is None
recovery._synchronize_quote_symbols(
    fake,
    "qs_recovery",
    upstream_subscribed,
    applied_generations,
    recovery._desired_sources(),
)
assert fake.messages == [
    ("quote_add_symbols", ["qs_recovery", "NASDAQ:NBIS"]),
]

fake.messages.clear()
second, _ = recovery.subscribe(nbis, "recovery-owner")
third, _ = recovery.subscribe(nbis, "recovery-owner")
recovery._synchronize_quote_symbols(
    fake,
    "qs_recovery",
    upstream_subscribed,
    applied_generations,
    recovery._desired_sources(),
)
assert fake.messages == [
    ("quote_remove_symbols", ["qs_recovery", "NASDAQ:NBIS"]),
    ("quote_add_symbols", ["qs_recovery", "NASDAQ:NBIS"]),
]

# Remove every downstream reference without synchronizing the worker, then
# immediately add the source again. Its newer generation must still replace
# the stale local upstream subscription.
recovery.unsubscribe(first.subscriber_id)
recovery.unsubscribe(second.subscriber_id)
recovery.unsubscribe(third.subscriber_id)
fourth, _ = recovery.subscribe(nbis, "recovery-owner")
fake.messages.clear()
recovery._synchronize_quote_symbols(
    fake,
    "qs_recovery",
    upstream_subscribed,
    applied_generations,
    recovery._desired_sources(),
)
assert fake.messages == [
    ("quote_remove_symbols", ["qs_recovery", "NASDAQ:NBIS"]),
    ("quote_add_symbols", ["qs_recovery", "NASDAQ:NBIS"]),
]

assert recovery._publish_quote("NASDAQ:NBIS", {
    "lp": 187.97,
    "lp_time": 1786147199,
    "currency_code": "USD",
    "prev_close_price": 189.88,
})
fifth, fifth_snapshot = recovery.subscribe(nbis, "recovery-owner")
assert fifth_snapshot[0]["price"] == 187.97
fake.messages.clear()
recovery._synchronize_quote_symbols(
    fake,
    "qs_recovery",
    upstream_subscribed,
    applied_generations,
    recovery._desired_sources(),
)
assert fake.messages == []

recovery.unsubscribe(fourth.subscriber_id)
recovery.unsubscribe(fifth.subscriber_id)
recovery.close()
module.RealtimeQuoteBroker._run = original_run
print("ok")
`;
  const result = spawnSync("python3", ["-c", script, SIDECAR_URL.pathname], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), "ok");
});
