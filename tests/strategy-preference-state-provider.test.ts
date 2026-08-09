import assert from "node:assert/strict";
import test from "node:test";

import { mergeStrategyPreferenceSnapshots } from "../src/app/features/strategy/strategy-preference-state";
import type { StrategyPreference } from "../src/app/platform/strategy-preference-contracts";

function preference(
  strategyId: string,
  updatedAt: string,
  overrides: Partial<StrategyPreference> = {},
): StrategyPreference {
  return {
    strategyId,
    isDeleted: false,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt,
    ...overrides,
  };
}

test("a stale preference read cannot resurrect a newer tombstone", () => {
  const tombstone = preference("sample-a", "2026-08-09T02:00:00.000Z", {
    isDeleted: true,
    deletedAt: "2026-08-09T02:00:00.000Z",
  });
  const staleOverride = preference("sample-a", "2026-08-09T01:00:00.000Z", {
    name: "Old name",
  });

  assert.deepEqual(
    mergeStrategyPreferenceSnapshots([tombstone], [staleOverride]),
    [tombstone],
  );
});

test("newer preference snapshots replace older overrides and retain unrelated rows", () => {
  const older = preference("sample-a", "2026-08-09T01:00:00.000Z", { name: "Old" });
  const newer = preference("sample-a", "2026-08-09T03:00:00.000Z", { name: "New" });
  const other = preference("sample-b", "2026-08-09T02:00:00.000Z", { headline: "Keep" });

  assert.deepEqual(
    mergeStrategyPreferenceSnapshots([older, other], [newer]),
    [newer, other],
  );
});

test("equal timestamps keep the already-applied local mutation", () => {
  const local = preference("sample-a", "2026-08-09T02:00:00.000Z", {
    isDeleted: true,
    deletedAt: "2026-08-09T02:00:00.000Z",
  });
  const read = preference("sample-a", "2026-08-09T02:00:00.000Z", { name: "Stale" });

  assert.deepEqual(mergeStrategyPreferenceSnapshots([local], [read]), [local]);
});
