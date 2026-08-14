import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isWatchlistDeleteShortcut,
  moveWatchlistItemIds,
  nextWatchlistSymbolAfterRemoval,
} from "../src/app/features/watchlist/interactions";
import { translate } from "../src/app/platform/i18n";

const pageSource = readFileSync("src/app/page.tsx", "utf8");
const cssSource = readFileSync("src/app/globals.css", "utf8");

test("manual watchlist ordering moves an item before or after the drop target", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(moveWatchlistItemIds(ids, "a", "c", "before"), ["b", "a", "c", "d"]);
  assert.deepEqual(moveWatchlistItemIds(ids, "a", "c", "after"), ["b", "c", "a", "d"]);
  assert.deepEqual(moveWatchlistItemIds(ids, "d", "b", "before"), ["a", "d", "b", "c"]);
  assert.deepEqual(moveWatchlistItemIds(ids, "d", "b", "after"), ["a", "b", "d", "c"]);
  assert.deepEqual(moveWatchlistItemIds(ids, "a", "a", "after"), ids);
  assert.deepEqual(moveWatchlistItemIds(ids, "missing", "a", "before"), ids);
  assert.deepEqual(ids, ["a", "b", "c", "d"]);
});

test("watchlist delete shortcut accepts Command plus Delete without broadening to Control", () => {
  const keyboardEvent = (overrides: Partial<Parameters<typeof isWatchlistDeleteShortcut>[0]> = {}) => ({
    key: "Backspace",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides,
  });
  assert.equal(isWatchlistDeleteShortcut(keyboardEvent()), true);
  assert.equal(isWatchlistDeleteShortcut(keyboardEvent({ key: "Delete" })), true);
  assert.equal(isWatchlistDeleteShortcut(keyboardEvent({ metaKey: false, ctrlKey: true })), false);
  assert.equal(isWatchlistDeleteShortcut(keyboardEvent({ ctrlKey: true })), false);
  assert.equal(isWatchlistDeleteShortcut(keyboardEvent({ metaKey: false })), false);
  assert.equal(isWatchlistDeleteShortcut(keyboardEvent({ altKey: true })), false);
  assert.equal(isWatchlistDeleteShortcut(keyboardEvent({ shiftKey: true })), false);
  assert.equal(isWatchlistDeleteShortcut(keyboardEvent({ repeat: true })), false);
});

test("deleting the selected row moves selection to the next row, then the previous row", () => {
  const items = [
    { symbol: "AAPL", position: 0 },
    { symbol: "TSLA", position: 1 },
    { symbol: "NBIS", position: 2 },
  ];
  assert.equal(nextWatchlistSymbolAfterRemoval(items, "TSLA"), "NBIS");
  assert.equal(nextWatchlistSymbolAfterRemoval(items, "NBIS"), "TSLA");
  assert.equal(nextWatchlistSymbolAfterRemoval(items, "MISSING"), null);
  assert.equal(nextWatchlistSymbolAfterRemoval([{ symbol: "TSLA", position: 0 }], "TSLA"), null);
});

test("watchlist UI persists drag order and protects editable controls from the delete shortcut", () => {
  assert.match(pageSource, /const canDrag = Boolean\(watchlistItem\) && sort === "manual"/);
  assert.match(pageSource, /className=\{`watch-row[\s\S]+\$\{canDrag \? "is-draggable"/);
  assert.match(pageSource, /draggable=\{canDrag\}/);
  assert.match(pageSource, /onDragStart=\{\(event\) => \{[\s\S]+setDraggedItemId\(watchlistItem\.id\)/);
  assert.match(pageSource, /moveWatchlistItemIds\(currentIds, draggedItemId, targetId, edge\)/);
  assert.match(pageSource, /event\.key === "ArrowUp" \|\| event\.key === "ArrowDown"/);
  assert.doesNotMatch(pageSource, /watch-drag-handle|DotsSixVertical/);
  assert.match(cssSource, /\.watch-row\.is-draggable\s*\{[\s\S]*?cursor: pointer/);
  assert.doesNotMatch(cssSource, /cursor: grab(?:bing)?/);
  assert.doesNotMatch(cssSource, /\.watch-drag-handle|\.watchlist-columns::before/);
  assert.match(pageSource, /\/items\/reorder`/);
  assert.match(pageSource, /method: "PATCH"/);
  assert.match(pageSource, /className="watchlist-panel"[\s\S]+onKeyDownCapture=/);
  assert.match(pageSource, /isEditableKeyboardTarget\(event\.target\)/);
  assert.match(pageSource, /void onDelete\(selectedTicker\)/);
  assert.match(pageSource, /selectedTickerRef\.current === ticker && nextSelectedTicker/);
  assert.doesNotMatch(pageSource, /window\.addEventListener\("keydown", handleDeleteShortcut\)/);
  assert.equal(translate("en", "watchlist.reorderSuccess"), "Watchlist order saved.");
  assert.equal(translate("ja", "watchlist.reorderSuccess"), "ウォッチリストの並び順を保存しました。");
  assert.equal(
    translate("ja", "watchlist.dragSymbol", { symbol: "AAPL" }),
    "AAPLの行をドラッグ、または上下矢印キーで並べ替え",
  );
});
