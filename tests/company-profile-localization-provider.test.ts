import assert from "node:assert/strict";
import test from "node:test";
import type { CompanyProfile, Instrument } from "../src/app/platform/provider-contracts";
import { createJapaneseCompanyProfileEnricher, extractYahooJapanCompanyDescription } from "../api/company-profile-localization.server";
import { extractTradingViewJapaneseProfile, tradingViewProfileListing } from "../api/tradingview/japanese-profile.server";

const NOW = new Date("2026-09-05T05:00:00.000Z");
const CONTEXT = { requestId: "company-profile-localization-test" };
const INSTRUMENT: Instrument = {
  instrumentId: "us:XNAS:TEST", symbol: "TEST", name: "Example Company", assetType: "common_stock",
  active: true, listingCountry: "US", exchange: "NASDAQ", exchangeMic: "XNAS", currency: "USD",
  provenance: { providerId: "test", sourceId: "test:TEST", asOf: NOW.toISOString(), ingestedAt: NOW.toISOString() },
};
const PROFILE: CompanyProfile = { instrumentId: INSTRUMENT.instrumentId, description: "Original English business description.",
  sector: "Technology services", industry: "Packaged software", marketCap: 1_000, provenance: INSTRUMENT.provenance };
const LISTING = tradingViewProfileListing(INSTRUMENT)!;

function tvHtml(company: Record<string, unknown> = {}, locale = "ja") {
  const payload = { fixture: { context: { request_context: { locale } }, data: { symbol: {
    pro_symbol: "NASDAQ:TEST", type: "stock", currency: "USD", sector: "テクノロジーサービス", industry: "ソフトウェア",
    ...company,
  } } } };
  return `<script type="application/prs.init-data+json">${JSON.stringify(payload)}</script>`;
}

