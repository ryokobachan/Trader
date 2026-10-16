import assert from "node:assert/strict";
import test from "node:test";
import { mergeFreshWorkspaceSection } from "../src/app/features/stock-detail/workspace-refresh";
import type { CompanyResearch, DataProvenance, SymbolWorkspace } from "../src/app/platform/provider-contracts";

function provenance(sourceId: string, providerId = "yahoo"): DataProvenance {
  return { providerId, sourceId, asOf: "2026-08-12", ingestedAt: "2026-08-12T20:00:00.000Z" };
}
function research(overrides: Partial<CompanyResearch> = {}): CompanyResearch {
  return {
    instrumentId: "us:XNAS:AAPL",
    ownership: { insiderOwnership: 0.02, provenance: provenance("old-ownership", "stockanalysis") },
    quarterlyFinancials: [{ period: "2026-06-30", fiscalDateEnding: "2026-06-30", currency: "USD", revenue: 100, provenance: provenance("old-financials") }],
    annualCashFlows: [{ period: "2025-12-31", currency: "USD", operatingCashFlow: 50, provenance: provenance("old-annual-cf") }],
    corporateActions: [{ id: "old-dividend", type: "dividend", date: "2026-08-10", amount: 0.26, currency: "USD", provenance: provenance("old-dividend") }],
    coverage: { ownership: "available", quarterlyFinancials: "available", corporateActions: "available" },
    provenance: provenance("old-research"),
    ...overrides,
  };
}
function workspace(overrides: Partial<SymbolWorkspace> = {}): SymbolWorkspace {
  return {
    schemaVersion: "trader.symbol-workspace.v1",
    instrument: {
      instrumentId: "us:XNAS:AAPL", symbol: "AAPL", name: "Apple", assetType: "common_stock", active: true,
      listingCountry: "US", exchange: "NASDAQ", exchangeMic: "XNAS", currency: "USD", provenance: provenance("instrument"),
    },
    quote: {
      instrumentId: "us:XNAS:AAPL", price: 100, change: 0, changePercent: 0, previousClose: 100,
      open: 100, high: 100, low: 100, volume: 1, currency: "USD", marketState: "closed", delaySeconds: 0, provenance: provenance("quote"),
    },
    profile: null, fundamentals: null, earnings: [], analyst: null, news: [], research: research(),
    selectedProviders: { instrument: "yahoo", market: "yahoo", research: "yahoo" },
    dataMode: "provider", status: "complete", warnings: [], asOf: "2026-08-12T20:00:00.000Z",
    ...overrides,
  };
}

