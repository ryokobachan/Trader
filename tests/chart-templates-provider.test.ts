import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CHART_TEMPLATE_SCHEMA_VERSION,
  createChartTemplate,
  parseChartTemplates,
  serializeChartTemplates,
  validateChartTemplateName,
} from "../src/app/features/chart-templates/chart-templates";

test("chart templates snapshot indicator settings and visibility", () => {
  const settings = { rsi14: { length: 14, visibility: { days: true } } };
  const template = createChartTemplate({
    id: "user-1",
    name: "  Momentum   setup ",
    activeIndicators: ["rsi14", "rsi14"],
    hiddenIndicators: ["rsi14", "sma20"],
    indicatorSettings: settings,
  });
  settings.rsi14.length = 20;

  assert.equal(template.name, "Momentum setup");
  assert.deepEqual(template.activeIndicators, ["rsi14"]);
  assert.deepEqual(template.hiddenIndicators, ["rsi14"]);
  assert.equal((template.indicatorSettings.rsi14 as { length: number }).length, 14);
});

test("chart template storage is versioned and rejects another schema", () => {
  const template = createChartTemplate({
    id: "user-1",
    name: "Momentum",
    activeIndicators: ["rsi14"],
    hiddenIndicators: [],
    indicatorSettings: { rsi14: { length: 14 } },
  });
  const serialized = serializeChartTemplates([template]);

  assert.equal(JSON.parse(serialized).schemaVersion, CHART_TEMPLATE_SCHEMA_VERSION);
  assert.deepEqual(parseChartTemplates(serialized), [template]);
  assert.deepEqual(parseChartTemplates('{"schemaVersion":"future","templates":[]}'), []);
  assert.deepEqual(parseChartTemplates("not-json"), []);
});

test("chart template names reject empty, long, and duplicate values", () => {
  const current = [{ id: "1", name: "Momentum" }];
  assert.equal(validateChartTemplateName(" ", current), "empty");
  assert.equal(validateChartTemplateName("x".repeat(61), current), "too-long");
  assert.equal(validateChartTemplateName("  Momentum ", current), "duplicate");
  assert.equal(validateChartTemplateName("Momentum", current, "1"), null);
  assert.equal(validateChartTemplateName("Trend", current), null);
});

test("chart toolbar wires template CRUD and removes the alert surface", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /CHART_TEMPLATE_STORAGE_KEY/);
  assert.match(pageSource, /openTemplateEditor\("create"\)/);
  assert.match(pageSource, /openTemplateEditor\("rename", template\)/);
  assert.match(pageSource, /deleteChartTemplate\(template\)/);
  assert.doesNotMatch(pageSource, /setAppDialog\("alert"\)/);
  assert.doesNotMatch(pageSource, /appDialog === "alert"/);
});
