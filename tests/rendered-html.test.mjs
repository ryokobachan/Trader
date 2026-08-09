import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function fetchBuiltApp(path = "/", accept = "text/html") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function render() {
  return fetchBuiltApp();
}

test("server-renders the Unicorn stock analysis mock", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="en"/i);
  assert.match(html, /<title>Unicorn — Stock Analysis Workspace<\/title>/i);
  assert.match(html, /aria-label="Unicorn"/);
  assert.match(html, /UNICORN/);
  assert.match(html, /src="\/unicorn-logo\.png"/);
  assert.doesNotMatch(html, /🦄/u);
  assert.doesNotMatch(html, /Pulseboard/i);
  assert.match(html, /AAPL/);
  assert.match(html, /Watchlist/);
  assert.match(html, /Symbol overview/);
  assert.match(html, /Price range/);
  assert.match(html, /Key statistics/);
  assert.match(html, /Next earnings/);
  assert.match(html, /Performance/);
  assert.match(html, /Technicals/);
  assert.match(html, /Analysts/);
  assert.match(html, /Company profile/);
  assert.match(html, /10:32 JST · 15 min delayed/);
  assert.doesNotMatch(html, /15分遅延/);
  assert.match(html, /Indicators/);
  assert.match(html, /Strategies/);
  assert.match(html, /aria-label="Workspace"/);
  assert.match(html, /watchlist-detail-layout/);
  assert.match(html, /aria-label="AAPL symbol overview"/);
  assert.match(html, /aria-label="Open AAPL details"/);
  assert.doesNotMatch(html, /aria-label="AAPL 銘柄詳細"/);
  assert.doesNotMatch(html, /> AAPL 詳細<\/button>/);
  assert.match(html, /financialmodelingprep\.com\/image-stock\/AAPL\.png/);
  assert.doesNotMatch(html, /company-logo-fallback/);
  assert.match(html, /data-module-id="core\.identity_quote"/);
  assert.match(html, /data-module-id="core\.key_statistics"/);
  assert.match(html, /Lightweight Charts by TradingView/);
  assert.doesNotMatch(html, /TradingView-style summary/);
  assert.match(html, /⌘ F/);
  assert.doesNotMatch(html, /PROVIDER DATA|LOADING DATA|FIXTURE DATA/);
  assert.doesNotMatch(html, /aria-label="共有"|aria-label="プロフィール"/);
  assert.doesNotMatch(html, /aria-label="分析情報"/);
  assert.doesNotMatch(html, /aria-label="描画ツール"/);
  assert.doesNotMatch(html, /aria-label="右サイドパネル"/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});

test("uses the supplied Unicorn logo for the favicon and shell metadata", async () => {
  const brand = await readFile(new URL("../src/app/platform/brand.ts", import.meta.url), "utf8");
  const layout = await readFile(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  await access(new URL("../public/unicorn-logo.png", import.meta.url));
  await access(new URL("../public/favicon.png", import.meta.url));
  assert.match(brand, /logoPath:\s*"\/unicorn-logo\.png"/);
  assert.match(brand, /faviconPath:\s*"\/favicon\.png"/);
  assert.match(layout, /openGraph/);
  assert.match(layout, /twitter/);
});

test("disables embedded chart logos and keeps a separate attribution notice", async () => {
  const source = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.equal(source.match(/attributionLogo:\s*false/g)?.length, 3);
  assert.doesNotMatch(source, /#tv-attr-logo/);
  await access(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url));
});

test("defines the chart summary through a versioned module registry", async () => {
  const registrySource = await readFile(new URL("../src/app/platform/ui-module-registry.ts", import.meta.url), "utf8");
  const modulesSource = await readFile(new URL("../src/app/features/symbol-summary/core-modules.tsx", import.meta.url), "utf8");
  const hostSource = await readFile(new URL("../src/app/features/symbol-summary/SymbolSummaryHost.tsx", import.meta.url), "utf8");
  const compositionSource = await readFile(new URL("../extensions/index.ts", import.meta.url), "utf8");
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(registrySource, /unicorn\.ui-module\.v1/);
  assert.match(registrySource, /chart\.symbol-summary/);
  for (const moduleId of [
    "core.identity_quote",
    "core.price_range",
    "core.key_statistics",
    "core.earnings",
    "core.financials",
    "core.performance",
    "core.technical_rating",
    "core.analyst_consensus",
    "core.company_profile",
  ]) {
    assert.match(modulesSource, new RegExp(moduleId.replace(".", "\\.")));
  }
  assert.match(compositionSource, /example\.market_context/);
  assert.match(compositionSource, /defineUiModuleRegistry/);
  assert.match(hostSource, /registration\.Component/);
  assert.doesNotMatch(hostSource, /module\.id\s*===/);
  assert.doesNotMatch(pageSource, /module\.id\s*===/);
});

test("serves normalized fixture data through server-side Provider APIs", async () => {
  const summaryResponse = await fetchBuiltApp("/api/v1/symbols/AAPL/summary", "application/json");
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.schemaVersion, "unicorn.symbol-summary.v1");
  assert.equal(summary.instrument.symbol, "AAPL");
  assert.equal(summary.instrument.listingCountry, "US");
  assert.equal(summary.selectedProviders.instrument, "mock");
  assert.equal(summary.selectedProviders.market, "mock");

  const searchResponse = await fetchBuiltApp("/api/v1/instruments/search?q=apple&limit=5", "application/json");
  assert.equal(searchResponse.status, 200);
  const search = await searchResponse.json();
  assert.equal(search.schemaVersion, "unicorn.instrument-search.v1");
  assert.equal(search.dataMode, "fixture");
  assert.deepEqual(search.scope.assetTypes, ["common_stock", "adr"]);
  assert.deepEqual(search.items.map((item) => item.symbol), ["AAPL"]);

  const outOfScopeResponse = await fetchBuiltApp("/api/v1/symbols/7203/summary", "application/json");
  assert.equal(outOfScopeResponse.status, 400);

  const barsResponse = await fetchBuiltApp("/api/v1/symbols/AAPL/bars?range=1y&interval=1d", "application/json");
  assert.equal(barsResponse.status, 200);
  const bars = await barsResponse.json();
  assert.equal(bars.schemaVersion, "unicorn.market-bars.v1");
  assert.equal(bars.dataMode, "fixture");
  assert.equal(bars.bars.adjustment, "raw");
  assert.ok(bars.bars.items.length > 200);

  const workspaceResponse = await fetchBuiltApp("/api/v1/symbols/AAPL/workspace", "application/json");
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json();
  assert.equal(workspace.schemaVersion, "unicorn.symbol-workspace.v1");
  assert.equal(workspace.instrument.symbol, "AAPL");
  assert.equal(workspace.dataMode, "fixture");
  assert.equal(workspace.status, "partial");
});