for (const section of ["financials", "research"] as const) {
  test(`${section} refresh retains failed source datasets with stale provenance and preserves fresh data`, () => {
    const current = workspace();
    const refreshed = workspace({
      research: research({
        ownership: undefined, quarterlyFinancials: [],
        corporateActions: [{ id: "new-dividend", type: "dividend", date: "2026-09-01", amount: 0.3, provenance: provenance("new-dividend") }],
        coverage: { ownership: "unavailable", quarterlyFinancials: "unavailable", corporateActions: "available" },
        provenance: provenance("new-research"),
      }),
      warnings: ["research: partial_coverage"], status: "partial",
    });
    const merged = mergeFreshWorkspaceSection(current, refreshed, section);
    assert.equal(merged.research!.ownership!.insiderOwnership, 0.02);
    assert.equal(merged.research!.ownership!.provenance.isStale, true);
    assert.equal(merged.research!.ownership!.provenance.providerId, "stockanalysis");
    assert.equal(merged.research!.quarterlyFinancials![0].revenue, 100);
    assert.equal(merged.research!.quarterlyFinancials![0].provenance.isStale, true);
    assert.equal(merged.research!.annualCashFlows![0].operatingCashFlow, 50);
    assert.equal(merged.research!.annualCashFlows![0].provenance.isStale, true);
    assert.equal(merged.research!.corporateActions[0].id, "new-dividend");
    assert.equal(merged.research!.corporateActions[0].provenance.isStale, undefined);
    assert.deepEqual(merged.research!.coverage, refreshed.research!.coverage);
    assert.equal(merged.research!.provenance.isStale, true);
    assert.equal(merged.research!.provenance.sourceId, "new-research");
    assert.equal(current.research!.ownership!.provenance.isStale, undefined, "cached input must not be mutated");
    assert.equal(refreshed.research!.provenance.isStale, undefined);
  });

  test(`${section} refresh retains old corporate actions only when their source is unavailable`, () => {
    const refreshed = workspace({ research: research({ corporateActions: [], coverage: { ownership: "available", quarterlyFinancials: "available", corporateActions: "unavailable" } }) });
    const merged = mergeFreshWorkspaceSection(workspace(), refreshed, section);
    assert.equal(merged.research!.corporateActions[0].id, "old-dividend");
    assert.equal(merged.research!.corporateActions[0].provenance.isStale, true);
    assert.equal(merged.research!.ownership!.provenance.isStale, undefined);
    assert.equal(merged.research!.coverage.corporateActions, "unavailable");
  });

  test(`${section} refresh accepts available empty data and clears prior datasets`, () => {
    const refreshed = workspace({ research: research({ ownership: undefined, quarterlyFinancials: [], corporateActions: [] }) });
    const merged = mergeFreshWorkspaceSection(workspace(), refreshed, section);
    assert.strictEqual(merged.research, refreshed.research);
    assert.equal(merged.research!.ownership, undefined);
    assert.deepEqual(merged.research!.quarterlyFinancials, []);
    assert.deepEqual(merged.research!.corporateActions, []);
    assert.equal(merged.research!.provenance.isStale, undefined);
  });

  test(`${section} full upstream failure marks all retained research provenance stale and all coverage unavailable`, () => {
    const current = workspace();
    const refreshed = workspace({ research: null, warnings: ["research: upstream_unavailable"], selectedProviders: { instrument: "yahoo", market: "yahoo", research: "replacement" } });
    const merged = mergeFreshWorkspaceSection(current, refreshed, section);
    assert.equal(merged.research!.provenance.isStale, true);
    assert.equal(merged.research!.ownership!.provenance.isStale, true);
    assert.equal(merged.research!.quarterlyFinancials![0].provenance.isStale, true);
    assert.equal(merged.research!.corporateActions[0].provenance.isStale, true);
    assert.deepEqual(Object.values(merged.research!.coverage), ["unavailable", "unavailable", "unavailable"]);
    assert.equal(merged.selectedProviders.research, "yahoo");
    assert.equal(merged.research!.provenance.ingestedAt, current.research!.provenance.ingestedAt);
    assert.equal(merged.status, "partial");
  });

  test(`${section} disabled research clears prior data even if a transient warning is also present`, () => {
    const merged = mergeFreshWorkspaceSection(workspace(), workspace({ research: null, warnings: ["research: upstream_unavailable", "research: provider_not_configured"] }), section);
    assert.equal(merged.research, null);
    assert.equal(merged.selectedProviders.research, undefined);
  });
}

test("does not retain nonexistent data or observations belonging to a different instrument identity", () => {
  const missing = research({ ownership: undefined, quarterlyFinancials: undefined, annualCashFlows: undefined, corporateActions: [] });
  const failed = workspace({ research: research({ ownership: undefined, quarterlyFinancials: [], corporateActions: [], coverage: { ownership: "unavailable", quarterlyFinancials: "unavailable", corporateActions: "unavailable" } }) });
  const noPrevious = mergeFreshWorkspaceSection(workspace({ research: missing }), failed, "research");
  assert.strictEqual(noPrevious.research, failed.research);
  const mismatched = workspace({ research: research({ instrumentId: "us:XNAS:MU" }) });
  assert.strictEqual(mergeFreshWorkspaceSection(mismatched, failed, "financials").research, failed.research);
  const totalFailure = workspace({ research: null, warnings: ["research: upstream_unavailable"] });
  assert.equal(mergeFreshWorkspaceSection(mismatched, totalFailure, "research").research, null);
  const anotherSymbol = workspace({ instrument: { ...failed.instrument, symbol: "MU", instrumentId: "us:XNAS:MU" } });
  assert.strictEqual(mergeFreshWorkspaceSection(workspace(), anotherSymbol, "research"), anotherSymbol);
});

test("analyst/news-only refreshes leave research unchanged", () => {
  const current = workspace();
  const failed = workspace({ research: null, warnings: ["research: upstream_unavailable"] });
  for (const section of ["analyst", "news"] as const) {
    assert.strictEqual(mergeFreshWorkspaceSection(current, failed, section).research, current.research);
  }
});
