import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { translate } from "../src/app/platform/i18n";

test("stock detail has complete English-default and Japanese navigation copy", () => {
  assert.equal(translate("en", "detail.tab.financials"), "Financials & earnings");
  assert.equal(translate("ja", "detail.tab.financials"), "財務・決算");
  assert.equal(translate("en", "detail.section.targetHistory"), "Price target history");
  assert.equal(translate("ja", "detail.section.targetHistory"), "目標価格の推移一覧");
  assert.equal(
    translate("en", "detail.empty.notProvided", { subject: translate("en", "detail.subject.analyst") }),
    "analyst data was not provided by the selected source.",
  );
  assert.equal(
    translate("ja", "detail.warningCount", { count: 2 }),
    "警告 2件",
  );
});

test("stock detail translates normalized metric presentation without translating provider content", async () => {
  assert.equal(translate("en", "metric.revenue"), "Revenue");
  assert.equal(translate("ja", "metric.revenue"), "売上高");
  assert.equal(translate("en", "detail.note.providerUsdPerShare"), "Latest provider value · USD / share");
  assert.equal(translate("ja", "detail.note.providerUsdPerShare"), "Provider最新値 · USD / 株");

  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const start = pageSource.indexOf("type TranslateMessage =");
  const end = pageSource.indexOf("function IndicatorsPanel(", start);
  assert.ok(start >= 0 && end > start);
  const detailSource = pageSource.slice(start, end);

  assert.match(detailSource, /stockDetailMetricLabel\(metric\.label, t\)/);
  assert.match(detailSource, /stockDetailMetricValue\(metric, locale, t\)/);
  assert.match(detailSource, /stockDetailMetricNote\(metric\.note, t\)/);
  assert.match(detailSource, /stockDetailMarketState\(quote\.marketState, t\)/);
  assert.match(detailSource, /event\.analystFirm \?\? "—"/);
  assert.match(detailSource, /identity\?\.name \?\? stock\.name/);
});
