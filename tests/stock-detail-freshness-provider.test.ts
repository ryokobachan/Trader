import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GET as getWorkspace } from "../src/app/api/v1/symbols/[symbol]/workspace/route";
import {
  createLatestRequestCoordinator,
  mergeFreshWorkspaceSection,
} from "../src/app/features/stock-detail/workspace-refresh";
import type { SymbolWorkspace } from "../src/app/platform/provider-contracts";

function workspace(
  symbol: string,
  overrides: Partial<SymbolWorkspace> = {},
): SymbolWorkspace {
  const provenance = {
    providerId: "mock",
    sourceId: symbol,
    asOf: "2026-08-12T20:00:00.000Z",
    ingestedAt: "2026-08-12T20:00:01.000Z",
  } as const;
  return {
    schemaVersion: "unicorn.symbol-workspace.v1",
    instrument: {
      instrumentId: `us:${symbol}`,
      symbol,
      name: symbol,
      assetType: "common_stock",
      active: true,
      listingCountry: "US",
      exchange: "NASDAQ",
      exchangeMic: "XNAS",
      currency: "USD",
      provenance,
    },
    quote: {
      instrumentId: `us:${symbol}`,
      price: 100,
      change: 0,
      changePercent: 0,
      previousClose: 100,
      open: 100,
      high: 100,
      low: 100,
      volume: 1,
      currency: "USD",
      marketState: "closed",
      delaySeconds: 0,
      provenance,
    },
    profile: null,
    fundamentals: null,
    earnings: [],
    analyst: null,
    news: [],
    selectedProviders: { instrument: "mock", market: "mock" },
    dataMode: "provider",
    status: "complete",
    warnings: [],
    asOf: provenance.asOf,
    ...overrides,
  };
}

test("workspace coordinator deduplicates one key and suppresses superseded results", async () => {
  const coordinator = createLatestRequestCoordinator();
  let resolveFirst!: (value: string) => void;
  let calls = 0;
  const first = coordinator.run("AAPL:financials", async () => {
    calls += 1;
    return new Promise<string>((resolve) => { resolveFirst = resolve; });
  });
  const duplicate = coordinator.run("AAPL:financials", async () => {
    calls += 1;
    return "duplicate";
  });
  assert.strictEqual(first, duplicate);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);

  const newer = coordinator.run("MSFT:financials", async () => "newer");
  resolveFirst("old");
  assert.deepEqual(await first, { status: "success", current: false, value: "old" });
  assert.deepEqual(await newer, { status: "success", current: true, value: "newer" });
});

test("a financial tab refresh supersedes an unfinished initial workspace read", async () => {
  const coordinator = createLatestRequestCoordinator();
  let resolveInitial!: (value: SymbolWorkspace) => void;
  const initial = coordinator.run("AAPL:initial", async () => (
    new Promise<SymbolWorkspace>((resolve) => { resolveInitial = resolve; })
  ));
  await Promise.resolve();

  const fresh = coordinator.run("AAPL:?fresh=1", async () => workspace("AAPL", {
    earnings: [{
      reportDate: "2026-08-12",
      epsActual: 2.05,
      provenance: {
        providerId: "yahoo",
        sourceId: "fresh-after-initial",
        asOf: "2026-08-12",
        ingestedAt: "2026-08-13T00:00:00.000Z",
      },
    }],
  }));
  resolveInitial(workspace("AAPL", { earnings: [] }));

  const freshResult = await fresh;
  assert.equal(freshResult.status, "success");
  assert.equal(freshResult.status === "success" && freshResult.current, true);
  assert.equal(
    freshResult.status === "success" ? freshResult.value.earnings[0]?.epsActual : null,
    2.05,
  );
  assert.deepEqual(await initial, {
    status: "success",
    current: false,
    value: workspace("AAPL", { earnings: [] }),
  });
});

test("opening the same tab again after completion performs a new fetch", async () => {
  const coordinator = createLatestRequestCoordinator();
  const earningsRefresh = (epsActual: number) => workspace("AAPL", {
    earnings: [{
      reportDate: "2026-08-12",
      epsActual,
      provenance: {
        providerId: "yahoo",
        sourceId: `earnings-${epsActual}`,
        asOf: "2026-08-12",
        ingestedAt: "2026-08-13T00:00:00.000Z",
      },
    }],
  });
  let calls = 0;
  let current = workspace("AAPL");
  const first = await coordinator.run("AAPL:financials", async () => {
    calls += 1;
    return earningsRefresh(1.95);
  });
  assert.equal(first.status, "success");
  if (first.status === "success") current = mergeFreshWorkspaceSection(current, first.value, "financials");
  const second = await coordinator.run("AAPL:financials", async () => {
    calls += 1;
    return earningsRefresh(2.05);
  });
  assert.equal(second.status, "success");
  if (second.status === "success") current = mergeFreshWorkspaceSection(current, second.value, "financials");
  assert.equal(calls, 2);
  assert.equal(current.earnings[0]?.epsActual, 2.05);
});

