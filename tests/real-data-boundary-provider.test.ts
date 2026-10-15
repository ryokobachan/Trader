import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
const workspaceRouteSource = readFileSync(new URL("../src/app/api/v1/symbols/[symbol]/workspace/route.ts", import.meta.url), "utf8");
const barsRouteSource = readFileSync(new URL("../src/app/api/v1/symbols/[symbol]/bars/route.ts", import.meta.url), "utf8");
const analystRouteSource = readFileSync(new URL("../src/app/api/v1/symbols/[symbol]/analyst-ratings/route.ts", import.meta.url), "utf8");
const summaryRouteSource = readFileSync(new URL("../src/app/api/v1/symbols/[symbol]/summary/route.ts", import.meta.url), "utf8");

function sourceBetween(start: string, end: string) {
  const startIndex = pageSource.indexOf(start);
  const endIndex = pageSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return pageSource.slice(startIndex, endIndex);
}

test("live stock and watchlist placeholders keep identity without fixed market values", () => {
  const identityPlaceholder = sourceBetween(
    "function stockIdentityPlaceholder",
    "function tickerIdentityPlaceholder",
  );
  for (const field of [
    "price",
    "change",
    "changeValue",
    "open",
    "high",
    "low",
    "target",
    "targetLow",
    "targetHigh",
    "analysts",
    "buy",
    "neutral",
    "sell",
  ]) {
    assert.match(identityPlaceholder, new RegExp(`${field}: 0[,\\n]`));
  }
  for (const field of [
    "volume",
    "marketCap",
    "revenue",
    "revenueGrowth",
    "eps",
    "epsGrowth",
    "pe",
    "dividend",
  ]) {
    assert.match(identityPlaceholder, new RegExp(`${field}: "—"[,\\n]`));
  }

  const watchlistPlaceholder = sourceBetween(
    "function watchlistItemPlaceholder",
    "function workspaceStock",
  );
  assert.match(watchlistPlaceholder, /stockIdentityPlaceholder\(existing\)/);
  assert.doesNotMatch(watchlistPlaceholder, /return \{ \.\.\.existing,/);

  const homeState = sourceBetween("export default function Home", "const [workspace, setWorkspace]");
  assert.match(homeState, /STOCKS\.map\(\(item\) => \[item\.ticker, stockIdentityPlaceholder\(item\)\]\)/);
  assert.doesNotMatch(homeState, /\[item\.ticker, item\]/);
  assert.match(pageSource, /stockModels\[selectedTicker\] \?\? tickerIdentityPlaceholder\(selectedTicker\)/);
  assert.match(
    pageSource,
    /Number\.isFinite\(stock\.price\) && stock\.price > 0[\s\S]*?Number\.isFinite\(stock\.change\)[\s\S]*?Number\.isFinite\(stock\.changeValue\)[\s\S]*?: <span>—<\/span>/,
  );
  assert.match(pageSource, /const hasCurrentChange = hasCurrentPrice && Number\.isFinite\(item\.change\)/);

  const strategyHome = sourceBetween("function StrategyHome", "export default function Home");
  assert.match(
    strategyHome,
    /STOCKS\.map\(\(item\) => \[item\.ticker, stockIdentityPlaceholder\(item\)\]\)/,
  );
  assert.match(strategyHome, /const \[transactionPrice, setTransactionPrice\] = useState\(""\)/);
  assert.match(strategyHome, /const staticStock = tickerIdentityPlaceholder\(symbol\)/);
  assert.match(
    strategyHome,
    /payload\.dataMode === "provider" \? payload\.bars\.items : \[\]/,
  );
  assert.doesNotMatch(strategyHome, /setTransactionPrice\(String\(strategyMarketMarks\[ticker\]\?\.price \?\? stock\.price\)\)/);
});

test("summary intelligence is unavailable until a matching provider workspace exists", () => {
  const intelligenceSource = sourceBetween(
    "function unavailableStockIntelligence",
    "function indicatorCalculationSpec",
  );
  assert.match(intelligenceSource, /workspace\.dataMode !== "provider"/);
  assert.match(intelligenceSource, /workspace\.instrument\.symbol !== stock\.ticker/);
  assert.match(intelligenceSource, /return unavailableStockIntelligence\(\)/);
  assert.match(intelligenceSource, /country: "—"/);
  assert.match(intelligenceSource, /performance: \{[\s\S]*?week: "—"/);
  assert.match(intelligenceSource, /technical: \{[\s\S]*?overall: "—"/);
  assert.doesNotMatch(
    intelligenceSource,
    /STOCK_CONTEXT|scaledMetric|signedPercentMetric|dataFreshnessFixture|fixture\s*=/,
  );
  assert.match(intelligenceSource, /buildSummaryDailyMarketMetrics\(bars\)/);
  assert.match(intelligenceSource, /buildStockDetailTechnicalRatings\(bars\)/);
  assert.match(intelligenceSource, /const quote = workspace\.quote/);
  assert.match(intelligenceSource, /dayRangePosition: null/);
  assert.match(intelligenceSource, /yearRangePosition: null/);
  assert.doesNotMatch(intelligenceSource, /\? 68 : 36|movingAverage20|technicalRating\(/);
});

test("workspace-derived summary and news accept provider data only", () => {
  assert.match(workspaceRouteSource, /providerDataMode\(\.\.\.Object\.values\(runtime\.selectedProviderIds\)\)/);
  assert.match(barsRouteSource, /providerDataMode\([\s\S]*?selectedProviderIds\.instrument,[\s\S]*?selectedProviderIds\.bars/);
  assert.match(analystRouteSource, /providerDataMode\([\s\S]*?selectedProviderIds\.instrument,[\s\S]*?analystProviderId/);
  assert.match(summaryRouteSource, /providerDataMode\([\s\S]*?selectedProviderIds\.instrument,[\s\S]*?selectedProviderIds\.market/);
  assert.match(
    pageSource,
    /const detailWorkspace = workspaceStatus === "provider"[\s\S]*?workspace\?\.dataMode === "provider"[\s\S]*?workspace\.instrument\.symbol === selectedTicker/,
  );
  assert.match(
    pageSource,
    /dailyBarsStatus === "provider" \? detailDailyMarketBars : \[\]/,
  );
  assert.match(
    pageSource,
    /barsStatus === "provider" && marketBarsSymbol === selectedTicker \? marketBars : \[\]/,
  );
  assert.match(
    pageSource,
    /dailyBarsStatus === "provider" && dailyMarketBarsSymbol === selectedTicker \? dailyMarketBars : \[\]/,
  );
  assert.match(
    pageSource,
    /workspaceStatus === "provider" && barsStatus === "provider" \? "provider" : "fixture"/,
  );
  assert.match(
    pageSource,
    /workspaceStatus === "provider" && dailyBarsStatus === "provider" \? "provider" : "fixture"/,
  );
  assert.match(
    pageSource,
    /const selectedAnalystHistory = analystHistoryResponse\?\.dataMode === "provider"/,
  );
  assert.match(
    pageSource,
    /snapshot\.dataMode !== "provider"[\s\S]*?setAnalystHistoryResponse\(null\)[\s\S]*?setAnalystHistoryStatus\("error"\)/,
  );

  const newsSource = sourceBetween(
    "const visibleNews = useMemo",
    "const selectedAnalystHistory",
  );
  assert.match(newsSource, /workspaceStatus === "provider"/);
  assert.match(newsSource, /workspace\?\.dataMode === "provider"/);
  assert.match(newsSource, /return \[\]/);
  assert.doesNotMatch(newsSource, /NEWS\.map|finance\.yahoo\.com|Trader Sample News|Synthetic fixture/);
  assert.doesNotMatch(pageSource, /visibleNews\.concat\(/);
  assert.match(pageSource, /showAllNews \? visibleNews : visibleNews\.slice\(0, 3\)/);

  const stockSource = sourceBetween("function workspaceStock", "function watchlistQuoteStock");
  assert.match(stockSource, /target = consensus\?\.targetConsensus \?\? 0/);
  assert.match(stockSource, /targetLow: consensus\?\.targetLow \?\? 0/);
  assert.match(stockSource, /targetHigh: consensus\?\.targetHigh \?\? 0/);
  assert.doesNotMatch(stockSource, /targetConsensus \?\? workspace\.quote\.price/);

  assert.match(
    pageSource,
    /workspaceStatus === "loading"[\s\S]*?"status\.fetching"[\s\S]*?workspaceStatus === "provider"[\s\S]*?"news\.empty"[\s\S]*?"status\.connectionError"/,
  );
});
