import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ACTIVE_CHART_INDICATORS, restoreActiveChartIndicators } from "../src/app/features/indicators/chart-indicator-preferences";
import { createChartTemplate, parseChartTemplates, serializeChartTemplates } from "../src/app/features/chart-templates/chart-templates";
import { localizeIndicator } from "../src/app/features/indicators/indicator-i18n";

test("first use and legacy preferences retain the previously visible volume layers", () => {
  assert.deepEqual(restoreActiveChartIndicators(undefined, undefined), DEFAULT_ACTIVE_CHART_INDICATORS);
  assert.deepEqual(restoreActiveChartIndicators(["ema50", "ema50", "unknown"], undefined), ["ema50", "volume", "volumeProfile"]);
});

test("removing either or both volume indicators survives subsequent preference loads", () => {
  assert.deepEqual(restoreActiveChartIndicators(["sma20", "volumeProfile"], 1), ["sma20", "volumeProfile"]);
  assert.deepEqual(restoreActiveChartIndicators(["volume"], 1), ["volume"]);
  assert.deepEqual(restoreActiveChartIndicators([], 1), []);
  assert.deepEqual(restoreActiveChartIndicators(["volume", "volumeProfile", "volume"], 1), ["volume", "volumeProfile"]);
});

test("templates round-trip volume visibility, colors and price band settings", () => {
  const template = createChartTemplate({
    id: "volume-template",
    name: "Volume study",
    activeIndicators: ["volume", "volumeProfile"],
    hiddenIndicators: ["volume"],
    indicatorSettings: {
      volume: { color: "#26a69a", downColor: "#ef5350" },
      volumeProfile: { color: "#6495ed", length: 64 },
    },
  });
  assert.deepEqual(parseChartTemplates(serializeChartTemplates([template])), [template]);
});

test("volume entries have Japanese and English names for search and management", () => {
  for (const [id, name, english] of [["volume", "出来高", "Volume"], ["volumeProfile", "価格帯別出来高", "Volume Profile"]]) {
    const definition = { id, name, description: "説明", category: "出来高", placement: "チャート上" };
    assert.equal(localizeIndicator("ja", definition).name, name);
    assert.equal(localizeIndicator("en", definition).name, english);
  }
});
