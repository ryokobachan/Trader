import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../src/app/api/v1/symbols/[symbol]/analyst-ratings/route";

type ErrorBody = { error: { code: string } };

function context(symbol = "MU") {
  return { params: Promise.resolve({ symbol }) };
}

test("analyst-ratings route rejects malformed date ranges before provider access", async () => {
  const response = await GET(
    new Request("http://localhost/api/v1/symbols/MU/analyst-ratings?date_from=2026-07-11&date_to=2024-01-01"),
    context(),
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as ErrorBody).error.code, "invalid_date_range");
});

test("analyst-ratings route accepts Midas query names and validates the path ticker", async () => {
  const response = await GET(
    new Request("http://localhost/api/v1/symbols/MU/analyst-ratings?parameters%5Bdate_from%5D=2024-01-01&parameters%5Bdate_to%5D=2026-07-11&parameters%5Btickers%5D=AAPL&pagesize=1000"),
    context(),
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as ErrorBody).error.code, "ticker_mismatch");
});

test("analyst-ratings route bounds the upstream page size", async () => {
  const response = await GET(
    new Request("http://localhost/api/v1/symbols/MU/analyst-ratings?date_from=2024-01-01&date_to=2026-07-11&pagesize=1001"),
    context(),
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as ErrorBody).error.code, "invalid_pagesize");
});

test("analyst-ratings route rejects malformed fresh controls", async () => {
  const response = await GET(
    new Request("http://localhost/api/v1/symbols/MU/analyst-ratings?fresh=0"),
    context(),
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as ErrorBody).error.code, "invalid_fresh");
});
