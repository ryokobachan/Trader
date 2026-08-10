import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_RIGHT_PANEL_WIDTH,
  DEFAULT_WATCHLIST_SPLIT_PERCENT,
  MAX_RIGHT_PANEL_WIDTH,
  MAX_WATCHLIST_SPLIT_PERCENT,
  MIN_RIGHT_PANEL_WIDTH,
  MIN_WATCHLIST_SPLIT_PERCENT,
  parseWorkspaceLayoutPreferences,
  rightPanelMaxForViewport,
  serializeWorkspaceLayoutPreferences,
} from "../src/app/features/workspace-layout/panel-sizing";

test("workspace panel sizing defaults safely and clamps persisted values", () => {
  assert.deepEqual(parseWorkspaceLayoutPreferences(null), {
    rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
    watchlistSplitPercent: DEFAULT_WATCHLIST_SPLIT_PERCENT,
  });
  assert.deepEqual(parseWorkspaceLayoutPreferences("not-json"), {
    rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
    watchlistSplitPercent: DEFAULT_WATCHLIST_SPLIT_PERCENT,
  });
  assert.deepEqual(parseWorkspaceLayoutPreferences(JSON.stringify({
    schemaVersion: "unicorn.workspace-layout.v1",
    rightPanelWidth: 10_000,
    watchlistSplitPercent: -20,
  })), {
    rightPanelWidth: MAX_RIGHT_PANEL_WIDTH,
    watchlistSplitPercent: MIN_WATCHLIST_SPLIT_PERCENT,
  });
});

test("workspace panel maximum matches the responsive width shown to users", () => {
  assert.equal(rightPanelMaxForViewport(1440), MAX_RIGHT_PANEL_WIDTH);
  assert.equal(rightPanelMaxForViewport(1000), 400);
  assert.equal(rightPanelMaxForViewport(981), 392);
  assert.equal(rightPanelMaxForViewport(980), MAX_RIGHT_PANEL_WIDTH);
});

test("workspace panel sizing serializes only its bounded versioned contract", () => {
  const serialized = serializeWorkspaceLayoutPreferences({
    rightPanelWidth: MIN_RIGHT_PANEL_WIDTH - 100,
    watchlistSplitPercent: MAX_WATCHLIST_SPLIT_PERCENT + 100,
  });
  assert.deepEqual(JSON.parse(serialized), {
    schemaVersion: "unicorn.workspace-layout.v1",
    rightPanelWidth: MIN_RIGHT_PANEL_WIDTH,
    watchlistSplitPercent: MAX_WATCHLIST_SPLIT_PERCENT,
  });
});

test("workspace wires keyboard-accessible outer and inner resize handles", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const cssSource = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(pageSource, /className="right-panel-resizer"/);
  assert.match(pageSource, /className="watchlist-split-resizer"/);
  assert.match(pageSource, /role="separator"/);
  assert.match(pageSource, /WORKSPACE_LAYOUT_STORAGE_KEY/);
  assert.match(cssSource, /--right-panel-width/);
  assert.match(cssSource, /--watchlist-split-percent/);
  assert.doesNotMatch(cssSource, /grid-template-columns:[^;\n]*min\(var\(--right-panel-width/);
  assert.match(pageSource, /aria-valuemax=\{rightPanelMaxWidth\}/);
});
