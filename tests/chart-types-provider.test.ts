import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveChartTypeId, toHeikinAshiBars } from "../src/app/features/chart-types/chart-types";

test("Heikin Ashi uses the official first-bar and recursive formulas", () => {
  const source = [
    { time: "2026-08-07", open: 10, high: 16, low: 8, close: 14, volume: 100 },
    { time: "2026-08-08", open: 14, high: 18, low: 11, close: 17, volume: 120 },
  ] as const;
  const result = toHeikinAshiBars(source);

  assert.deepEqual(result[0], {
    ...source[0],
    open: 12,
    high: 16,
    low: 8,
    close: 12,
  });
  assert.deepEqual(result[1], {
    ...source[1],
    open: 12,
    high: 18,
    low: 11,
    close: 15,
  });
});

test("Heikin Ashi conversion does not mutate source bars", () => {
  const source = [{ time: "2026-08-07", open: 10, high: 16, low: 8, close: 14 }];
  const snapshot = structuredClone(source);
  const result = toHeikinAshiBars(source);

  assert.deepEqual(source, snapshot);
  assert.notEqual(result[0], source[0]);
});

test("chart type resolver accepts canonical IDs and migrates old labels", () => {
  assert.equal(resolveChartTypeId("heikin-ashi"), "heikin-ashi");
  assert.equal(resolveChartTypeId("平均足"), "heikin-ashi");
  assert.equal(resolveChartTypeId("ローソク"), "candles");
  assert.equal(resolveChartTypeId("unknown"), null);
});

test("Heikin Ashi volume colors follow the displayed candle direction", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(pageSource, /const displayVolumes = useMemo/);
  assert.match(pageSource, /candle\.close >= candle\.open/);
  assert.match(pageSource, /volumeSeries\.setData\(displayVolumes/);
});
