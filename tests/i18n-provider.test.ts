import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_LOCALE,
  I18nProvider,
  LOCALE_STORAGE_KEY,
  isLocale,
  normalizeLocale,
  readStoredLocale,
  translate,
  useI18n,
  writeStoredLocale,
  type Locale,
} from "../app/platform/i18n";

function LocaleProbe() {
  const { locale, t } = useI18n();
  return createElement("p", { "data-locale": locale }, t("settings.language.current", {
    language: t(`settings.language.${locale === "en" ? "english" : "japanese"}`),
  }));
}

function fakeStorage(initialValue: string | null = null) {
  const values = new Map<string, string>();
  if (initialValue !== null) values.set(LOCALE_STORAGE_KEY, initialValue);

  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("English is the runtime-validated default and SSR language", async () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("ja"), true);
  assert.equal(isLocale("fr"), false);
  assert.equal(normalizeLocale("fr"), "en");

  const html = renderToStaticMarkup(
    createElement(I18nProvider, null, createElement(LocaleProbe)),
  );
  assert.match(html, /data-locale="en"/);
  assert.match(html, /Current language: English/);

  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<html lang=\{DEFAULT_LOCALE\}>/);
  assert.match(layout, /<I18nProvider>\{children\}<\/I18nProvider>/);
});

test("a Japanese preference can be saved, restored, and rendered", () => {
  const storage = fakeStorage();
  assert.equal(writeStoredLocale(storage, "ja"), true);
  assert.equal(readStoredLocale(storage), "ja");

  const restored = readStoredLocale(storage);
  const html = renderToStaticMarkup(
    createElement(I18nProvider, { initialLocale: restored }, createElement(LocaleProbe)),
  );
  assert.match(html, /data-locale="ja"/);
  assert.match(html, /現在の言語: 日本語/);
});

test("invalid or unavailable storage safely falls back without breaking SSR", () => {
  assert.equal(readStoredLocale(fakeStorage("invalid")), DEFAULT_LOCALE);
  assert.equal(readStoredLocale({ getItem: () => { throw new Error("blocked"); } }), DEFAULT_LOCALE);
  assert.equal(writeStoredLocale({ setItem: () => { throw new Error("full"); } }, "ja"), false);
  assert.equal(readStoredLocale(null), DEFAULT_LOCALE);
});

test("translations interpolate parameters and fall back to English then the key", () => {
  assert.equal(translate("en", "watchlist.deleteSymbol", { symbol: "AAPL" }), "Remove AAPL from watchlist");
  assert.equal(translate("ja", "watchlist.deleteSymbol", { symbol: "AAPL" }), "AAPLをウォッチリストから削除");
  assert.equal(translate("ja", "missing.translation"), "missing.translation");
  assert.equal(translate("en", "settings.language.current"), "Current language: {language}");
});

test("provider restores storage after hydration, persists switches, and updates document language", async () => {
  const source = await readFile(new URL("../app/platform/i18n.tsx", import.meta.url), "utf8");
  assert.match(source, /readStoredLocale\(window\.localStorage/);
  assert.match(source, /writeStoredLocale\(window\.localStorage, locale\)/);
  assert.match(source, /document\.documentElement\.lang = locale/);
  assert.match(source, /addEventListener\("storage"/);
  assert.match(source, /removeEventListener\("storage"/);

  const locales: Locale[] = ["en", "ja"];
  assert.deepEqual(locales.map((locale) => translate(locale, "settings.language.title")), ["Language", "言語"]);
});

test("workspace settings use a controlled locale draft and persist it on Apply", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /const \{ locale, setLocale, t, supportedLocales \} = useI18n\(\)/);
  assert.match(page, /const \[localeDraft, setLocaleDraft\] = useState<Locale>\(locale\)/);
  assert.match(page, /setLocaleDraft\(locale\)/);
  assert.match(page, /setLocale\(localeDraft\)/);
  assert.match(page, /<select value=\{localeDraft\}/);
  assert.match(page, /supportedLocales\.map/);
  assert.match(page, /settings\.language\.storageNote/);
});
