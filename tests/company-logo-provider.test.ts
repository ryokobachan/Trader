import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CompanyLogo } from "../src/app/components/CompanyLogo";
import {
  companyLogoPathForUSStock,
  safeCompanyLogoSource,
} from "../src/app/platform/company-logo";

test("builds keyless company-logo URLs for arbitrary normalized US stock symbols", () => {
  assert.equal(
    companyLogoPathForUSStock(" aapl "),
    "https://financialmodelingprep.com/image-stock/AAPL.png",
  );
  assert.equal(
    companyLogoPathForUSStock("NBIS"),
    "https://financialmodelingprep.com/image-stock/NBIS.png",
  );
  assert.equal(
    companyLogoPathForUSStock("brk.b"),
    "https://financialmodelingprep.com/image-stock/BRK-B.png",
  );
  assert.equal(companyLogoPathForUSStock("../AAPL"), undefined);
  assert.equal(companyLogoPathForUSStock("AAPL?token=secret"), undefined);
});

test("allows only reviewed local logo assets and exact HTTPS CDN paths", () => {
  assert.equal(safeCompanyLogoSource("/company-logos/apple.svg"), "/company-logos/apple.svg");
  assert.equal(
    safeCompanyLogoSource("https://financialmodelingprep.com/image-stock/NBIS.png"),
    "https://financialmodelingprep.com/image-stock/NBIS.png",
  );

  for (const rejected of [
    "http://financialmodelingprep.com/image-stock/AAPL.png",
    "https://financialmodelingprep.com.evil.test/image-stock/AAPL.png",
    "https://user:pass@financialmodelingprep.com/image-stock/AAPL.png",
    "https://financialmodelingprep.com/image-stock/AAPL.png?apikey=placeholder",
    "https://financialmodelingprep.com/stable/profile?symbol=AAPL",
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
      logoPath: "/company-logos/apple.svg",
      logoFallback: "AA",
    },
    eager: true,
  }));

  assert.match(html, /<img\b/);
  assert.match(html, /src="\/company-logos\/apple\.svg"/);
  assert.doesNotMatch(html, /company-logo-fallback/);
  assert.doesNotMatch(html, />AA</);
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
