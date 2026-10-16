import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CompanyLogo } from "../src/app/components/CompanyLogo";
import { resolveTradingViewLogo } from "../api/company-logo.server";
import {
  companyLogoPathForUSStock,
  safeCompanyLogoSource,
} from "../src/app/platform/company-logo";

test("builds keyless company-logo URLs for arbitrary normalized US stock symbols", () => {
  assert.equal(
    companyLogoPathForUSStock(" aapl "),
    "/api/v1/symbols/AAPL/logo",
  );
  assert.equal(
    companyLogoPathForUSStock("NBIS"),
    "/api/v1/symbols/NBIS/logo",
  );
  assert.equal(
    companyLogoPathForUSStock("brk.b"),
    "/api/v1/symbols/BRK.B/logo",
  );
  assert.equal(companyLogoPathForUSStock("../AAPL"), undefined);
  assert.equal(companyLogoPathForUSStock("AAPL?token=secret"), undefined);
});

test("allows only exact reviewed HTTPS CDN paths", () => {
  assert.equal(
    safeCompanyLogoSource("https://s3-symbol-logo.tradingview.com/nebius-group-nv.svg"),
    "https://s3-symbol-logo.tradingview.com/nebius-group-nv.svg",
  );

  for (const rejected of [
    "http://s3-symbol-logo.tradingview.com/apple.svg",
    "https://s3-symbol-logo.tradingview.com.evil.test/apple.svg",
    "https://user:pass@s3-symbol-logo.tradingview.com/apple.svg",
    "https://s3-symbol-logo.tradingview.com/apple.svg?token=secret",
    "/api/v1/symbols/../logo",
    "/api/v1/symbols/AAPL/logo?redirect=external",
    "http://financialmodelingprep.com/image-stock/AAPL.png",
    "https://financialmodelingprep.com.evil.test/image-stock/AAPL.png",
    "https://user:pass@financialmodelingprep.com/image-stock/AAPL.png",
    "https://financialmodelingprep.com/image-stock/AAPL.png?apikey=placeholder",
    "https://financialmodelingprep.com/stable/profile?symbol=AAPL",
    "/company-logos/apple.svg",
    "/company-logos/../secret.svg",
    "data:image/svg+xml,<svg/>",
    "javascript:alert(1)",
  ]) {
    assert.equal(safeCompanyLogoSource(rejected), null, rejected);
  }
});

test("renders a valid company logo without also drawing its monogram fallback", () => {
  const html = renderToStaticMarkup(createElement(CompanyLogo, {
    stock: {
      ticker: "AAPL",
      name: "Apple Inc.",
      logoPath: "/api/v1/symbols/AAPL/logo",
      logoFallback: "AA",
    },
    eager: true,
  }));

  assert.match(html, /<img\b/);
  assert.match(html, /src="\/api\/v1\/symbols\/AAPL\/logo"/);
  assert.doesNotMatch(html, /company-logo-fallback/);
  assert.doesNotMatch(html, />AA</);
});

test("resolves only the matching TradingView symbol and a reviewed logo identifier", async () => {
  const source = await resolveTradingViewLogo("NBIS", async (input, init) => {
    assert.equal(String(input), "https://scanner.tradingview.com/america/scan");
    assert.equal(init?.redirect, "manual");
    assert.deepEqual(JSON.parse(String(init?.body)).symbols.tickers, ["NASDAQ:NBIS", "NYSE:NBIS", "AMEX:NBIS"]);
    return Response.json({ data: [
      { s: "NASDAQ:AAPL", d: ["AAPL", "apple"] },
      { s: "NASDAQ:NBIS", d: ["NBIS", "nebius-group-nv"] },
    ] });
  });
  assert.equal(source, "https://s3-symbol-logo.tradingview.com/nebius-group-nv.svg");
  assert.equal(await resolveTradingViewLogo("AAPL", async () => Response.json({ data: [
    { s: "NASDAQ:AAPL", d: ["AAPL", "../../malicious?x=1"] },
  ] })), null);
  assert.equal(await resolveTradingViewLogo("../AAPL", async () => { throw new Error("must not fetch"); }), null);
  await assert.rejects(resolveTradingViewLogo("AAPL", async () => new Response(null, { status: 302, headers: { location: "https://untrusted.example" } })), /unavailable/);
});

test("renders the monogram only when no reviewed company-logo source is available", () => {
  const html = renderToStaticMarkup(createElement(CompanyLogo, {
    stock: {
      ticker: "NBIS",
      name: "Nebius Group N.V.",
      logoPath: "javascript:alert(1)",
      logoFallback: "NB",
    },
  }));

  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /class="company-logo-fallback"/);
  assert.match(html, />NB<\/span>/);
});
