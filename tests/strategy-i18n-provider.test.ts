import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createStrategyTranslator,
  portfolioChartModeLabel,
  portfolioTabLabel,
  portfolioTransactionSideLabel,
  portfolioTransactionTabLabel,
  strategyDurationLabel,
  strategyTechnicalRatingLabel,
  strategyTranslate,
} from "../strategies/i18n";

test("strategy feature defaults to readable English and supports Japanese", () => {
  const english = createStrategyTranslator("en");
  const japanese = createStrategyTranslator("ja");

  assert.equal(english("index.title"), "Strategies");
  assert.equal(english("detail.addTransaction"), "Add transaction");
  assert.equal(english("detail.editStrategy"), "Edit strategy");
  assert.equal(english("toast.portfolioDeleted"), "Strategy deleted.");
  assert.equal(english("toast.transactionSaved", { symbol: "AAPL", side: "Buy" }), "AAPL Buy saved.");
  assert.equal(japanese("index.title"), "戦略一覧");
  assert.equal(japanese("detail.editStrategy"), "戦略を編集");
  assert.equal(japanese("toast.transactionSaved", { symbol: "AAPL", side: "買付" }), "AAPLの買付を保存しました");
});

test("strategy view labels localize without changing internal state values", () => {
  assert.equal(strategyDurationLabel("en", "全期間"), "All time");
  assert.equal(strategyDurationLabel("ja", "全期間"), "全期間");
  assert.equal(portfolioTabLabel("en", "概要"), "Overview");
  assert.equal(portfolioTabLabel("en", "保有銘柄"), "Holdings");
  assert.equal(portfolioChartModeLabel("en", "資産額"), "Value");
  assert.equal(portfolioTransactionTabLabel("en", "取引"), "Trades");
  assert.equal(portfolioTransactionSideLabel("en", "売却"), "Sell");
  assert.equal(strategyTechnicalRatingLabel("en", "強い買い"), "Strong buy");

  assert.equal(portfolioTabLabel("en", "future-tab"), "future-tab");
  assert.equal(portfolioTransactionSideLabel("ja", "future-side"), "future-side");
});

test("strategy dictionaries keep parameter placeholders when data is absent", () => {
  assert.equal(strategyTranslate("en", "table.symbolCount", { count: 12 }), "12 symbols");
  assert.equal(strategyTranslate("ja", "table.symbolCount", { count: 12 }), "12銘柄");
  assert.equal(strategyTranslate("en", "table.symbolCount"), "{count} symbols");
});

test("StrategyHome uses the locale while preserving API and state identifiers", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const start = pageSource.indexOf("function StrategyHome(");
  const end = pageSource.indexOf("function WatchlistPanel(", start);
  assert.ok(start >= 0 && end > start);
  const strategySource = pageSource.slice(start, end);

  assert.match(strategySource, /const \{ locale \} = useI18n\(\)/);
  assert.match(strategySource, /createStrategyTranslator\(locale\)/);
  assert.match(strategySource, /aria-label=\{st\("index\.aria"\)\}/);
  assert.match(strategySource, /DialogShell title=\{st\("transaction\.dialogTitle"\)\}/);
  assert.match(strategySource, /onAction\(st\("toast\.transactionSaveFailed"\)\)/);

  assert.match(strategySource, /useState<PortfolioTab>\("概要"\)/);
  assert.match(strategySource, /<option value="買付">/);
  assert.match(strategySource, /transactionSide === "買付" \? "buy"/);
  assert.match(strategySource, /transactionSide === "売却" \? "sell"/);
  assert.doesNotMatch(strategySource, /aria-label="(?:戦略|ポートフォリオ|保有|取引)/);
});
