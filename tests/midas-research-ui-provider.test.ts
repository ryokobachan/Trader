import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  formatMidasPercent,
  formatMidasRate,
  midasDataSourceStorage,
  midasXAccountStrategyReturn,
  visibleMidasDataSources,
  visibleMidasIdeas,
  type MidasXAccount,
} from "../src/app/features/midas/research-contracts";

test("filters the Midas catalogs to the records surfaced by their source screens", () => {
  assert.deepEqual(
    visibleMidasIdeas([
      { id: "ready", name: "Ready", category: "A", subcategory: "B", data_needs: [], status: "implemented", buildable_spec: { feasibility: "buildable_now" } },
      { id: "blocked", name: "Blocked", category: "A", subcategory: "B", data_needs: [], status: "implemented", buildable_spec: { feasibility: "infeasible" } },
    ]).map((idea) => idea.id),
    ["ready"],
  );
  assert.deepEqual(
    visibleMidasDataSources([
      { id: "source", display_name: "Source", semantics: { catalog_role: "data_source" } },
      { id: "operation", display_name: "Operation", semantics: { catalog_role: "operational" } },
    ]).map((source) => source.id),
    ["source"],
  );
});

test("uses the published common-strategy return for X account performance", () => {
  const account = {
    commonStrategy: { status: "ready", netReturn: 0.031, completedTradeCount: 12, entryCohortCount: 4 },
    avgNetReturn: -0.2,
  } as MidasXAccount;
  assert.equal(midasXAccountStrategyReturn(account), 0.031);
  assert.equal(formatMidasPercent(midasXAccountStrategyReturn(account)), "+3.1%");
  assert.equal(formatMidasRate(0.557768), "55.8%");
});

test("shows file-backed Midas sources without requiring a database table", () => {
  assert.equal(midasDataSourceStorage({
    id: "x-live",
    display_name: "X live rankings",
    backing: { path: "runtime/x-analysis/live-rankings.json" },
  }), "runtime/x-analysis/live-rankings.json");
});

test("research data uses the canonical independent reader while Ideas retain their existing surface", async () => {
  const component = await readFile(new URL("../src/app/features/midas/MidasResearchView.tsx", import.meta.url), "utf8");
  const dataView = await readFile(new URL("../src/app/features/data/DataAccessView.tsx", import.meta.url), "utf8");
  assert.match(component, /<DataAccessView/);
  assert.match(component, /\/api\/v1\/midas\/ideas/);
  assert.doesNotMatch(dataView, /\/api\/v1\/midas/);
  assert.match(dataView, /\/api\/v1\/data/);
});
