import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("stock detail renders a three-way technical rating and both indicator groups", async () => {
  const [pageSource, panelSource] = await Promise.all([
    readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/features/stock-detail/TechnicalRatingsPanel.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(pageSource, /<TechnicalRatingsPanel summary=\{detail\.technicalRatings\} \/>/);
  assert.match(panelSource, /group=\{summary\.overall\}/);
  assert.match(panelSource, /group=\{summary\.movingAverages\}/);
  assert.match(panelSource, /group=\{summary\.oscillators\}/);
  assert.match(panelSource, /group\.sell/);
  assert.match(panelSource, /group\.neutral/);
  assert.match(panelSource, /group\.buy/);
  assert.match(panelSource, /group\.signals\.map/);
  assert.match(panelSource, /data-signal=\{signal\.signal\}/);
  assert.match(panelSource, /detail\.technical\.rating\.disclaimer/);
});

test("technical rating UI labels all 26 canonical signal ids", async () => {
  const source = await readFile(
    new URL("../src/app/features/stock-detail/TechnicalRatingsPanel.tsx", import.meta.url),
    "utf8",
  );
  const signalIds = [
    "sma10", "sma20", "sma30", "sma50", "sma100", "sma200",
    "ema10", "ema20", "ema30", "ema50", "ema100", "ema200",
    "hma9", "vwma20", "ichimoku", "rsi14", "stochastic1433", "cci20",
    "adx1414", "awesome_oscillator", "momentum10", "macd12269",
    "stochastic_rsi331414", "williams_r14", "bull_bear_power13",
    "ultimate_oscillator71428",
  ];

  for (const signalId of signalIds) {
    assert.match(source, new RegExp(`\\b${signalId}:`), `${signalId} should have a visible label`);
  }
});
