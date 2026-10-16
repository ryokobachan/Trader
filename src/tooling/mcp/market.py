"""Private Market helper, owned by one stdio MCP process; no Trader installation.

Only text sources are distributed. --setup installs the pinned Python runtime
outside this folder. The parent sends a random token on stdin, and EOF ends us.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import threading
import venv


def main():
    if sys.version_info < (3, 10):
        raise SystemExit("Market requires Python 3.10 or newer.")
    folder = Path(__file__).resolve().parent
    if sys.argv[1:] == ["--setup"]:
        target = Path.home() / ".cache" / "trader-market" / "python"
        venv.EnvBuilder(with_pip=True).create(target)
        subprocess.run([str(target / "bin" / "python"), "-m", "pip", "install", "-r", str(folder / "requirements.txt")], check=True)
        print("Market Python dependencies installed.")
        return
    if sys.argv[1:]:
        raise SystemExit("Unsupported Market helper argument.")
    try:
        import tradingview_websocket  # noqa: F401
        import yfinance  # noqa: F401
        import talib  # noqa: F401
    except ImportError:
        raise SystemExit("Market dependencies missing. Ask Codex to run server.mjs --setup.")
    from sidecar import TradingViewSidecarServer, TradingViewSidecarHandler, configured_latest_close_exchanges

    class MarketHandler(TradingViewSidecarHandler):
        def do_GET(self):
            if self.path.startswith("/v1/shared-data/"):
                self.send_json(404, {"error": "not_found"})
                return
            super().do_GET()

        def log_message(self, *_args):
            pass

    token = sys.stdin.readline().strip()
    if len(token) != 64:
        raise SystemExit("Missing private Market session.")
    server = TradingViewSidecarServer(("127.0.0.1", 0), token, 20.0, configured_latest_close_exchanges(None))
    server.RequestHandlerClass = MarketHandler
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    thread.start()
    print(json.dumps({"port": server.server_port}), flush=True)
    try:
        # Parent exits/closes stdin on MCP disconnect, including abrupt parent death.
        sys.stdin.read()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print upstream payloads, environment values or credentials.
        sys.stderr.write("Market helper could not complete the operation.\n")
        sys.exit(1)
