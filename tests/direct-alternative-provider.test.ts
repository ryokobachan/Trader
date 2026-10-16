import assert from "node:assert/strict";
import test from "node:test";
import { getAlternativeDataset, parseFinraShortVolume, parseUsaspendingAwards } from "../api/direct-sources/alternative.server";
import { DirectSourceError } from "../api/direct-sources/client.server";

const NOW = new Date("2026-09-06T10:00:00Z");
const HEADER = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market";
const row = "20260904|AAPL|120.125000|20|200.500000|B,Q,N";
const daily = (rows: string[] = [row]) => `${HEADER}\n${rows.join("\n")}${rows.length ? "\n" : ""}${rows.length}\n`;
const errorCode = (code: string) => (error: unknown) => error instanceof DirectSourceError && error.code === code;
const award = (patch: Record<string, unknown> = {}) => ({
  internal_id: 291057808, "Award ID": "693KA824C00005", "Recipient Name": "ZETA ASSOCIATES INC", "Recipient UEI": "FHLPHFQBMDX9",
  "Award Amount": 11247561.69, "Awarding Agency": "Department of Transportation", "Start Date": "2024-04-29",
  "Last Modified Date": "2026-09-03 15:21:48", generated_internal_id: "CONT_AWD_693KA824C00005_6920_-NONE-_-NONE-", ...patch,
});
const awards = (results: unknown[] = [award()], hasNext = false) => ({ spending_level: "awards", limit: 50, results, page_metadata: { page: 1, hasNext } });

