import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { LogicalRange } from "lightweight-charts";

import {
  EMPTY_CHART_DATA_LIFECYCLE,
  planChartDataUpdate,
} from "../src/app/features/chart-sync/chart-data-lifecycle";

function range(from: number, to: number): LogicalRange {
  return { from, to } as LogicalRange;
}

test("the first populated chart snapshot fits even when loading first produced an empty snapshot", () => {
  const empty = planChartDataUpdate({
    previous: EMPTY_CHART_DATA_LIFECYCLE,
    identity: "AAPL:5y:1d",
    pointCount: 0,
    visibleLogicalRange: null,
  });
  const populated = planChartDataUpdate({
    previous: empty.nextState,
    identity: "AAPL:5y:1d",
    pointCount: 250,
    visibleLogicalRange: null,
  });

  assert.equal(empty.fitContent, false);
  assert.equal(populated.fitContent, true);
  assert.equal(populated.visibleLogicalRange, null);
});

test("polling refreshes preserve a user-selected historical viewport", () => {
  const plan = planChartDataUpdate({
    previous: { identity: "AAPL:5y:1m", pointCount: 200 },
    identity: "AAPL:5y:1m",
    pointCount: 201,
    visibleLogicalRange: range(40.5, 90.5),
  });

  assert.equal(plan.fitContent, false);
  assert.deepEqual(plan.visibleLogicalRange, range(40.5, 90.5));
});

test("a viewport following the live edge advances when a candle is appended", () => {
  const plan = planChartDataUpdate({
    previous: { identity: "AAPL:5y:1m", pointCount: 200 },
    identity: "AAPL:5y:1m",
    pointCount: 202,
    visibleLogicalRange: range(150, 202),
  });

  assert.equal(plan.fitContent, false);
  assert.deepEqual(plan.visibleLogicalRange, range(152, 204));
});

test("changing symbol, timeframe, or requested history depth fits the new data identity", () => {
  for (const identity of ["MSFT:5y:1d:1000", "AAPL:5y:5m:1000", "AAPL:5y:1d:5000"]) {
    const plan = planChartDataUpdate({
      previous: { identity: "AAPL:5y:1d:1000", pointCount: 250 },
      identity,
      pointCount: 250,
      visibleLogicalRange: range(120, 249),
    });

    assert.equal(plan.fitContent, true);
    assert.equal(plan.visibleLogicalRange, null);
  }
});

test("price and subindicator chart instances survive accepted polling data updates", async () => {
  const [pageSource, paneSource] = await Promise.all([
    readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/features/chart-indicators/SubIndicatorPanes.tsx", import.meta.url), "utf8"),
  ]);
  const priceChartSource = pageSource.slice(
    pageSource.indexOf("function PriceChart("),
    pageSource.indexOf("function PortfolioValueChart("),
  );
  const paneComponentSource = paneSource.slice(
    paneSource.indexOf("function SubIndicatorPane("),
    paneSource.indexOf("export function SubIndicatorPanes("),
  );

  assert.equal(priceChartSource.match(/createChart\(/g)?.length, 1);
  assert.match(priceChartSource, /chartDataLifecycleRef\.current = EMPTY_CHART_DATA_LIFECYCLE/);
  assert.match(priceChartSource, /planChartDataUpdate\(/);
  assert.match(priceChartSource, /runtime\.candleSeries\.setData\(displayCandles\)/);
  assert.match(priceChartSource, /timeScale\.setVisibleLogicalRange\(updatePlan\.visibleLogicalRange\)/);
  assert.match(priceChartSource, /\}, \[dataIdentity, displayCandles, displayVolumes, fullData\]\);/);
  assert.doesNotMatch(priceChartSource, /\}, \[[^\]]*marketBars[^\]]*\]\);\s*\n\s*return <div/);

  assert.equal(paneComponentSource.match(/createChart\(/g)?.length, 1);
  assert.match(paneComponentSource, /\}, \[hasRenderableData, spec\.id\]\);/);
  assert.match(paneComponentSource, /runtime\.timeline\.setData\(/);
  assert.match(paneComponentSource, /const synchronizedRange = timeScaleSync\.snapshot\(\)/);
  assert.match(paneComponentSource, /timeScale\.setVisibleLogicalRange\(synchronizedRange\)/);
});
