import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GET as getStrategyTransactions } from "../src/app/api/v1/strategy-portfolios/[strategyId]/transactions/route";
import { GET as getStrategyPreferences } from "../src/app/api/v1/strategy-preferences/route";
import { POST as getAfterHours } from "../src/app/api/v1/watchlists/after-hours/route";
import { POST as getWatchlistQuotes } from "../src/app/api/v1/watchlists/quotes/route";
import { GET as getWatchlists } from "../src/app/api/v1/watchlists/route";
import {
  RequestOwnerError,
  requestOwnerId,
} from "../src/app/platform/request-owner.server";
import { DEFAULT_LOCAL_OWNER_ID } from "../src/app/platform/watchlist-contracts";
import { installD1Binding } from "../src/db";

const AUTHENTICATED_USER_ID_HEADER = "oai-authenticated-user-id";

function publicRequest(path: string, userId?: string): Request {
  return new Request(`https://unicorn.example${path}`, {
    ...(userId === undefined
      ? {}
      : { headers: { [AUTHENTICATED_USER_ID_HEADER]: userId } }),
  });
}

test("uses the stable Sites user ID and limits the shared local owner to loopback", () => {
  assert.equal(
    requestOwnerId(publicRequest("/api/v1/watchlists", "site-user-123")),
    "site-user-123",
  );
  assert.equal(
    requestOwnerId(new Request("http://localhost:3001/api/v1/watchlists")),
    DEFAULT_LOCAL_OWNER_ID,
  );
  assert.equal(
    requestOwnerId(new Request("http://127.0.0.1:3001/api/v1/watchlists")),
    DEFAULT_LOCAL_OWNER_ID,
  );
  assert.throws(
    () => requestOwnerId(publicRequest("/api/v1/watchlists")),
    RequestOwnerError,
  );
  assert.throws(
    () => requestOwnerId(publicRequest("/api/v1/watchlists", " ")),
    RequestOwnerError,
  );
});

test("all persisted API families fail closed before touching D1", async () => {
  installD1Binding(undefined);
  const responses = await Promise.all([
    getWatchlists(publicRequest("/api/v1/watchlists")),
    getStrategyPreferences(publicRequest("/api/v1/strategy-preferences")),
    getStrategyTransactions(
      publicRequest("/api/v1/strategy-portfolios/sample.rsi-14-mean-reversion.v1/transactions"),
      { params: Promise.resolve({ strategyId: "sample.rsi-14-mean-reversion.v1" }) },
    ),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "authentication_required",
    );
  }
});

test("watchlist provider proxy routes also reject anonymous public requests before parsing", async () => {
  const [quotes, afterHours] = await Promise.all([
    getWatchlistQuotes(publicRequest("/api/v1/watchlists/quotes")),
    getAfterHours(publicRequest("/api/v1/watchlists/after-hours")),
  ]);
  assert.equal(quotes.status, 401);
  assert.equal(afterHours.status, 401);
});

test("every persisted route resolves ownership and watchlist provider proxies enforce the same identity gate", () => {
  const routeFiles = [
    "src/app/api/v1/watchlists/route.ts",
    "src/app/api/v1/watchlists/[watchlistId]/route.ts",
    "src/app/api/v1/watchlists/[watchlistId]/items/route.ts",
    "src/app/api/v1/watchlists/[watchlistId]/items/[itemId]/route.ts",
    "src/app/api/v1/watchlists/[watchlistId]/items/reorder/route.ts",
    "src/app/api/v1/watchlists/quotes/route.ts",
    "src/app/api/v1/watchlists/after-hours/route.ts",
    "src/app/api/v1/strategy-preferences/route.ts",
    "src/app/api/v1/strategy-preferences/[strategyId]/route.ts",
    "src/app/api/v1/strategy-portfolios/[strategyId]/transactions/route.ts",
  ];
  for (const routeFile of routeFiles) {
    assert.match(
      readFileSync(routeFile, "utf8"),
      /requestOwnerId\(request\)/,
      `${routeFile} must resolve an owner or enforce the same identity gate`,
    );
  }
});