test("financial refresh replaces its fields and warnings without dropping analyst/news", () => {
  const current = workspace("AAPL", {
    analyst: {
      instrumentId: "us:AAPL",
      targetConsensus: 250,
      provenance: {
        providerId: "benzinga",
        sourceId: "analyst",
        asOf: "2026-08-12T20:00:00.000Z",
        ingestedAt: "2026-08-12T20:00:01.000Z",
      },
    },
    news: [{
      id: "news-1",
      instrumentId: "us:AAPL",
      title: "News",
      url: "https://example.com/news",
      publisher: "Example",
      publishedAt: "2026-08-12T20:00:00.000Z",
      provenance: {
        providerId: "mock",
        sourceId: "news",
        asOf: "2026-08-12T20:00:00.000Z",
        ingestedAt: "2026-08-12T20:00:01.000Z",
      },
    }],
    warnings: ["earnings: upstream_unavailable", "analyst: upstream_unavailable"],
    status: "partial",
  });
  const refresh = workspace("AAPL", {
    earnings: [{
      reportDate: "2026-08-12",
      epsActual: 2.01,
      provenance: {
        providerId: "yahoo",
        sourceId: "fresh-earnings",
        asOf: "2026-08-12",
        ingestedAt: "2026-08-13T00:00:00.000Z",
      },
    }],
    warnings: [],
    selectedProviders: {
      instrument: "yahoo",
      market: "tradingview-websocket",
      profile: "yahoo",
      fundamentals: "yahoo",
      earnings: "yahoo",
    },
  });
  const merged = mergeFreshWorkspaceSection(current, refresh, "financials");
  assert.equal(merged.earnings[0]?.epsActual, 2.01);
  assert.equal(merged.analyst?.targetConsensus, 250);
  assert.equal(merged.news.length, 1);
  assert.deepEqual(merged.warnings, ["analyst: upstream_unavailable"]);
  assert.equal(merged.status, "partial");
});

test("financial refresh retains only fields whose upstream temporarily failed", () => {
  const provenance = {
    providerId: "existing",
    sourceId: "existing",
    asOf: "2026-08-12",
    ingestedAt: "2026-08-12T20:00:01.000Z",
  } as const;
  const current = workspace("AAPL", {
    profile: {
      instrumentId: "us:AAPL",
      description: "Existing profile",
      provenance,
    },
    fundamentals: {
      instrumentId: "us:AAPL",
      currency: "USD",
      revenue: 100,
      provenance,
    },
    earnings: [{ reportDate: "2026-08-12", epsActual: 2.05, provenance }],
    analyst: {
      instrumentId: "us:AAPL",
      targetConsensus: 250,
      provenance,
    },
    warnings: ["analyst: upstream_unavailable"],
    status: "partial",
    selectedProviders: {
      instrument: "existing-instrument",
      market: "existing-market",
      profile: "existing-profile",
      fundamentals: "existing-fundamentals",
      earnings: "existing-earnings",
      analyst: "existing-analyst",
    },
  });
  const refreshed = workspace("AAPL", {
    profile: null,
    fundamentals: null,
    earnings: [],
    warnings: [
      "profile: upstream_unavailable",
      "fundamentals: provider_not_configured",
      "earnings: upstream_unavailable",
    ],
    status: "partial",
    selectedProviders: {
      instrument: "fresh-instrument",
      market: "fresh-market",
      profile: "fresh-profile",
      earnings: "fresh-earnings",
    },
  });

  const merged = mergeFreshWorkspaceSection(current, refreshed, "financials");
  assert.equal(merged.profile?.description, "Existing profile");
  assert.equal(merged.earnings[0]?.epsActual, 2.05);
  assert.equal(merged.selectedProviders.profile, "existing-profile");
  assert.equal(merged.selectedProviders.earnings, "existing-earnings");
  assert.equal(merged.fundamentals, null);
  assert.equal(merged.selectedProviders.fundamentals, undefined);
  assert.equal(merged.selectedProviders.instrument, "fresh-instrument");
  assert.equal(merged.selectedProviders.market, "fresh-market");
  assert.deepEqual(merged.warnings, [
    "analyst: upstream_unavailable",
    "profile: upstream_unavailable",
    "fundamentals: provider_not_configured",
    "earnings: upstream_unavailable",
  ]);
});

