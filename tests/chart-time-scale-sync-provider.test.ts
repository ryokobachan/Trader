import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { LogicalRange } from "lightweight-charts";

import { createChartTimeScaleSync } from "../src/app/features/chart-sync/chart-time-scale-sync";

const range = (from: number, to: number) => ({ from, to }) as LogicalRange;

test("time-scale sync replays the latest logical range without React state", () => {
  const sync = createChartTimeScaleSync();
  const first: Array<LogicalRange | null> = [];
  const second: Array<LogicalRange | null> = [];
  const unsubscribeFirst = sync.subscribe((value) => first.push(value));

  sync.publish(range(10.5, 44.25));
  sync.subscribe((value) => second.push(value));
  sync.publish(range(12, 48));
  unsubscribeFirst();
  sync.publish(range(20, 52));

  assert.deepEqual(first, [range(10.5, 44.25), range(12, 48)]);
  assert.deepEqual(second, [range(10.5, 44.25), range(12, 48), range(20, 52)]);
  assert.deepEqual(sync.snapshot(), range(20, 52));
});

test("time-scale sync suppresses duplicate ranges and normalizes invalid input", () => {
  const sync = createChartTimeScaleSync();
  const received: Array<LogicalRange | null> = [];
  sync.subscribe((value) => received.push(value));

  sync.publish(range(0, 10));
  sync.publish(range(0, 10));
  sync.publish(range(12, 4));
  sync.publish(range(Number.NaN, 20));

  assert.deepEqual(received, [range(0, 10), null]);
});

test("price chart drives passive indicator panes over a shared complete timeline", async () => {
  const [pageSource, paneSource] = await Promise.all([
    readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/features/chart-indicators/SubIndicatorPanes.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(pageSource, /subscribeVisibleLogicalRangeChange\(publishVisibleRange\)/);
  assert.match(pageSource, /timeScaleSync=\{chartTimeScaleSync\}/);
  assert.match(pageSource, /minimumWidth: SYNCHRONIZED_PRICE_SCALE_MIN_WIDTH/);
  assert.match(paneSource, /handleScroll: false/);
  assert.match(paneSource, /handleScale: false/);
  assert.match(paneSource, /minimumWidth: SYNCHRONIZED_PRICE_SCALE_MIN_WIDTH/);
  assert.match(paneSource, /finiteMarketBars\(bars\)[\s\S]*\.map/);
  assert.match(paneSource, /setVisibleLogicalRange\(range\)/);
});
