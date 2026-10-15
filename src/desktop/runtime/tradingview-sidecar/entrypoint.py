"""Frozen entry point for the existing TradingView/yfinance sidecar.

The spec stages ``api/tradingview-websocket/sidecar.py`` under the importable
module name below. Importing it before ``freeze_support`` makes its worker
functions available while PyInstaller handles a macOS ``spawn`` child.
"""

from __future__ import annotations

import _thread
import multiprocessing
import os
import stat
import sys
import threading
import time

import trader_tradingview_sidecar


def exit_when_parent_stdin_closes() -> None:
    """End the helper when the desktop parent's stdin pipe reaches EOF."""
    try:
        while os.read(sys.stdin.fileno(), 4_096):
            pass
    except OSError:
        pass
    # The original main() already treats KeyboardInterrupt as a clean shutdown,
    # closes the HTTP server, and lets multiprocessing reap daemon workers.
    _thread.interrupt_main()
    time.sleep(5.0)
    # Retain a bounded fail-safe if the main thread is unexpectedly wedged.
    os._exit(0)


def start_parent_watch() -> None:
    try:
        stdin_is_pipe = stat.S_ISFIFO(os.fstat(sys.stdin.fileno()).st_mode)
    except OSError:
        stdin_is_pipe = False
    if (
        os.environ.get("TRADER_MARKET_SIDECAR_EXIT_ON_STDIN_EOF", "1") == "0"
        or not stdin_is_pipe
    ):
        return
    threading.Thread(
        target=exit_when_parent_stdin_closes,
        name="trader-parent-watch",
        daemon=True,
    ).start()


def main() -> None:
    multiprocessing.freeze_support()
    start_parent_watch()
    trader_tradingview_sidecar.main()


if __name__ == "__main__":
    main()
