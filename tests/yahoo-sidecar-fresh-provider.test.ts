import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Yahoo sidecar fresh reads bypass a completed cache but still share in-flight work", () => {
  const script = String.raw`
import importlib.util
import sys
import threading
import time
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("unicorn_sidecar_fresh", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

server = SimpleNamespace(
    yahoo_lock=threading.Lock(),
    yahoo_cache={},
    yahoo_inflight={},
    fetch_timeout_seconds=1.0,
)
calls = []

def load():
    calls.append(len(calls) + 1)
    return {"version": calls[-1]}

first = module.cached_yahoo_payload(server, ("earnings", "AAPL", 24), 300, load)
cached = module.cached_yahoo_payload(server, ("earnings", "AAPL", 24), 300, load)
fresh = module.cached_yahoo_payload(
    server, ("earnings", "AAPL", 24), 300, load, force_refresh=True
)
assert first == {"version": 1}
assert cached == first
assert fresh == {"version": 2}
assert calls == [1, 2]

leader_started = threading.Event()
release_leader = threading.Event()
results = []

def slow_load():
    calls.append(len(calls) + 1)
    leader_started.set()
    release_leader.wait(1.0)
    return {"version": calls[-1]}

def request_fresh():
    results.append(module.cached_yahoo_payload(
        server, ("earnings", "MSFT", 24), 300, slow_load, force_refresh=True
    ))

leader = threading.Thread(target=request_fresh)
follower = threading.Thread(target=request_fresh)
leader.start()
assert leader_started.wait(1.0)
follower.start()
time.sleep(0.02)
release_leader.set()
leader.join(1.0)
follower.join(1.0)
assert not leader.is_alive() and not follower.is_alive()
assert len(results) == 2 and results[0] == results[1]
assert calls == [1, 2, 3]
`;
  const result = spawnSync(
    "python3",
    ["-", "api/tradingview-websocket/sidecar.py"],
    { cwd: process.cwd(), input: script, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
