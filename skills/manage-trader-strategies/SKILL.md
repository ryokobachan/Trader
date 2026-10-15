---
name: manage-trader-strategies
description: Explore, compare, and manage Trader strategies and their portfolio transactions through the repository's supported CLI and HTTP API. Use when an agent needs to filter or rank registered strategies, compare candidates, inspect performance provenance, create, duplicate, edit, or delete a strategy, or read and change its trade history. Do not use this skill to edit the D1 database, migration files, or built-in strategy catalog directly.
---

# Manage Trader Strategies

Use Trader's `strategy` CLI as the only mutation boundary. The CLI calls the same owner-scoped API as the UI, so command-line and browser state stay consistent.

## Locate the repository

Resolve the directory containing this `SKILL.md`, then use its repository root (two levels above the skill directory) when that directory contains `package.json`. Otherwise locate the nearest ancestor containing both `package.json` and `skills/manage-trader-strategies/SKILL.md`. Do not use a personal absolute path or guess a database path.

## Check availability

Run a read-only command first:

```bash
npm run strategy -- list
```

The CLI uses `http://localhost:3001` by default. Set `TRADER_BASE_URL` or pass `--base-url https://...` for another deployment. If the API is unavailable, report that clearly; start a development server only when doing so is within the user's request.

## Follow the safe workflow

1. Inspect the target with `list` or `get` before changing it.
2. Use the returned stable strategy ID. Never infer an ID from a display name.
3. For edits, preserve the returned `version` and send it as `expectedVersion` so concurrent changes fail instead of being overwritten.
4. Use JSON files for non-trivial payloads. Keep temporary files outside the repository or remove them after the command.
5. After every mutation, fetch the affected strategy or transaction again and verify the result.
6. Report the strategy ID, operation, and returned version. Do not expose owner IDs, credentials, or raw D1 state.

## Read strategies and performance

Use:

```bash
npm run strategy -- list
npm run strategy -- get <strategy-id>
npm run strategy -- get <strategy-id> --include transactions,performance
npm run strategy -- performance get <strategy-id>
```

## Explore registered strategies

Use `list` to narrow the registered catalog before fetching full detail:

```bash
npm run strategy -- list --family rule --source "RSI 14" --provenance illustrative_catalog --sort sharpe --order desc --limit 10
npm run strategy -- list --query "AAPL" --origin custom --sort updatedAt --limit 20
npm run strategy -- compare <strategy-id-a> <strategy-id-b> --sort netReturn
```

Apply this workflow:

1. Filter by `family`, `status`, `origin`, source label, or provenance.
2. Rank only a methodologically compatible provenance cohort. Null metrics always sort last.
3. Compare two to twenty stable IDs with `compare`; inspect its provenance groups and disclosures.
4. Fetch finalists with `get <id> --include transactions,performance` before drawing a conclusion.
5. State whether a metric is illustrative, user-supplied, transaction-derived, or unavailable.

This explores strategies already registered in Trader. It does not generate candidates, execute strategy rules, search a parameter space, fetch market data, or run a backtest. Use a dedicated research/backtest workflow for those tasks, then save reviewed results through this CLI.

Treat performance according to its `provenance`:

- `illustrative_catalog`: built-in sample values, not verified backtest results.
- `user_supplied`: values supplied by a user or agent; preserve them but do not imply independent verification.
- `transaction_snapshot`: exact activity derived from persisted transactions; currently trade and distinct-symbol counts only.
- `unavailable`: do not invent missing metrics.

Never describe illustrative or unavailable Sharpe, drawdown, holdings, or returns as measured performance.
For `illustrative_catalog`, `trades` and `symbols` are sample catalog metadata,
not counts of rows persisted in D1. Use the returned `transactions` array for
the actual saved transaction count. The `cash` metric is a portfolio allocation
percentage, not a currency amount.

## Create or edit strategies

Prefer a reviewed JSON payload:

```bash
npm run strategy -- create --file /tmp/trader-strategy.json
npm run strategy -- edit <strategy-id> --file /tmp/trader-strategy-edit.json
```

Built-in strategies remain deployment-owned. Their supported editable fields are saved as owner-specific overrides. New strategies are owner-scoped custom records.

To duplicate, inspect the source, remove server-owned fields such as `strategyId`, `origin`, `version`, and timestamps, give the copy a distinct name, then create it as a custom strategy.

## Manage transactions

Use the transaction subcommands:

```bash
npm run strategy -- transactions list <strategy-id>
npm run strategy -- transactions get <strategy-id> <transaction-id>
npm run strategy -- transactions add <strategy-id> --file /tmp/transaction.json
npm run strategy -- transactions edit <strategy-id> <transaction-id> --file /tmp/transaction-edit.json --updated-at <updatedAt>
npm run strategy -- transactions delete <strategy-id> <transaction-id> --yes
```

Transaction reads must remain read-only. Do not initialize demo trades implicitly. Preserve exact dates, symbols, sides, shares, prices, and fees supplied by the user.
Immediately before editing, run `transactions get` and copy its exact
`updatedAt` into the edit payload as `expectedUpdatedAt` (or pass it with
`--updated-at`). A `409 transaction_changed` response means another writer won;
re-read the transaction and review the newer values instead of retrying blindly.

## Delete safely

Only delete when the user's intent is explicit. Inspect the target immediately before deletion, then run:

```bash
npm run strategy -- delete <strategy-id> --version <version> --yes
```

Deletion is soft and audited, but treat it as destructive in the UI. Never add `--yes` merely to bypass uncertainty. A version conflict means the target changed; stop, re-read, and ask for direction if the newer state changes the user's intent.

## Handle failures

The CLI writes machine-readable JSON and exits nonzero on failure. Preserve its `status`, `code`, `message`, and `requestId` in diagnostics. For `409 version_conflict`, re-read before retrying. For `401`, do not fabricate identity headers. For `404`, verify the stable ID and whether the strategy was deleted.

Read [references/commands.md](references/commands.md) when constructing discovery commands, comparisons, create/edit payloads, or transaction JSON.
