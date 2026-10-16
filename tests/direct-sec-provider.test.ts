import assert from "node:assert/strict";
import test from "node:test";
import { getSecDataset } from "../api/direct-sources/sec.server";
import { DirectSourceError, type DirectSourceClientOptions } from "../api/direct-sources/client.server";

const CIK = "0000320193";
const SUBMISSIONS_URL = `https://data.sec.gov/submissions/CIK${CIK}.json`;
const FACTS_URL = `https://data.sec.gov/api/xbrl/companyfacts/CIK${CIK}.json`;
const ACCESSION = "0000320193-26-000010";
const environment = { SEC_EDGAR_USER_AGENT: "Trader tests test@example.com" };
const now = () => new Date("2026-09-06T00:00:00Z");

function submissions(entries = [{ accession: ACCESSION, filed: "2026-09-02", form: "4", document: "xslF345X05/form4.xml" }]) {
  return {
    cik: 320193, tickers: ["AAPL"], filings: { recent: {
      accessionNumber: entries.map(item => item.accession), filingDate: entries.map(item => item.filed),
      form: entries.map(item => item.form), primaryDocument: entries.map(item => item.document),
      acceptanceDateTime: entries.map(item => `${item.filed}T18:05:00Z`), reportDate: entries.map(() => "2026-08-31"),
    }, files: [{ name: "older-file.json" }] },
  };
}

function client(responses: Record<string, unknown>, requests: string[] = []): DirectSourceClientOptions {
  return { environment, now, fetch: async (input, init) => {
    const url = String(input); requests.push(url);
    assert.equal(new Headers(init?.headers).get("user-agent"), environment.SEC_EDGAR_USER_AGENT);
    assert.ok(init?.signal);
    if (!(url in responses)) throw new Error("Unexpected network URL");
    const payload = responses[url];
    if (payload instanceof Response) return payload.clone();
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload));
  } };
}

function archive(accession = ACCESSION, file = "form4.xml") {
  return `https://www.sec.gov/Archives/edgar/data/320193/${accession.replaceAll("-", "")}/${file}`;
}

