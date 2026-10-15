import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoadingIndicator } from "../src/app/components/LoadingIndicator";
import { I18nProvider } from "../src/app/platform/i18n";

for (const locale of ["en", "ja"] as const) {
  test(`loading indicator is visual with a localized accessible status (${locale})`, () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale }, createElement(LoadingIndicator)));
    assert.match(html, /role="status" aria-label="[^"]+"/);
    assert.match(html, /class="loading-spinner" aria-hidden="true"/);
    assert.equal(html.replace(/<[^>]*>/g, ""), "");
  });
}

test("loading indicator accepts a context-specific accessible label", () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(LoadingIndicator, { label: "Loading chart history" })));
  assert.match(html, /aria-label="Loading chart history"/);
  assert.equal(html.replace(/<[^>]*>/g, ""), "");
});
