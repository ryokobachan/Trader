import assert from "node:assert/strict";
import test from "node:test";
import { createStockAnalysisOwnershipClient, extractStockAnalysisOwnership, StockAnalysisOwnershipError } from "../api/stockanalysis/ownership.server";
import type { Instrument } from "../src/app/platform/provider-contracts";

const NOW = "2026-09-05T04:30:00.000Z";
const NBIS: Instrument = {
  instrumentId: "us:XNAS:NBIS", symbol: "NBIS", name: "Nebius", assetType: "common_stock", active: true,
  listingCountry: "US", exchange: "NASDAQ", exchangeMic: "XNAS", currency: "USD",
  provenance: { providerId: "fixture", sourceId: "fixture", asOf: NOW, ingestedAt: NOW },
};
function cell(label: string, value: string, exact?: string) {
  return `<tr><td><span>${label}</span></td><td${exact ? ` title="${exact}"` : ""}>${value}</td></tr>`;
}
function html(rows = [
  cell("Owned by Insiders (%)", "15.24%", "15.238%"), cell("Owned by Institutions (%)", "63.74%", "63.739%"),
  cell("Short Interest", "55.36M", "55,355,915"), cell("Short Previous Month", "60.20M", "60,202,888"),
  cell("Short % of Shares Out", "20.20%", "20.196%"), cell("Short % of Float", "24.21%", "24.214%"),
  cell("Short Ratio (days to cover)", "2.12", "2.120"),
].join(""), symbol = "NBIS") {
  return `<html><head><title>Nebius Group (${symbol}) Statistics &amp; Valuation</title><link rel="canonical" href="https://stockanalysis.com/stocks/${symbol.toLowerCase()}/statistics/"/></head><body><table>${rows}</table><span>Last updated: Sep 5, 2026</span></body></html>`;
}

test("extracts public labelled rows, exact hover counts and fractional percentages with its own provenance", () => {
  const result = extractStockAnalysisOwnership(html(), NBIS, NOW);
  assert.equal(result.insiderOwnership, 0.15238);
  assert.equal(result.institutionalOwnership, 0.63739);
  assert.equal(result.sharesShort, 55_355_915);
  assert.equal(result.sharesShortPriorMonth, 60_202_888);
  assert.ok(Math.abs(result.shortOutstandingRatio! - 0.20196) < 1e-10);
  assert.equal(result.shortFloatRatio, 0.24214);
  assert.equal(result.shortRatio, 2.12);
  assert.equal(result.shortInterestDate, undefined, "page update is not the short-interest measurement date");
  assert.equal(result.provenance.providerId, "stockanalysis");
  assert.equal(result.provenance.asOf, NOW);
});

test("ignores scripts and missing cells, preserves real zero and scales visible counts", () => {
  const result = extractStockAnalysisOwnership(html([
    cell("Owned by Insiders (%)", "0.00%"), cell("Owned by Institutions (%)", "n/a", "55%"),
    cell("Short Interest", "1.25B"), cell("Short Previous Month", "700K"),
  ].join("")) + `<script>${cell("Short Ratio (days to cover)", "999")}</script>`, NBIS, NOW);
  assert.equal(result.insiderOwnership, 0);
  assert.equal(result.institutionalOwnership, undefined);
  assert.equal(result.sharesShort, 1_250_000_000);
  assert.equal(result.sharesShortPriorMonth, 700_000);
  assert.equal(result.shortRatio, undefined);
});

test("fails closed for wrong symbol, challenge pages, missing identity and invalid units", () => {
  const bad = [
    html(undefined, "MU"), "<title>Just a moment...</title>", html().replace('rel="canonical"', 'rel="alternate"'),
    html(cell("Owned by Insiders (%)", "15.24")), html(cell("Short Interest", "$55.36M")),
    html(cell("Short Ratio (days to cover)", "-2.12")),
    html(cell("Short Interest", "55.36M", "999,000,000")),
    html(cell("Short Interest", "55M") + cell("Short Interest", "66M")),
    html("") + `<script>${cell("Short Interest", "55M")}</script>`,
  ];
  for (const body of bad) assert.throws(() => extractStockAnalysisOwnership(body, NBIS, NOW), (error: unknown) => error instanceof StockAnalysisOwnershipError && error.code === "invalid_response");
});

test("fetches a fixed public URL with no credentials and disallows redirects", async () => {
  const client = createStockAnalysisOwnershipClient({ now: () => new Date(NOW), fetch: async (input, init) => {
    assert.equal(String(input), "https://stockanalysis.com/stocks/nbis/statistics/");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("cookie"), null);
    return new Response(html());
  } });
  assert.equal((await client.getOwnership(NBIS)).sharesShort, 55_355_915);
});

test("bounds body/request wait and sanitizes upstream failure", async () => {
  const timeout = createStockAnalysisOwnershipClient({ timeoutMs: 5, fetch: () => new Promise(() => undefined) });
  await assert.rejects(timeout.getOwnership(NBIS), (error: unknown) => error instanceof StockAnalysisOwnershipError && error.code === "timeout");
  const oversized = createStockAnalysisOwnershipClient({ fetch: async () => new Response("x".repeat(2_000_001)) });
  await assert.rejects(oversized.getOwnership(NBIS), (error: unknown) => error instanceof StockAnalysisOwnershipError && error.code === "invalid_response");
  const forbidden = createStockAnalysisOwnershipClient({ fetch: async () => new Response("secret", { status: 403 }) });
  await assert.rejects(forbidden.getOwnership(NBIS), (error: unknown) => {
    assert.ok(error instanceof StockAnalysisOwnershipError);
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test("rejects redirects without following their destination on Workers", async () => {
  let calls = 0;
  const client = createStockAnalysisOwnershipClient({ fetch: async (_input, init) => {
    calls += 1;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 301, headers: { location: "https://example.com/unexpected-target" } });
  } });
  await assert.rejects(client.getOwnership(NBIS), (error: unknown) => {
    assert.ok(error instanceof StockAnalysisOwnershipError);
    assert.equal(error.code, "upstream");
    assert.equal(error.status, 301);
    return true;
  });
  assert.equal(calls, 1);
});
