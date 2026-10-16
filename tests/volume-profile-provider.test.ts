import assert from "node:assert/strict";
import test from "node:test";
import type { IPrimitivePaneRenderer, SeriesAttachedParameter } from "lightweight-charts";
import { calculateVolumeProfile, visibleBarIndices } from "../src/app/features/volume-profile/volume-profile";
import { VolumeProfilePrimitive } from "../src/app/features/volume-profile/volume-profile-primitive";

test("distributes volume by price overlap and identifies the largest volume band", () => {
  const profile = calculateVolumeProfile([
    { low: 10, high: 30, volume: 200 },
    { low: 10, high: 15, volume: 80 },
    { low: 15, high: 25, volume: 60 },
  ], 2);
  assert.deepEqual(profile.bins, [
    { low: 10, high: 20, volume: 210 },
    { low: 20, high: 30, volume: 130 },
  ]);
  assert.equal(profile.totalVolume, 340);
  assert.equal(profile.pointOfControlIndex, 0);
});

test("preserves volume across fractional prices, gaps, and zero-range bars at the upper edge", () => {
  const bars = [
    { low: 103.31, high: 107.97, volume: 1729938 },
    { low: 105.06, high: 116.13, volume: 928827 },
    { low: 125.72, high: 125.72, volume: 572984 },
  ];
  for (const rows of [1, 2, 40, 200]) {
    const profile = calculateVolumeProfile(bars, rows);
    const sum = profile.bins.reduce((total, bin) => total + bin.volume, 0);
    assert.ok(Math.abs(sum - profile.totalVolume) < profile.totalVolume * 1e-10);
    assert.ok(profile.bins.at(-1)!.volume >= bars[2].volume);
  }
});

test("flat prices have one finite band and zero or missing volume does not fabricate a profile", () => {
  const flat = calculateVolumeProfile([{ low: 10, high: 10, volume: 42 }]);
  assert.equal(flat.bins.length, 1);
  assert.equal(flat.bins[0].volume, 42);
  assert.ok(flat.bins[0].low < 10 && flat.bins[0].high > 10);
  const empty = calculateVolumeProfile([
    { low: 10, high: 20, volume: 0 },
    { low: 10, high: 20, volume: NaN },
    { low: 10, high: 20, volume: -1 },
    { low: 30, high: 20, volume: 100 },
    { low: 10, high: Infinity, volume: 100 },
  ]);
  assert.deepEqual(empty.bins, []);
  assert.equal(empty.pointOfControlIndex, -1);
});

test("only visible candle indices contribute, including when scrolled beyond either edge", () => {
  assert.deepEqual(visibleBarIndices(100, { from: 10.2, to: 20.8 }), [11, 21]);
  assert.deepEqual(visibleBarIndices(100, { from: -10, to: 3 }), [0, 4]);
  assert.deepEqual(visibleBarIndices(100, { from: 95, to: 110 }), [95, 100]);
  assert.deepEqual(visibleBarIndices(100, { from: 101, to: 130 }), [0, 0]);
  assert.deepEqual(visibleBarIndices(100, { from: -10, to: -1 }), [0, 0]);
  assert.deepEqual(visibleBarIndices(100, null), [0, 0]);
});

test("native rendering follows horizontal and vertical view changes, refreshes, and detach", () => {
  let range = { from: 0, to: 0 };
  let scale = 2;
  const rectangles: number[][] = [];
  const context = {
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillText() {},
    fillRect: (...rectangle: number[]) => rectangles.push(rectangle),
  };
  const target = {
    useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: { width: 800, height: 600 } }),
  } as Parameters<IPrimitivePaneRenderer["draw"]>[0];
  const primitive = new VolumeProfilePrimitive();
  primitive.attached({
    chart: { timeScale: () => ({ getVisibleLogicalRange: () => range }) },
    series: { priceToCoordinate: (price: number) => 600 - price * scale },
    requestUpdate() {},
  } as unknown as SeriesAttachedParameter);
  primitive.setData([{ low: 10, high: 20, volume: 100 }, { low: 100, high: 120, volume: 200 }]);
  const render = () => {
    rectangles.length = 0;
    primitive.updateAllViews();
    primitive.paneViews()[0].renderer()!.draw(target);
    return rectangles.map((rectangle) => [...rectangle]);
  };
  const first = render();
  assert.equal(first.length, 40);
  assert.ok(first.every((rectangle) => rectangle[1] >= 560));
  primitive.setOptions({ rowCount: 20, color: "#aabbcc" });
  assert.equal(render().length, 20);
  primitive.setOptions({ rowCount: 40, color: "#6495ed" });
  range = { from: 1, to: 1 };
  assert.ok(render().every((rectangle) => rectangle[1] >= 360 && rectangle[1] < 400));
  scale = 3;
  assert.ok(render().every((rectangle) => rectangle[1] >= 240 && rectangle[1] < 300));
  primitive.setData([{ low: 10, high: 20, volume: 100 }, { low: 100, high: 120, volume: 0 }]);
  assert.deepEqual(render(), []);
  primitive.setData([{ low: 10, high: 20, volume: 100 }]);
  range = { from: 0, to: 0 };
  assert.equal(render().length, 40);
  primitive.detached();
  assert.deepEqual(render(), []);
});