function yahooHtml(overrides: Record<string, unknown> = {}) {
  return `<script>window.__PRELOADED_STATE__ = ${JSON.stringify({
    pageInfo: { code: "TEST", currentPageLink: "https://finance.yahoo.co.jp/quote/TEST/profile" },
    mainUsStocksPriceBoard: { code: "TEST", label: "NASDAQ" },
    mainUsStocksProfile: { section: { title: "特色", items: [{ text: "テスト企業はソフトウェアを開発しています。" }] } },
    ...overrides,
  })}; maliciousFunctionThatMustNotRun();</script>`;
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

test("TradingView reads only the verified Japanese company payload and preserves source identity", () => {
  const japanese = extractTradingViewJapaneseProfile(tvHtml({ ast_business_description: { type: "root", children: [
    "テスト企業は", { type: "link", children: ["ソフトウェアを開発しています。"] },
  ] } }), LISTING, NOW.toISOString());
  assert.equal(japanese?.description, "テスト企業は ソフトウェアを開発しています。");
  assert.equal(japanese?.sector, "テクノロジーサービス");
  assert.equal(japanese?.provenance.sourceUrl, LISTING.url);
  assert.equal(japanese?.descriptionProvenance?.providerId, "tradingview");
});

test("TradingView never mistakes generic SEO descriptions, English text or community ideas for company information", () => {
  const html = tvHtml({ ast_business_description: { children: ["This is English business information."] } })
    + '<script type="application/ld+json">{"description":"ライブチャートで株価を追跡しましょう。"}</script>'
    + '<div>ユーザーの投稿：これは企業情報ではありません。</div>';
  const japanese = extractTradingViewJapaneseProfile(html, LISTING, NOW.toISOString());
  assert.equal(japanese?.description, undefined);
  assert.equal(japanese?.industry, "ソフトウェア");
  for (const company of [{ pro_symbol: "NASDAQ:OTHER" }, { type: "fund" }, { currency: "JPY" }]) {
    assert.equal(extractTradingViewJapaneseProfile(tvHtml(company), LISTING, NOW.toISOString()), null);
  }
  assert.equal(extractTradingViewJapaneseProfile(tvHtml({}, "en"), LISTING, NOW.toISOString()), null);
  assert.equal(extractTradingViewJapaneseProfile('<script type="application/prs.init-data+json">oops</script>', LISTING, NOW.toISOString()), null);
});

test("Yahoo Japan reads the matching US listing's feature text without evaluating scripts", () => {
  const result = extractYahooJapanCompanyDescription(yahooHtml(), INSTRUMENT, NOW.toISOString());
  assert.equal(result?.description, "テスト企業はソフトウェアを開発しています。");
  assert.equal(result?.descriptionProvenance?.providerId, "yahoo-japan");
  assert.equal(result?.descriptionProvenance?.sourceUrl, "https://finance.yahoo.co.jp/quote/TEST/profile");
  assert.equal(result?.industry, undefined);
  for (const overrides of [
    { pageInfo: { code: "OTHER", currentPageLink: "https://finance.yahoo.co.jp/quote/TEST/profile" } },
    { pageInfo: { code: "TEST", currentPageLink: "https://evil.example/TEST" } },
    { mainUsStocksPriceBoard: { code: "TEST", label: "NYSE" } },
    { mainUsStocksProfile: { section: { title: "掲示板", items: [{ text: "ユーザーの意見" }] } } },
    { mainUsStocksProfile: { section: { title: "特色", items: [{ text: "English business description." }] } } },
  ]) assert.equal(extractYahooJapanCompanyDescription(yahooHtml(overrides), INSTRUMENT, NOW.toISOString()), null);
  assert.equal(extractYahooJapanCompanyDescription("<script>window.__PRELOADED_STATE__ = getSecret()</script>", INSTRUMENT, NOW.toISOString()), null);
});

test("augmentation prefers TradingView Japanese and preserves the configured provider's English text and numbers", async () => {
  const urls: string[] = [];
  const enrich = createJapaneseCompanyProfileEnricher({ fetch: async input => {
    urls.push(String(input));
    return htmlResponse(tvHtml({ ast_business_description: { children: ["日本語の企業説明です。"] } }));
  }, now: () => NOW });
  const result = await enrich(PROFILE, INSTRUMENT, CONTEXT);
  assert.deepEqual(urls, [LISTING.url, "https://finance.yahoo.co.jp/quote/TEST/profile"]);
  assert.equal(result?.description, PROFILE.description);
  assert.equal(result?.marketCap, PROFILE.marketCap);
  assert.equal(result?.provenance.providerId, "test");
  assert.equal(result?.localized?.ja?.description, "日本語の企業説明です。");
});

test("missing TradingView descriptions use Yahoo Japan with separate description provenance", async () => {
  const urls: string[] = [];
  const enrich = createJapaneseCompanyProfileEnricher({ fetch: async input => {
    urls.push(String(input));
    return htmlResponse(String(input).includes("tradingview") ? tvHtml() : yahooHtml());
  }, now: () => NOW });
  const result = await enrich(PROFILE, INSTRUMENT, CONTEXT);
  assert.equal(urls.length, 2);
  assert.equal(result?.localized?.ja?.description, "テスト企業はソフトウェアを開発しています。");
  assert.equal(result?.localized?.ja?.industry, "ソフトウェア");
  assert.equal(result?.localized?.ja?.provenance.providerId, "tradingview");
  assert.equal(result?.localized?.ja?.descriptionProvenance?.providerId, "yahoo-japan");
});

test("source failures leave English available and cache partial Japanese classification for a short period", async () => {
  let timestamp = NOW.getTime();
  let calls = 0;
  const enrich = createJapaneseCompanyProfileEnricher({ fetch: async input => {
    calls += 1;
    if (String(input).includes("yahoo")) throw new Error("unavailable");
    return htmlResponse(tvHtml());
  }, now: () => new Date(timestamp) });
  const result = await enrich(PROFILE, INSTRUMENT, CONTEXT);
  assert.equal(result?.description, PROFILE.description);
  assert.equal(result?.localized?.ja?.description, undefined);
  assert.equal(result?.localized?.ja?.sector, "テクノロジーサービス");
  await enrich(PROFILE, INSTRUMENT, CONTEXT);
  assert.equal(calls, 2);
  timestamp += 60_001;
  await enrich(PROFILE, INSTRUMENT, CONTEXT);
  assert.equal(calls, 4);
});

test("successful requests deduplicate, cache across calls, expire and honor explicit refresh", async () => {
  let calls = 0;
  let timestamp = NOW.getTime();
  const enrich = createJapaneseCompanyProfileEnricher({ fetch: async () => {
    calls += 1;
    return htmlResponse(tvHtml({ ast_business_description: { children: ["日本語の企業説明です。"] } }));
  }, now: () => new Date(timestamp), cacheTtlMs: 100 });
  await Promise.all([enrich(PROFILE, INSTRUMENT, CONTEXT), enrich(PROFILE, INSTRUMENT, CONTEXT)]);
  assert.equal(calls, 2);
  await enrich(PROFILE, INSTRUMENT, CONTEXT);
  assert.equal(calls, 2);
  await enrich(PROFILE, INSTRUMENT, { ...CONTEXT, fresh: true });
  assert.equal(calls, 4);
  timestamp += 101;
  await enrich(PROFILE, INSTRUMENT, CONTEXT);
  assert.equal(calls, 6);
});

test("a combined deadline bounds fetches and body reads, even if an upstream ignores cancellation", async () => {
  for (const fetcher of [
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/html" } }),
  ]) {
    const enrich = createJapaneseCompanyProfileEnricher({ fetch: fetcher, timeoutMs: 5 });
    assert.equal(await enrich(PROFILE, INSTRUMENT, CONTEXT), PROFILE);
  }
});

test("a slow TradingView page cannot starve an available Yahoo Japan description", async () => {
  const enrich = createJapaneseCompanyProfileEnricher({ fetch: async input => String(input).includes("tradingview")
    ? new Promise<Response>(() => {}) : htmlResponse(yahooHtml()), timeoutMs: 5 });
  const result = await enrich(PROFILE, INSTRUMENT, CONTEXT);
  assert.equal(result?.localized?.ja?.description, "テスト企業はソフトウェアを開発しています。");
  assert.equal(result?.localized?.ja?.descriptionProvenance?.providerId, "yahoo-japan");
});

test("bad HTML, oversized responses and denied HTTP requests cannot replace the configured profile", async () => {
  for (const response of [
    htmlResponse("Forbidden", 403), htmlResponse("x".repeat(2_000_001)),
    new Response(JSON.stringify({ description: "日本語です" }), { headers: { "Content-Type": "application/json" } }),
  ]) {
    const enrich = createJapaneseCompanyProfileEnricher({ fetch: async () => response.clone() });
    assert.equal(await enrich(PROFILE, INSTRUMENT, CONTEXT), PROFILE);
  }
});

test("unsupported listings, absent profiles and already cancelled calls make no requests", async () => {
  let calls = 0;
  const enrich = createJapaneseCompanyProfileEnricher({ fetch: async () => { calls += 1; return htmlResponse(""); } });
  for (const changes of [{ exchangeMic: "XXXX" }, { symbol: "../TEST" }, { active: false }]) {
    assert.equal(await enrich(PROFILE, { ...INSTRUMENT, ...changes }, CONTEXT), PROFILE);
  }
  assert.equal(await enrich(null, INSTRUMENT, CONTEXT), null);
  assert.equal(await enrich(PROFILE, INSTRUMENT, { ...CONTEXT, signal: AbortSignal.abort() }), PROFILE);
  assert.equal(calls, 0);
});
