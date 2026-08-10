import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { translate } from "../src/app/platform/i18n";

const pageSource = readFileSync("src/app/page.tsx", "utf8");
const routeSource = readFileSync("src/app/api/v1/watchlists/[watchlistId]/route.ts", "utf8");
const storeSource = readFileSync("src/app/platform/watchlists.server.ts", "utf8");

test("watchlist rename is exposed as a localized, controlled dialog", () => {
  assert.match(pageSource, /t\("watchlist\.rename"\)/);
  assert.match(pageSource, /setAppDialog\("watchlist-rename"\)/);
  assert.match(pageSource, /value=\{renameWatchlistName\}/);
  assert.match(pageSource, /maxLength=\{60\}/);
  assert.match(pageSource, /renameWatchlistName\.trim\(\) === managedWatchlist\.name/);

  assert.equal(translate("en", "watchlist.rename"), "Rename watchlist");
  assert.equal(translate("ja", "watchlist.rename"), "ウォッチリスト名を変更");
  assert.equal(
    translate("en", "watchlist.renameSuccess", { name: "Momentum" }),
    "Renamed the watchlist to “Momentum”.",
  );
  assert.equal(
    translate("ja", "watchlist.renameSuccess", { name: "モメンタム" }),
    "ウォッチリスト名を「モメンタム」に変更しました。",
  );
});

test("watchlist rename is confirmed by the D1-backed PATCH response before updating UI state", () => {
  assert.match(pageSource, /\/api\/v1\/watchlists\/\$\{encodeURIComponent\(managedWatchlist\.id\)\}/);
  assert.match(pageSource, /method: "PATCH"/);
  assert.match(pageSource, /watchlist\.id === payload\.watchlist\.id \? payload\.watchlist : watchlist/);
  assert.match(pageSource, /payload\.error\?\.code/);

  assert.match(routeSource, /export async function PATCH/);
  assert.match(routeSource, /normalizeWatchlistName\(payload\.name\)/);
  assert.match(routeSource, /renameWatchlist\(watchlistId/);
  assert.match(storeSource, /SET name = \?, version = version \+ 1, updated_at = \?/);
  assert.match(storeSource, /"watchlist\.renamed"/);
});
