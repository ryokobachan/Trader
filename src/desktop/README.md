# Trader desktop runtime

This directory contains all source and configuration used for the Apple
Silicon macOS app: the loading frontend, bundled runtime, native Tauri shell,
icons, and build preparation. It lets the existing Vinext application run
without requiring the user to start a development server or install Bun or
Python.

## Runtime architecture

`Trader.app` uses Tauri and the macOS system WebView. At startup the Rust shell:

1. starts the frozen TradingView/yfinance market helper on an ephemeral
   `127.0.0.1` port;
2. starts the compiled Bun runtime on a separate ephemeral loopback port;
3. passes the market helper address and a random bearer token only to the Bun
   child process;
4. opens the runtime's one-time bootstrap URL in the WebView; and
5. terminates both process groups when the app exits.

The Bun runtime invokes the existing compiled Vinext Worker and serves
`dist/client` and `dist/server` from the application bundle. This preserves the
web app's pages, API routes, validation, streaming endpoints, and provider
adapters rather than maintaining a desktop-specific route map.

`d1-bun.mjs` provides the D1 methods used by Trader on top of Bun's native
SQLite implementation. The hosted build continues to use D1; only the desktop
binding is replaced.

## Market data behavior

The packaged market helper contains its own Python 3.12 runtime and pinned
TradingView/yfinance dependencies. TradingView supplies quotes and chart bars
when the helper is healthy. The application falls back to Yahoo quote/bar
polling if that helper cannot start. Yahoo-compatible adapters also provide
search, profile, fundamentals, earnings, and news data, while the configured
Benzinga-compatible adapter supplies analyst data.

No system Python or provider credential file is required to run the installed
app. Live data still requires an internet connection and remains subject to
provider availability, terms, and exchange entitlements.

Desktop and standalone development share the role defaults in
`api/local-provider-profile.json`. Rust embeds this profile into the native
executable, so the installed app does not read the source checkout or a dotenv
file. The profile enables Yahoo company research (ownership, corporate actions,
and supplemental cash-flow data), TradingView financials and earnings, and the
Google Finance/Benzinga analyst adapter. If the market helper cannot start,
quotes, bars, financials, and earnings use Yahoo instead.

## Build pipeline

`prepare.mjs` creates every input required by Tauri:

1. builds the normal Vinext client and Worker;
2. builds the small desktop loading screen into `frontend-dist/`;
3. compiles `server.mjs` into the architecture-specific Bun executable; and
4. freezes and smoke-tests the market helper with PyInstaller.

The current target is Apple Silicon macOS 14 or newer. A source build requires
the Xcode Command Line Tools, stable Rust, Node.js 22.13 or newer, Bun, and an
arm64 Python 3.12 interpreter. From the repository root:

```bash
npm install
npm run desktop:dev
```

For a local distributable build:

```bash
npm run desktop:build
```

The application is written to
`build/Trader.app`. Temporary Tauri, frontend, and sidecar build directories
are removed automatically after the copied app passes verification.

Set `TRADER_DESKTOP_LIVE_SMOKE=1` when running `npm run desktop:prepare` to
include live provider checks in the market-helper build. The default build
smoke test does not depend on live provider availability.

`desktop:build` deliberately creates an ad-hoc signed, non-notarized local
build. A release for other users requires a separately validated Developer ID
signing and notarization pipeline. The build also remaps Rust source paths and
clears provider credential variables before compilation. It fails if the
finished application still contains the builder's home-directory path or any
provider-secret value that was present in the invoking environment.

## Security and lifecycle boundaries

- Both HTTP services bind only to `127.0.0.1` and use unpredictable ports.
- The market helper requires a per-launch bearer token.
- The application runtime exchanges a single-use bootstrap token for an
  HttpOnly, SameSite session cookie and rejects cross-site requests.
- Tauri navigation is restricted to its packaged loading page and the exact
  runtime port chosen for that launch.
- External HTTP(S) links open in the system browser instead of navigating the
  application WebView.
- Helpers are spawned without a shell and are terminated as process groups on
  application exit.
- Provider secrets and dotenv files are not bundled.

## Local state and recovery

Tauri writes desktop state to:

```text
~/Library/Application Support/com.ryokobachan.trader/
  trader.sqlite3
  trader-desktop.log
```

SQLite stores watchlists, strategy overrides, custom strategies, transaction
history, and related audit state. Quit Trader before backing up the directory
so SQLite can close its WAL cleanly. To reset only the SQLite-backed state,
quit the app and move `trader.sqlite3` and any sibling `trader.sqlite3-wal` or
`trader.sqlite3-shm` files aside. A new database is created on the next launch.
WebView-managed interface preferences are separate from this database.

The log is intended for local startup and runtime diagnostics and can be
removed while Trader is not running.

## Icon appearance

The canonical artwork contains the ribbon foreground only. Do not bake a rounded
background tile, frame, or blue/black panel into it: on macOS Tahoe with Dark
icon style, IconServices supplies the shared dark background and edge treatment.
The native rendered icon must be checked in addition to inspecting the PNG.
The local macOS 26.3.1 verification compared the background of the rendered
Trader icon with Codex and Terminal; this does not claim full Icon Composer
appearance-variant support on other macOS versions.

Apple describes the system masking and appearance treatment in the
[app icon guidelines](https://developer.apple.com/design/human-interface-guidelines/app-icons)
and the separation of foreground artwork from backgrounds in the
[Icon Composer workflow](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer).