test("USAspending uses an authenticated Trader transport fallback without exposing its token", async () => {
  const calls: string[] = [];
  const result = await getAlternativeDataset("usaspending", { recipient: "LOCKHEED MARTIN" }, {
    now: () => NOW,
    environment: { TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791", TRADER_TRADINGVIEW_SIDECAR_TOKEN: "private-sidecar-token" },
    fetch: async (input, options) => {
      const url = String(input); calls.push(url);
      if (url.startsWith("https://api.usaspending.gov/")) {
        assert.equal(new Headers(options?.headers).get("authorization"), null);
        throw new Error("workerd transport failure");
      }
      assert.equal(url, "http://127.0.0.1:8791/v1/research/usaspending");
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer private-sidecar-token");
      assert.deepEqual(JSON.parse(String(options?.body)), { recipient: "LOCKHEED MARTIN", endDate: "2026-09-06" });
      return Response.json({ schemaVersion: "trader.usaspending.v1", recipient: "LOCKHEED MARTIN", endDate: "2026-09-06", payload: awards() });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(JSON.stringify(result).includes("private-sidecar-token"), false);
});

test("USAspending refuses unsafe helper URLs and mismatched helper response identity", async () => {
  for (const base of ["http://untrusted.example", "https://user:pass@example.com", "https://example.com/other", "https://example.com/?token=secret"]) {
    let calls = 0;
    await assert.rejects(getAlternativeDataset("usaspending", { recipient: "LOCKHEED MARTIN" }, {
      now: () => NOW, environment: { TRADER_TRADINGVIEW_SIDECAR_URL: base, TRADER_TRADINGVIEW_SIDECAR_TOKEN: "secret" },
      fetch: async () => { calls++; throw new Error("offline"); },
    }), errorCode("unavailable"));
    assert.equal(calls, 1);
  }
  await assert.rejects(getAlternativeDataset("usaspending", { recipient: "LOCKHEED MARTIN" }, {
    now: () => NOW, environment: { TRADER_TRADINGVIEW_SIDECAR_URL: "http://127.0.0.1:8791", TRADER_TRADINGVIEW_SIDECAR_TOKEN: "secret" },
    fetch: async input => {
      if (String(input).startsWith("https://api.usaspending.gov/")) throw new Error("offline");
      return Response.json({ schemaVersion: "trader.usaspending.v1", recipient: "DIFFERENT COMPANY", endDate: "2026-09-06", payload: awards() });
    },
  }), errorCode("invalid_response"));
});

test("FINRA preserves fractional shares and does not double-count exempt volume", () => {
  const rows = parseFinraShortVolume(daily(), "AAPL", "2026-09-04");
  assert.equal(rows[0].shortVolume, 120.125);
  assert.equal(rows[0].shortExemptVolume, 20);
  assert.equal(rows[0].totalVolume, 200.5);
  assert.equal(rows[0].shortVolumeRatio, 120.125 / 200.5);
});

test("FINRA exact symbol/date filtering distinguishes no row and zero denominator", () => {
  assert.deepEqual(parseFinraShortVolume(daily(), "MSFT", "2026-09-04"), []);
  assert.deepEqual(parseFinraShortVolume(daily([]), "AAPL", "2026-09-04"), []);
  assert.equal(parseFinraShortVolume(daily(["20260904|AAPL|0|0|0|Q"]), "AAPL", "2026-09-04")[0].shortVolumeRatio, null);
});

test("FINRA fails closed for a wrong day, damaged trailer/schema, duplicates and impossible volumes", () => {
  const malformed = [
    daily().replace("20260904", "20260903"), daily().replace(/1\n$/, "2\n"), daily([row, row]),
    daily([row.replace("|120.125000|20|", "|NaN|20|")]),
    daily([row.replace("|120.125000|20|", "|1e2|20|")]),
    daily([row.replace("|120.125000|20|", "|201|20|")]),
    daily([row.replace("|120.125000|20|", "|10|20|")]),
    daily([row.replace("|120.125000|20|", "|-1|0|")]),
    daily([row.replace("|B,Q,N", "|Q,Q")]), daily([row.replace("|B,Q,N", "|<script>")]),
    daily().replace("ShortExemptVolume", "Exempt"), "<html>unavailable</html>",
    daily([row, "20260903|MSFT|10|0|20|Q"]),
  ];
  for (const body of malformed) assert.throws(() => parseFinraShortVolume(body, "AAPL", "2026-09-04"), errorCode("invalid_response"));
});

test("FINRA requests only the precise consolidated file and reports partial off-exchange coverage", async () => {
  let called = 0;
  const result = await getAlternativeDataset("finra-short-volume", { symbol: "aapl", date: "2026-09-04" }, {
    now: () => NOW, fetch: async (url) => {
      called += 1;
      assert.equal(String(url), "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20260904.txt");
      return new Response(daily());
    },
  });
  assert.equal(called, 1);
  assert.equal(result.coverage.status, "partial");
  assert.equal(result.fetchedAt, NOW.toISOString());
  assert.equal(result.rows[0].symbol, "AAPL");
  assert.match(result.notes.join(" "), /not outstanding short interest/);
});

test("FINRA rejects invalid query dates and symbols before network access", async () => {
  const fetcher = async () => { assert.fail("must not request invalid input"); return new Response(); };
  for (const query of [
    { symbol: "AAPL" }, { symbol: "AAPL", date: "2026-02-30" }, { symbol: "AAPL", date: "2026-09-07" },
    { symbol: "AAPL", date: "2010-01-01" }, { symbol: "../AAPL", date: "2026-09-04" },
  ]) await assert.rejects(getAlternativeDataset("finra-short-volume", query, { now: () => NOW, fetch: fetcher }), errorCode("invalid_request"));
});

test("FINRA network/schema failures remain errors rather than zero-filled results", async () => {
  await assert.rejects(getAlternativeDataset("finra-short-volume", { symbol: "AAPL", date: "2026-09-04" }, {
    now: () => NOW, fetch: async () => new Response("missing", { status: 404 }),
  }), errorCode("unavailable"));
  await assert.rejects(getAlternativeDataset("finra-short-volume", { symbol: "AAPL", date: "2026-09-04" }, {
    now: () => NOW, fetch: async () => new Response("<html>blocked</html>"),
  }), errorCode("invalid_response"));
});

test("USAspending parses actual recipient/amount/date shape with a fixed official link", () => {
  const result = parseUsaspendingAwards(awards());
  assert.equal(result.rows[0].recipient, "ZETA ASSOCIATES INC");
  assert.equal(result.rows[0].amount, 11247561.69);
  assert.equal(result.rows[0].modifiedDate, "2026-09-03");
  assert.equal(result.rows[0].startDate, "2024-04-29");
  assert.equal(result.rows[0].url, "https://www.usaspending.gov/award/CONT_AWD_693KA824C00005_6920_-NONE-_-NONE-/");
});

test("USAspending preserves null, zero and negative obligations independently", () => {
  for (const amount of [null, 0, -51.25]) {
    const parsed = parseUsaspendingAwards(awards([award({ "Award Amount": amount, "Start Date": null, "Last Modified Date": null, "Recipient UEI": null, "Awarding Agency": null })]));
    assert.equal(parsed.rows[0].amount, amount);
    assert.equal(parsed.rows[0].startDate, null);
    assert.equal(parsed.rows[0].modifiedDate, null);
  }
});

test("USAspending rejects malformed optional values, untrusted URLs and duplicate identity", () => {
  for (const patch of [
    { "Award Amount": "0" }, { "Award Amount": false }, { "Award Amount": Infinity },
    { "Award Amount": Number.MAX_SAFE_INTEGER + 1 }, { "Start Date": "2026-02-30" },
    { "Last Modified Date": "2026-09-03 29:10:00" }, { "Recipient UEI": "<script>" },
    { generated_internal_id: "https://attacker.example/award" }, { generated_internal_id: "CONT_AWD_x/../../bad" },
    { "Recipient Name": "" },
  ]) assert.throws(() => parseUsaspendingAwards(awards([award(patch)])), errorCode("invalid_response"));
  const parsed = parseUsaspendingAwards(awards([award(), award(), null]));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rejected, 2);
});

test("USAspending checks pagination and awards schema, while valid empty stays empty", () => {
  assert.deepEqual(parseUsaspendingAwards(awards([])).rows, []);
  for (const payload of [{}, [], { ...awards(), spending_level: "subawards" }, { ...awards(), page_metadata: null },
    { ...awards(), page_metadata: { page: 1, hasNext: "false" } }, awards(Array(51).fill(award()))]) {
    assert.throws(() => parseUsaspendingAwards(payload), errorCode("invalid_response"));
  }
});

test("USAspending uses explicit recipient search and bounded contracts without ticker inference or sums", async () => {
  const result = await getAlternativeDataset("usaspending", { recipient: "LOCKHEED MARTIN", symbol: "LMT" }, {
    now: () => NOW, fetch: async (url, init) => {
      assert.equal(String(url), "https://api.usaspending.gov/api/v2/search/spending_by_award/");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.filters.recipient_search_text, ["LOCKHEED MARTIN"]);
      assert.deepEqual(body.filters.award_type_codes, ["A", "B", "C", "D"]);
      assert.deepEqual(body.filters.time_period, [{ start_date: "2025-09-06", end_date: "2026-09-06" }]);
      assert.equal(body.limit, 50);
      assert.equal(body.page, 1);
      assert.equal(body.sort, "Last Modified Date");
      assert.equal(body.subawards, false);
      assert.ok(!JSON.stringify(body).includes("LMT"));
      return Response.json(awards([award(), null], true));
    },
  });
  assert.equal(result.rows[0].recipient, "ZETA ASSOCIATES INC");
  assert.equal(result.coverage.status, "partial");
  assert.match(result.coverage.note, /More matching awards/);
  assert.match(result.coverage.note, /1 malformed/);
  assert.match(result.notes.join(" "), /not new spending/);
  assert.equal(result.rows[0].symbol, undefined);
});

test("USAspending requires recipient text and does not treat symbol-only search as a company identity", async () => {
  await assert.rejects(getAlternativeDataset("usaspending", { symbol: "LMT" }, { now: () => NOW }), errorCode("invalid_request"));
  await assert.rejects(getAlternativeDataset("usaspending", { recipient: "x\nsecret" }, { now: () => NOW }), errorCode("invalid_request"));
  await assert.rejects(getAlternativeDataset("usaspending", { recipient: "ACME", date: "2026-02-30" }, { now: () => NOW }), errorCode("invalid_request"));
});
