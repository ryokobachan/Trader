import assert from "node:assert/strict";
import test from "node:test";

import { resolveInstrumentSearchView } from "../app/features/instrument-search/search-state";

test("shows loading while an empty-query candidate search begins", () => {
  assert.equal(resolveInstrumentSearchView("idle", 0), "loading");
});

test("keeps loading and error states exclusive from previous results", () => {
  assert.equal(resolveInstrumentSearchView("loading", 12), "loading");
  assert.equal(resolveInstrumentSearchView("error", 12), "error");
});

test("distinguishes provider results from an empty completed search", () => {
  assert.equal(resolveInstrumentSearchView("ready", 2), "results");
  assert.equal(resolveInstrumentSearchView("ready", 0), "empty");
});