function xml(transaction = `
  <nonDerivativeTransaction>
    <securityTitle><value>Common Stock</value></securityTitle>
    <transactionDate><value>2026-08-31</value></transactionDate>
    <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
    <transactionAmounts><transactionShares><value>10.5</value></transactionShares>
      <transactionPricePerShare><value>123.4</value></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
  </nonDerivativeTransaction>`, issuerCik = CIK) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <ownershipDocument xmlns="http://www.sec.gov/ownership">
      <documentType>4</documentType><issuer><issuerCik>${issuerCik}</issuerCik><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer>
      <reportingOwner><reportingOwnerId><rptOwnerName>Jane &amp; Partners</rptOwnerName></reportingOwnerId></reportingOwner>
      <reportingOwner><reportingOwnerId><rptOwnerName>Joint Owner</rptOwnerName></reportingOwnerId></reportingOwner>
      <nonDerivativeTable>${transaction}</nonDerivativeTable>
      <derivativeTable><derivativeTransaction><transactionShares><value>999</value></transactionShares></derivativeTransaction></derivativeTable>
    </ownershipDocument>`;
}

test("SEC requires a configured contact identity and refuses malformed symbol, CIK and dates", async () => {
  await assert.rejects(getSecDataset("sec-filings", { symbol: "AAPL" }, { environment: {} }), (error: unknown) => error instanceof DirectSourceError && error.code === "configuration_required");
  for (const query of [{ cik: "../320193" }, { symbol: "AAPL/path" }, {}, { cik: CIK, date: "2026-02-30" }]) {
    const requests: string[] = [];
    await assert.rejects(getSecDataset("sec-filings", query, client({}, requests)), (error: unknown) => error instanceof DirectSourceError && error.code === "invalid_request");
    assert.deepEqual(requests, []);
  }
});

test("SEC filing index validates issuer linkage, dates and the fixed archive path", async () => {
  const requests: string[] = [];
  const result = await getSecDataset("sec-filings", { symbol: "AAPL", cik: CIK, date: "2026-09-02" }, client({
    "https://www.sec.gov/files/company_tickers.json": { "0": { cik_str: 320193, ticker: "AAPL" } },
    [SUBMISSIONS_URL]: submissions([
      { accession: "0000320193-26-000011", filed: "2026-09-03", form: "10-Q", document: "newer.htm" },
      { accession: ACCESSION, filed: "2026-09-02", form: "SC 13G/A", document: "../../bad.xml" },
    ]),
  }, requests));
  assert.equal(requests.length, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].form, "SC 13G/A");
  assert.equal(result.rows[0].period, "2026-08-31");
  assert.equal(result.rows[0].filed, "2026-09-02");
  assert.equal(result.rows[0].accepted, "2026-09-02T18:05:00Z");
  assert.equal(result.rows[0].url, archive(ACCESSION, `${ACCESSION}-index.html`));
  assert.equal(result.fetchedAt, now().toISOString());
  assert.equal(result.coverage.status, "partial");
  assert.match(result.notes.join(" "), /does not contain parsed ownership/);
});

test("SEC refuses ticker/CIK mismatch before fetching another issuer", async () => {
  const requests: string[] = [];
  await assert.rejects(getSecDataset("sec-filings", { symbol: "AAPL", cik: "789019" }, client({
    "https://www.sec.gov/files/company_tickers.json": { "0": { cik_str: 320193, ticker: "AAPL" } },
  }, requests)), (error: unknown) => error instanceof DirectSourceError && error.code === "invalid_request");
  assert.equal(requests.length, 1);
});

test("SEC independently checks the returned submission CIK and ticker", async () => {
  await assert.rejects(getSecDataset("sec-filings", { cik: CIK }, client({
    [SUBMISSIONS_URL]: { ...submissions(), cik: 789019 },
  })), (error: unknown) => error instanceof DirectSourceError && error.code === "invalid_response");
  await assert.rejects(getSecDataset("sec-filings", { symbol: "AAPL" }, client({
    "https://www.sec.gov/files/company_tickers.json": { "0": { cik_str: 320193, ticker: "AAPL" } },
    [SUBMISSIONS_URL]: { ...submissions(), tickers: ["MSFT"] },
  })), (error: unknown) => error instanceof DirectSourceError && error.code === "invalid_response");
});

test("SEC facts keep reported units, filing dates and restated observations separate", async () => {
  const observation = { start: "2026-01-01", end: "2026-03-31", filed: "2026-05-01", accn: ACCESSION, val: 100, form: "10-Q", fp: "Q2" };
  const result = await getSecDataset("sec-facts", { cik: CIK, date: "2026-06-01" }, client({
    [SUBMISSIONS_URL]: submissions(),
    [FACTS_URL]: { cik: 320193, facts: { "us-gaap": {
      Revenues: { units: { USD: [observation, { ...observation }, { ...observation, filed: "2026-05-15", accn: "0000320193-26-000012", val: 101 }, { ...observation, filed: "2026-09-01", val: 102 }], EUR: [{ ...observation, val: 999 }] } },
      EarningsPerShareDiluted: { units: { "USD/shares": [{ ...observation, val: 1.5 }], USD: [{ ...observation, val: 888 }] } },
      Assets: { units: { USD: [{ ...observation, end: "2026-02-30" }, { ...observation, val: "100" }, { ...observation, end: "2027-01-01" }] } },
    } } },
  }));
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.filter(row => row.concept === "Revenues").map(row => row.value), [101, 100]);
  assert.equal(result.rows.find(row => row.concept === "EarningsPerShareDiluted")?.unit, "USD/shares");
  assert.equal(result.rows[0].end, "2026-03-31");
  assert.equal(result.rows[0].filed, "2026-05-15");
  assert.match(result.coverage.note, /3 invalid/);
  assert.match(result.notes.join(" "), /Restatements/);
});

test("SEC companyfacts rejects a mismatched CIK and does not invent missing GAAP data", async () => {
  await assert.rejects(getSecDataset("sec-facts", { cik: CIK }, client({ [SUBMISSIONS_URL]: submissions(), [FACTS_URL]: { cik: 789019, facts: {} } })), (error: unknown) => error instanceof DirectSourceError && error.code === "invalid_response");
  const result = await getSecDataset("sec-facts", { cik: CIK }, client({ [SUBMISSIONS_URL]: submissions(), [FACTS_URL]: { cik: 320193, facts: { "ifrs-full": {} } } }));
  assert.equal(result.coverage.status, "empty");
  assert.deepEqual(result.rows, []);
});

test("SEC Form 4 parses actual transactions and joint owners without duplicate trades", async () => {
  const requests: string[] = [];
  const result = await getSecDataset("sec-insiders", { cik: CIK }, client({ [SUBMISSIONS_URL]: submissions(), [archive()]: xml() }, requests));
  assert.deepEqual(requests, [SUBMISSIONS_URL, archive()]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].owner, "Jane & Partners; Joint Owner");
  assert.equal(result.rows[0].shares, 10.5);
  assert.equal(result.rows[0].price, 123.4);
  assert.equal(result.rows[0].transactionDate, "2026-08-31");
  assert.equal(result.rows[0].filed, "2026-09-02");
  assert.equal(result.rows[0].code, "P");
  assert.equal(result.rows[0].url, archive());
  assert.match(result.notes.join(" "), /derivative transactions.*excluded/);
});

test("SEC Form 4 keeps absent prices null and award codes distinct from purchases", async () => {
  const award = xml().replace("<transactionCode>P</transactionCode>", "<transactionCode>A</transactionCode>").replace("<value>123.4</value>", "");
  const result = await getSecDataset("sec-insiders", { cik: CIK }, client({ [SUBMISSIONS_URL]: submissions(), [archive()]: award }));
  assert.equal(result.rows[0].price, null);
  assert.equal(result.rows[0].code, "A");
});

test("SEC Form 4 reports individual malformed or mismatched documents as partial failures", async () => {
  const secondAccession = "0000320193-26-000009";
  const result = await getSecDataset("sec-insiders", { cik: CIK }, client({
    [SUBMISSIONS_URL]: submissions([
      { accession: ACCESSION, filed: "2026-09-02", form: "4", document: "form4.xml" },
      { accession: secondAccession, filed: "2026-09-01", form: "4", document: "form4.xml" },
    ]), [archive()]: xml(), [archive(secondAccession)]: xml(undefined, "789019"),
  }));
  assert.equal(result.rows.length, 1);
  assert.equal(result.coverage.status, "partial");
  assert.match(result.coverage.note, /1 documents unavailable/);
});

test("SEC Form 4 refuses external XML entities and surfaces total document failure", async () => {
  await assert.rejects(getSecDataset("sec-insiders", { cik: CIK }, client({
    [SUBMISSIONS_URL]: submissions(), [archive()]: `<!DOCTYPE ownershipDocument [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${xml()}`,
  })), (error: unknown) => error instanceof DirectSourceError && error.code === "unavailable");
});

test("SEC limits Form 4 fetches to four documents", async () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({ accession: `0000320193-26-${String(index + 1).padStart(6, "0")}`, filed: "2026-09-02", form: "4", document: "form4.xml" }));
  const requests: string[] = [];
  const responses = Object.fromEntries(entries.map(item => [archive(item.accession), xml()]));
  const result = await getSecDataset("sec-insiders", { cik: CIK }, client({ [SUBMISSIONS_URL]: submissions(entries), ...responses }, requests));
  assert.equal(requests.length, 5);
  assert.equal(result.rows.length, 4);
  assert.match(result.coverage.note, /maximum 4/);
});

test("SEC cancellation prevents network requests even while rate limited", async () => {
  const controller = new AbortController(); controller.abort();
  const requests: string[] = [];
  await assert.rejects(getSecDataset("sec-filings", { cik: CIK }, { ...client({}, requests), signal: controller.signal }), DirectSourceError);
  assert.deepEqual(requests, []);
});
