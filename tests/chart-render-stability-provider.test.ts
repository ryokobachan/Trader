import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

test("chart indicator props keep stable identities across unrelated Home renders", () => {
  assert.match(pageSource, /const activeIndicatorDefinitions = useMemo\(/);
  assert.match(pageSource, /const visibleIndicatorDefinitions = useMemo\(/);
  assert.match(pageSource, /const visibleIndicatorIds = useMemo\(/);
  assert.match(pageSource, /const subIndicatorSpecs:[\s\S]*= useMemo\(/);
});

test("chart, legend, subpanes, and snapshots only receive bars for the selected symbol", () => {
  assert.match(pageSource, /marketBarsSymbol === selectedTicker \? marketBars : \[\]/);
  assert.match(pageSource, /<PriceChart stock=\{stock\} marketBars=\{detailMarketBars\}/);
  assert.match(pageSource, /<SubIndicatorPanes bars=\{detailMarketBars\}/);
  assert.doesNotMatch(pageSource, /<PriceChart stock=\{stock\} marketBars=\{marketBars\}/);
});

test("toast replacement clears the previous timeout", () => {
  assert.match(pageSource, /toastTimerRef\.current !== null\) window\.clearTimeout\(toastTimerRef\.current\)/);
  assert.match(pageSource, /toastTimerRef\.current = window\.setTimeout/);
});