test("analyst and news keep stale values on transient failure but clear disabled providers", () => {
  const provenance = {
    providerId: "existing",
    sourceId: "existing",
    asOf: "2026-08-12",
    ingestedAt: "2026-08-12T20:00:01.000Z",
  } as const;
  const current = workspace("AAPL", {
    analyst: {
      instrumentId: "us:AAPL",
      targetConsensus: 250,
      provenance,
    },
    news: [{
      id: "existing-news",
      instrumentId: "us:AAPL",
      title: "Existing news",
      url: "https://example.com/existing",
      publisher: "Example",
      publishedAt: "2026-08-12T20:00:00.000Z",
      provenance,
    }],
    selectedProviders: {
      instrument: "existing-instrument",
      market: "existing-market",
      analyst: "existing-analyst",
      news: "existing-news",
    },
  });
  const analystFailure = workspace("AAPL", {
    analyst: null,
    warnings: ["analyst: upstream_unavailable"],
    status: "partial",
    selectedProviders: {
      instrument: "fresh-instrument",
      market: "fresh-market",
      analyst: "fresh-analyst",
    },
  });
  const newsFailure = workspace("AAPL", {
    news: [],
    warnings: ["news: upstream_unavailable"],
    status: "partial",
    selectedProviders: {
      instrument: "fresh-instrument",
      market: "fresh-market",
      news: "fresh-news",
    },
  });

  const afterAnalystFailure = mergeFreshWorkspaceSection(current, analystFailure, "analyst");
  assert.equal(afterAnalystFailure.analyst?.targetConsensus, 250);
  assert.equal(afterAnalystFailure.selectedProviders.analyst, "existing-analyst");
  const afterNewsFailure = mergeFreshWorkspaceSection(afterAnalystFailure, newsFailure, "news");
  assert.equal(afterNewsFailure.news[0]?.id, "existing-news");
  assert.equal(afterNewsFailure.selectedProviders.news, "existing-news");

  const analystDisabled = workspace("AAPL", {
    analyst: null,
    warnings: ["analyst: provider_not_configured"],
    status: "partial",
    selectedProviders: { instrument: "fresh-instrument", market: "fresh-market" },
  });
  const newsDisabled = workspace("AAPL", {
    news: [],
    warnings: ["news: provider_not_configured"],
    status: "partial",
    selectedProviders: { instrument: "fresh-instrument", market: "fresh-market" },
  });
  const afterAnalystDisabled = mergeFreshWorkspaceSection(afterNewsFailure, analystDisabled, "analyst");
  assert.equal(afterAnalystDisabled.analyst, null);
  assert.equal(afterAnalystDisabled.selectedProviders.analyst, undefined);
  const afterNewsDisabled = mergeFreshWorkspaceSection(afterAnalystDisabled, newsDisabled, "news");
  assert.deepEqual(afterNewsDisabled.news, []);
  assert.equal(afterNewsDisabled.selectedProviders.news, undefined);
});

