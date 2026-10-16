# Trader local server

The local Trader server at `http://localhost:3001` is a persistent,
user-owned service. It is managed by the macOS LaunchAgent
`com.ryotarokobayashi.unicorn-local`.

- Never stop, unload, or kill this service as task cleanup.
- Reuse the existing server instead of starting an ad-hoc server on port 3001.
- If a separate test server is necessary, use another port and stop only the
  process started for that test.
- When a restart is required for Trader itself, restart the LaunchAgent with
  `launchctl kickstart -k gui/$(id -u)/com.ryotarokobayashi.unicorn-local`, wait
  for `http://127.0.0.1:3001/` to return HTTP 200, and leave it running.
- Before finishing work that could affect the server, verify both the
  LaunchAgent and the HTTP endpoint are healthy.

# Data access for AI agents

- Use `./bin/trader data sources` to discover supported datasets and
  `./bin/trader data describe <dataset>` for parameters, provenance and limits.
  Both commands work without a running server. See [docs/data-cli.md](docs/data-cli.md).
- Filter inputs with `data sources --category input` and comparison results with
  `data sources --category result`. `data openapi` exposes the same contract to
  other applications; canonical HTTP reads are `/api/v1/data/<dataset>`.
- 13F and X datasets read the independent `develop/.data` finance stores directly,
  without Midas. Follow `pagination.nextCursor` even for an empty page; preserve
  the publication revision and restart explicitly on a revision conflict.
  Shared stores are mutable, and `asOf` does not reconstruct overwritten versions.
- Use `./bin/trader data get <dataset> ...` for the existing Trader HTTP API;
  it returns the original JSON to stdout, with JSON errors on stderr and a
  nonzero exit status on failure. Prefer this to scraping the browser UI.
- Preserve source, date labels, missing values, coverage, warnings and data mode.
  Exit 0 can contain partial or empty data; fixture data is not a live quote.
- For external option history, use `options-history` with the exact contract
  or expiration/side/strike and optional inclusive `--from`/`--to`. Expired
  contracts do not require a current chain. Availability depends on upstream
  retention; do not promise that all historical dates can be retrieved forever.
- Do not automatically save option datasets, shift dates to align providers,
  fill missing data, or silently change the requested source. OI publication
  time is unverified; it must not be treated as known at that date's open.
- Existing strategy commands remain available under `./bin/trader strategy`;
  data retrieval does not execute a strategy or backtest.
