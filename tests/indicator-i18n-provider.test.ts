import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  indicatorAppliedCount,
  indicatorResultCount,
  indicatorText,
  localizeIndicator,
  localizeIndicatorAnchor,
  localizeIndicatorSection,
  localizeIndicatorSource,
} from "../src/app/features/indicators/indicator-i18n";

const rsi = {
  id: "rsi14",
  name: "相対力指数",
  description: "買われ過ぎ・売られ過ぎを判定",
  category: "モメンタム",
  placement: "サブパネル",
};

test("indicator feature copy defaults to complete English presentation values", () => {
  assert.equal(indicatorText("en", "chartIndicators"), "Indicators on chart");
  assert.equal(indicatorText("en", "hide", { name: "RSI 14" }), "Hide RSI 14");
  assert.equal(indicatorText("en", "tabParameters"), "Parameters");
  assert.equal(indicatorText("en", "visibilityHeading"), "Show on these timeframes");
  assert.equal(indicatorAppliedCount("en", 1), "1 indicator applied");
  assert.equal(indicatorAppliedCount("en", 2), "2 indicators applied");
  assert.equal(indicatorResultCount("en", 1), "1 result");
  assert.equal(indicatorResultCount("en", 3), "3 results");

  assert.deepEqual(localizeIndicator("en", rsi), {
    ...rsi,
    name: "Relative Strength Index",
    description: "Identifies overbought and oversold conditions",
    category: "Momentum",
    placement: "Separate pane",
  });
  assert.equal(localizeIndicatorSection("en", "お気に入り"), "Favorites");
  assert.equal(localizeIndicatorSource("en", "終値"), "Close");
  assert.equal(localizeIndicatorAnchor("en", "四半期"), "Quarter");
});

test("indicator feature copy supports Japanese without changing persisted values", () => {
  assert.equal(indicatorText("ja", "chartIndicators"), "チャート上の指標");
  assert.equal(indicatorText("ja", "hide", { name: "RSI 14" }), "RSI 14を非表示");
  assert.equal(indicatorText("ja", "tabParameters"), "パラメーター");
  assert.equal(indicatorText("ja", "visibilityHeading"), "次の時間足に表示");
  assert.equal(indicatorAppliedCount("ja", 2), "2個を適用");
  assert.equal(indicatorResultCount("ja", 3), "3件");
  assert.equal(localizeIndicator("ja", rsi), rsi);
  assert.equal(localizeIndicatorSection("ja", "お気に入り"), "お気に入り");
  assert.equal(localizeIndicatorSource("ja", "終値"), "終値");
  assert.equal(localizeIndicatorAnchor("ja", "四半期"), "四半期");
});

test("indicator surfaces localize display copy while retaining Japanese state identifiers", async () => {
  const source = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function IndicatorsPanel");
  const end = source.indexOf("function StrategyHome", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const indicatorSurfaces = source.slice(start, end);

  assert.match(indicatorSurfaces, /const \{ locale \} = useI18n\(\)/);
  assert.match(indicatorSurfaces, /localizeIndicator\(locale, indicator\)/);
  assert.match(indicatorSurfaces, /localizeIndicatorSection\(locale, item\)/);
  assert.match(indicatorSurfaces, /localizeIndicatorSource\(locale, item\)/);
  assert.match(indicatorSurfaces, /localizeIndicatorAnchor\(locale, item\)/);
  assert.match(indicatorSurfaces, /useState<IndicatorSettingsTab>\("パラメーター"\)/);
  assert.match(indicatorSurfaces, /useState\("テクニカル"\)/);
  assert.match(indicatorSurfaces, /<option value=\{item\} key=\{item\}>\{localizeIndicatorSource/);
  assert.match(indicatorSurfaces, /<option value=\{item\} key=\{item\}>\{localizeIndicatorAnchor/);
});