test("analyst and news refreshes replace only their own data, provider, and warning", () => {
  const current = workspace("AAPL", {
    profile: {
      instrumentId: "us:AAPL",
      description: "Retain this profile",
      provenance: {
        providerId: "yahoo",
        sourceId: "profile",
        asOf: "2026-08-12",
        ingestedAt: "2026-08-12T20:00:01.000Z",
      },
    },
    analyst: {
      instrumentId: "us:AAPL",
      targetConsensus: 240,
      provenance: {
        providerId: "benzinga",
        sourceId: "old-analyst",
        asOf: "2026-08-11",
        ingestedAt: "2026-08-11T20:00:01.000Z",
      },
    },
    news: [{
      id: "old-news",
      instrumentId: "us:AAPL",
      title: "Old news",
      url: "https://example.com/old",
      publisher: "Example",
      publishedAt: "2026-08-11T20:00:00.000Z",
      provenance: {
        providerId: "yahoo",
        sourceId: "old-news",
        asOf: "2026-08-11",
        ingestedAt: "2026-08-11T20:00:01.000Z",
      },
    }],
    warnings: ["earnings: upstream_unavailable", "analyst: upstream_unavailable", "news: upstream_unavailable"],
    status: "partial",
    selectedProviders: {
      instrument: "yahoo",
      market: "tradingview-websocket",
      profile: "yahoo",
      analyst: "benzinga",
      news: "yahoo",
    },
  });
  const analystRefresh = workspace("AAPL", {
    quote: {
      ...current.quote,
      price: 101,
      provenance: {
        ...current.quote.provenance,
        sourceId: "fresh-quote",
        asOf: "2026-08-13T00:00:00.000Z",
      },
    },
    analyst: {
      instrumentId: "us:AAPL",
      targetConsensus: 255,
      provenance: {
        providerId: "benzinga",
        sourceId: "fresh-analyst",
        asOf: "2026-08-13",
        ingestedAt: "2026-08-13T00:00:00.000Z",
      },
    },
    warnings: [],
    selectedProviders: { instrument: "yahoo", market: "tradingview-websocket", analyst: "benzinga" },
    asOf: "2026-08-13T00:00:00.000Z",
  });
  const afterAnalyst = mergeFreshWorkspaceSection(current, analystRefresh, "analyst");
  assert.equal(afterAnalyst.analyst?.targetConsensus, 255);
  assert.equal(afterAnalyst.quote.price, 101);
  assert.equal(afterAnalyst.asOf, "2026-08-13T00:00:00.000Z");
  assert.equal(afterAnalyst.selectedProviders.market, "tradingview-websocket");
  assert.equal(afterAnalyst.profile?.description, "Retain this profile");
  assert.equal(afterAnalyst.news[0]?.id, "old-news");
  assert.deepEqual(afterAnalyst.warnings, ["earnings: upstream_unavailable", "news: upstream_unavailable"]);

  const newsRefresh = workspace("AAPL", {
    news: [{
      id: "fresh-news",
      instrumentId: "us:AAPL",
      title: "Fresh news",
      url: "https://example.com/fresh",
      publisher: "Example",
      publishedAt: "2026-08-13T00:00:00.000Z",
      provenance: {
        providerId: "yahoo",
        sourceId: "fresh-news",
        asOf: "2026-08-13",
        ingestedAt: "2026-08-13T00:00:01.000Z",
      },
    }],
    warnings: [],
    selectedProviders: { instrument: "yahoo", market: "tradingview-websocket", news: "yahoo" },
  });
  const afterNews = mergeFreshWorkspaceSection(afterAnalyst, newsRefresh, "news");
  assert.equal(afterNews.news[0]?.id, "fresh-news");
  assert.equal(afterNews.analyst?.targetConsensus, 255);
  assert.equal(afterNews.profile?.description, "Retain this profile");
  assert.deepEqual(afterNews.warnings, ["earnings: upstream_unavailable"]);
});

test("fresh workspace sections are wired through one no-cache coordinator", async () => {
  const [page, route, yahoo, sidecar] = await Promise.all([
    readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/v1/symbols/[symbol]/workspace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/yahoo/index.server.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/tradingview-websocket/sidecar.py", import.meta.url), "utf8"),
  ]);
  assert.match(page, /activeStockDetailSection/);
  assert.match(page, /section=\$\{encodeURIComponent\(refreshSection\)\}&fresh=1/);
  assert.match(page, /requestWorkspace\(selectedTicker, activeStockDetailSection\)/);
  assert.match(page, /requestWorkspace\(selectedTicker, "news"\)/);
  assert.match(page, /setWorkspaceSectionRefreshNonce\(\(current\) => current \+ 1\)/);
  assert.match(page, /workspaceSectionRefreshNonce\]\);/);
  assert.match(page, /cache: "no-store"/);
  assert.match(page, /workspaceRequestCoordinator\.run/);
  assert.match(route, /fresh === "1" \? \{ fresh: true \} : \{\}/);
  assert.match(route, /fresh === "1" \? "private, no-store"/);
  assert.match(yahoo, /if \(context\?\.fresh\) url\.searchParams\.set\("fresh", "1"\)/);
  assert.match(sidecar, /if not force_refresh and cached is not None/);
});

test("workspace route rejects unknown section and malformed fresh controls", async () => {
  const context = { params: Promise.resolve({ symbol: "AAPL" }) };
  const [section, fresh] = await Promise.all([
    getWorkspace(
      new Request("http://localhost/api/v1/symbols/AAPL/workspace?section=unknown"),
      context,
    ),
    getWorkspace(
      new Request("http://localhost/api/v1/symbols/AAPL/workspace?fresh=0"),
      context,
    ),
  ]);
  assert.equal(section.status, 400);
  assert.equal(fresh.status, 400);
  assert.equal((await section.json() as { error: { code: string } }).error.code, "invalid_section");
  assert.equal((await fresh.json() as { error: { code: string } }).error.code, "invalid_fresh");
});
