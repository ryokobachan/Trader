import type { DirectSourceColumn, DirectSourceDataset, DirectSourceQuery } from "../../src/app/platform/direct-source-contracts";
import { cachedSource, DirectSourceError, fetchSourceJson, fetchSourceText, type DirectSourceClientOptions } from "./client.server";

type SecSourceId = "sec-filings" | "sec-facts" | "sec-insiders";
type RecordValue = Record<string, unknown>;
type DatasetRow = Readonly<Record<string, string | number | null>>;
type SecFiling = { accession: string; filed: string; accepted: string | null; period: string | null; form: string; document: string | null };
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_API = "https://data.sec.gov";
const CACHE_MS = 300_000;
const MAX_FILINGS = 100;
const MAX_FORM4_DOCUMENTS = 4;
const MAX_FORM4_ROWS = 200;
const MAX_FACT_ROWS = 300;
const SEC_INTERVAL_MS = 500;
const MAX_QUEUED_REQUESTS = 20;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();
let queuedRequests = 0;

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function cikFor(value: unknown): string | null {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^\d{1,10}$/.test(text) && Number(text) > 0 ? text.padStart(10, "0") : null;
}

function symbolFor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const symbol = value.trim().toUpperCase().replaceAll(".", "-");
  return /^[A-Z][A-Z0-9-]{0,14}$/.test(symbol) ? symbol : null;
}

function configuredOptions(options: DirectSourceClientOptions): DirectSourceClientOptions & { headers: Record<string, string> } {
  const environment = options.environment ?? process.env;
  const agent = (environment.SEC_EDGAR_USER_AGENT ?? environment.SEC_USER_AGENT)?.trim();
  if (!agent || agent.length > 256 || /[\u0000-\u001f\u007f]/.test(agent) || !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(agent)) {
    throw new DirectSourceError("configuration_required", "Set SEC_EDGAR_USER_AGENT to an application name and contact email.");
  }
  return { ...options, headers: { "User-Agent": agent, Accept: "application/json, application/xml, text/xml" } };
}

/** One process-wide start gate, including concurrent requests for different SEC datasets. */
async function secTurn(signal?: AbortSignal): Promise<void> {
  if (queuedRequests >= MAX_QUEUED_REQUESTS) throw new DirectSourceError("capacity");
  queuedRequests += 1;
  const turn = queue.then(async () => {
    if (signal?.aborted) throw new DirectSourceError("unavailable");
    const delay = Math.max(0, lastRequestAt + SEC_INTERVAL_MS - Date.now());
    if (delay) await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(new DirectSourceError("unavailable")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, delay);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    if (signal?.aborted) throw new DirectSourceError("unavailable");
    lastRequestAt = Date.now();
  });
  queue = turn.catch(() => {});
  try { await turn; } finally { queuedRequests -= 1; }
}

async function secJson(url: string, options: ReturnType<typeof configuredOptions>): Promise<unknown> {
  await secTurn(options.signal);
  return fetchSourceJson(url, { ...options, maxBytes: 20_000_000 });
}

function filingUrl(cik: string, accession: string, document?: string | null): string {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/`;
  return `${base}${document ?? `${accession}-index.html`}`;
}

function documentPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  // A known SEC XSL display directory is removed to obtain the original ownership XML.
  const document = value.replace(/^xsl[A-Za-z0-9_-]+\//, "");
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:xml|htm|html|txt)$/i.test(document) && !document.includes("..") ? document : null;
}

function recentFilings(submissions: RecordValue): SecFiling[] {
  const recent = object(object(submissions.filings)?.recent);
  if (!recent || !Array.isArray(recent.accessionNumber) || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) {
    throw new DirectSourceError("invalid_response");
  }
  const length = recent.accessionNumber.length;
  if (length > 30_000 || recent.form.length !== length || recent.filingDate.length !== length) throw new DirectSourceError("invalid_response");
  const values = (field: string, index: number) => Array.isArray(recent[field]) ? recent[field][index] : undefined;
  const seen = new Set<string>();
  const result: SecFiling[] = [];
  for (let index = 0; index < length; index += 1) {
    const accession = recent.accessionNumber[index];
    const filed = validDate(recent.filingDate[index]);
    const form = recent.form[index];
    if (typeof accession !== "string" || !ACCESSION.test(accession) || !filed || typeof form !== "string" || !/^[A-Z0-9 /-]{1,30}$/.test(form)) {
      throw new DirectSourceError("invalid_response");
    }
    if (seen.has(accession)) continue;
    seen.add(accession);
    const accepted = values("acceptanceDateTime", index);
    const acceptedText = typeof accepted === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(accepted)
      && Number.isFinite(Date.parse(accepted)) ? accepted : null;
    result.push({ accession, filed, form, accepted: acceptedText, period: validDate(values("reportDate", index)), document: documentPath(values("primaryDocument", index)) });
  }
  return result.sort((a, b) => b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession));
}

async function resolveCompany(query: DirectSourceQuery, options: ReturnType<typeof configuredOptions>) {
  const symbol = query.symbol?.trim() ? symbolFor(query.symbol) : null;
  const suppliedCik = query.cik?.trim() ? cikFor(query.cik) : null;
  if ((query.symbol?.trim() && !symbol) || (query.cik?.trim() && !suppliedCik) || (!symbol && !suppliedCik)) throw new DirectSourceError("invalid_request");
  let cik = suppliedCik;
  if (symbol) {
    const tickers = object(await secJson(TICKERS_URL, options));
    if (!tickers) throw new DirectSourceError("invalid_response");
    const matches = new Set(Object.values(tickers).flatMap((entry) => {
      const item = object(entry);
      const matched = symbolFor(item?.ticker) === symbol ? cikFor(item?.cik_str) : null;
      return matched ? [matched] : [];
    }));
    if (matches.size !== 1) throw new DirectSourceError("invalid_request", "The ticker could not be matched uniquely to a SEC issuer. Supply a CIK instead.");
    const resolved = [...matches][0];
    if (cik && resolved !== cik) throw new DirectSourceError("invalid_request", "The ticker and CIK identify different issuers.");
    cik = resolved;
  }
  if (!cik) throw new DirectSourceError("invalid_request");
  const url = `${SEC_API}/submissions/CIK${cik}.json`;
  const submissions = object(await secJson(url, options));
  if (!submissions || cikFor(submissions.cik) !== cik) throw new DirectSourceError("invalid_response");
  if (symbol && (!Array.isArray(submissions.tickers) || !submissions.tickers.some(value => symbolFor(value) === symbol))) {
    throw new DirectSourceError("invalid_response", "SEC submissions do not confirm the requested issuer ticker.");
  }
  return { cik, symbol, submissions, url };
}

const FILING_COLUMNS: readonly DirectSourceColumn[] = [
  { key: "form", label: "Form", labelJa: "様式" },
  { key: "filed", label: "Filed", labelJa: "提出日", format: "date" },
  { key: "accepted", label: "Accepted", labelJa: "受理日時" },
  { key: "period", label: "Reporting period end", labelJa: "報告期間末", format: "date" },
  { key: "accession", label: "Accession", labelJa: "提出番号" },
  { key: "url", label: "SEC filing", labelJa: "SEC原文", format: "url" },
];

/** Deliberately selected standard facts; USD amounts, shares and per-share values remain distinct. */
const FACT_CONCEPTS: Readonly<Record<string, string>> = {
  RevenueFromContractWithCustomerExcludingAssessedTax: "USD", Revenues: "USD", SalesRevenueNet: "USD",
  NetIncomeLoss: "USD", OperatingIncomeLoss: "USD", GrossProfit: "USD", Assets: "USD", Liabilities: "USD",
  StockholdersEquity: "USD", CashAndCashEquivalentsAtCarryingValue: "USD",
  NetCashProvidedByUsedInOperatingActivities: "USD", PaymentsToAcquirePropertyPlantAndEquipment: "USD",
  EarningsPerShareDiluted: "USD/shares", CommonStockSharesOutstanding: "shares",
};
const FACT_COLUMNS: readonly DirectSourceColumn[] = [
  { key: "concept", label: "SEC concept", labelJa: "SEC項目" },
  { key: "value", label: "Reported value", labelJa: "報告値", format: "number" },
  { key: "unit", label: "Unit", labelJa: "単位" },
  { key: "start", label: "Period start", labelJa: "期間開始", format: "date" },
  { key: "end", label: "Period end", labelJa: "期間末", format: "date" },
  { key: "filed", label: "Filed", labelJa: "提出日", format: "date" },
  { key: "form", label: "Form", labelJa: "様式" },
  { key: "fiscalPeriod", label: "Fiscal period", labelJa: "会計期間" },
  { key: "url", label: "SEC filing", labelJa: "SEC原文", format: "url" },
];

function factsRows(payload: unknown, cik: string, cutoff: string): { rows: DatasetRow[]; rejected: number; total: number } {
  const company = object(payload);
  if (!company || cikFor(company.cik) !== cik) throw new DirectSourceError("invalid_response");
  const facts = object(company.facts);
  if (!facts) throw new DirectSourceError("invalid_response");
  const gaap = object(facts["us-gaap"]);
  const result: DatasetRow[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const [concept, expectedUnit] of Object.entries(FACT_CONCEPTS)) {
    const metric = object(gaap?.[concept]);
    if (!metric) continue;
    const entries = object(metric.units)?.[expectedUnit];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const item = object(entry);
      const filed = validDate(item?.filed);
      const end = validDate(item?.end);
      const start = item?.start === undefined ? null : validDate(item.start);
      const accession = item?.accn;
      const value = item?.val;
      if (!filed || !end || (item?.start !== undefined && (!start || start > end)) || end > filed
        || typeof accession !== "string" || !ACCESSION.test(accession) || typeof value !== "number" || !Number.isFinite(value)
        || typeof item?.form !== "string" || !/^(10-[KQ]|20-F|40-F|6-K|8-K)(\/A)?$/.test(item.form)) { rejected += 1; continue; }
      if (filed > cutoff) continue;
      const identity = `${concept}|${expectedUnit}|${start}|${end}|${filed}|${accession}|${value}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push({ concept, value, unit: expectedUnit, start, end, filed, form: item.form, fiscalPeriod: typeof item.fp === "string" ? item.fp : null, accession, url: filingUrl(cik, accession) });
    }
  }
  result.sort((a, b) => String(b.filed).localeCompare(String(a.filed)) || String(b.end).localeCompare(String(a.end)) || String(a.concept).localeCompare(String(b.concept)));
  return { rows: result.slice(0, MAX_FACT_ROWS), rejected, total: result.length };
}

type XmlNode = { name: string; text: string; children: XmlNode[] };
function xmlText(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(value)) throw new DirectSourceError("invalid_response");
  return value.replace(/&([^;\s]{1,20});/g, (_whole, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity];
    const number = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isSafeInteger(number) || number <= 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) throw new DirectSourceError("invalid_response");
    return String.fromCodePoint(number);
  });
}

/** A bounded XML tokenizer with a real element stack; no DTDs, external entities or HTML recovery. */
function ownershipXml(xml: string): XmlNode {
  if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new DirectSourceError("invalid_response");
  const document: XmlNode = { name: "#document", text: "", children: [] };
  const stack = [document];
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
  let offset = 0;
  let count = 0;
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== offset || ++count > 30_000) throw new DirectSourceError("invalid_response");
    const token = match[0]; offset += token.length;
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) { stack.at(-1)!.text += token.slice(9, -3); continue; }
    if (token.startsWith("</")) {
      const closing = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(token)?.[1];
      if (!closing || stack.length <= 1 || stack.at(-1)!.name !== closing) throw new DirectSourceError("invalid_response");
      stack.pop(); continue;
    }
    if (token.startsWith("<")) {
      const opening = /^<([A-Za-z_][\w:.-]*)(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(\/?)>$/.exec(token);
      if (!opening || stack.length > 32) throw new DirectSourceError("invalid_response");
      const node: XmlNode = { name: opening[1], text: "", children: [] };
      stack.at(-1)!.children.push(node);
      if (!opening[2]) stack.push(node);
    } else {
      if (stack.length === 1 && token.trim()) throw new DirectSourceError("invalid_response");
      stack.at(-1)!.text += xmlText(token);
    }
  }
  if (offset !== xml.length || stack.length !== 1 || document.children.length !== 1 || document.children[0].name.split(":").at(-1) !== "ownershipDocument") throw new DirectSourceError("invalid_response");
  return document.children[0];
}

function children(node: XmlNode, name: string): XmlNode[] { return node.children.filter(child => child.name.split(":").at(-1) === name); }
function field(node: XmlNode, path: string): string {
  let current: XmlNode | undefined = node;
  for (const part of path.split("/")) current = current ? children(current, part)[0] : undefined;
  return current?.text.trim() ?? "";
}
function decimal(value: string): number | null {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function insiderRows(xml: string, filing: SecFiling, cik: string, requestedSymbol: string | null): { rows: DatasetRow[]; rejected: number } {
  const root = ownershipXml(xml);
  const issuer = children(root, "issuer")[0];
  if (!issuer || cikFor(field(issuer, "issuerCik")) !== cik || (requestedSymbol && symbolFor(field(issuer, "issuerTradingSymbol")) !== requestedSymbol)
    || !["4", "4/A"].includes(field(root, "documentType"))) throw new DirectSourceError("invalid_response");
  const owners = children(root, "reportingOwner").map(owner => field(owner, "reportingOwnerId/rptOwnerName")).filter(Boolean);
  if (!owners.length) throw new DirectSourceError("invalid_response");
  const transactions = children(root, "nonDerivativeTable").flatMap(table => children(table, "nonDerivativeTransaction"));
  const result: DatasetRow[] = [];
  let rejected = 0;
  for (const transaction of transactions) {
    const date = validDate(field(transaction, "transactionDate/value"));
    const code = field(transaction, "transactionCoding/transactionCode");
    const shares = decimal(field(transaction, "transactionAmounts/transactionShares/value"));
    const rawPrice = field(transaction, "transactionAmounts/transactionPricePerShare/value");
    const price = rawPrice ? decimal(rawPrice) : null;
    const acquiredDisposed = field(transaction, "transactionAmounts/transactionAcquiredDisposedCode/value");
    if (!date || date > filing.filed || !/^[A-Z]$/.test(code) || shares === null || (rawPrice && price === null) || !["A", "D"].includes(acquiredDisposed)) { rejected += 1; continue; }
    result.push({ owner: owners.join("; ").slice(0, 500), security: field(transaction, "securityTitle/value").slice(0, 200), transactionDate: date, code, acquiredDisposed, shares, price, filed: filing.filed, accepted: filing.accepted, form: filing.form, accession: filing.accession, url: filingUrl(cik, filing.accession, filing.document) });
  }
  return { rows: result, rejected };
}

const INSIDER_COLUMNS: readonly DirectSourceColumn[] = [
  { key: "owner", label: "Reporting owner", labelJa: "報告者" },
  { key: "security", label: "Security", labelJa: "証券" },
  { key: "transactionDate", label: "Transaction date", labelJa: "取引日", format: "date" },
  { key: "code", label: "Transaction code", labelJa: "取引コード" },
  { key: "acquiredDisposed", label: "Acquired / disposed", labelJa: "取得 A / 処分 D" },
  { key: "shares", label: "Shares", labelJa: "株数", format: "number" },
  { key: "price", label: "Reported price per share", labelJa: "報告単価", format: "number" },
  { key: "filed", label: "Filed", labelJa: "提出日", format: "date" },
  { key: "form", label: "Form", labelJa: "様式" },
  { key: "url", label: "SEC filing", labelJa: "SEC原文", format: "url" },
];

async function loadSecDataset(sourceId: SecSourceId, query: DirectSourceQuery, options: ReturnType<typeof configuredOptions>): Promise<DirectSourceDataset> {
  const cutoff = query.date === undefined || query.date === "" ? "9999-12-31" : validDate(query.date);
  if (!cutoff) throw new DirectSourceError("invalid_request");
  const company = await resolveCompany(query, options);
  const fetchedAt = (options.now?.() ?? new Date()).toISOString();
  const base = { sourceId, fetchedAt };
  if (sourceId === "sec-facts") {
    const sourceUrl = `${SEC_API}/api/xbrl/companyfacts/CIK${company.cik}.json`;
    const parsed = factsRows(await secJson(sourceUrl, options), company.cik, cutoff);
    if (!parsed.rows.length && parsed.rejected) throw new DirectSourceError("invalid_response");
    return { ...base, sourceName: "SEC EDGAR Companyfacts", sourceUrl, columns: FACT_COLUMNS, rows: parsed.rows,
      coverage: { status: parsed.rows.length ? "partial" : "empty", noteJa: `選択した米国会計基準の財務項目: ${parsed.total}件中、新しい${parsed.rows.length}件。検証できない${parsed.rejected}件を除外。`, note: `Selected US-GAAP concepts and their original units; newest ${parsed.rows.length} of ${parsed.total} matching observations. ${parsed.rejected} invalid observations excluded.` },
      notesJa: ["提出日と決算対象の期間末は異なります。日付指定は提出日に適用します。", "訂正や別の提出書類にある同期間の値も保持します。重複を調整した財務諸表ではありません。", "対象は選択した米国会計基準のUSD・USD/株・株数の項目です。IFRSのみ・外貨建ての企業は該当しない場合があります。", "SECから直接取得し、最大5分キャッシュします。提出日だけでは日中の情報利用可能時刻を確定できません。"],
      notes: ["Filed date is the source publication date, not the reporting period end. Date filtering uses the filed date.", "Restatements and repeated period values from distinct filings are preserved; these rows are not a normalized or deduplicated financial statement.", "Only selected USD, USD/shares and shares concepts are included. Foreign-currency and IFRS-only companies can have no matching facts.", "Read directly from SEC; cached for up to 5 minutes. Filing dates alone do not establish intraday point-in-time availability."] };
  }
  const filings = recentFilings(company.submissions).filter(filing => filing.filed <= cutoff);
  if (sourceId === "sec-filings") {
    const rows = filings.slice(0, MAX_FILINGS).map(filing => ({ form: filing.form, filed: filing.filed, accepted: filing.accepted, period: filing.period, accession: filing.accession, url: filingUrl(company.cik, filing.accession, filing.document) }));
    return { ...base, sourceName: "SEC EDGAR submissions", sourceUrl: company.url, columns: FILING_COLUMNS, rows,
      coverage: { status: rows.length ? "partial" : "empty", noteJa: `最近の提出一覧から条件に合う最新${rows.length}件。過去の追加ファイルは取得しません。`, note: `Newest ${rows.length} matching filings from the submissions.recent block. Older submissions files are not fetched.` },
      notesJa: ["提出書類の索引です。13D/G・13Fの行は、保有銘柄や保有比率の解析結果ではありません。", "日付指定は最近の一覧内で提出日の上限を指定します。過去の全件取得ではありません。", "SECから直接取得し、最大5分キャッシュします。"],
      notes: ["This is a filing index. A 13D/G or 13F entry does not contain parsed ownership positions.", "A date filter selects filings published on or before that date within the recent block only; it does not retrieve full historical coverage.", "Read directly from SEC; cached for up to 5 minutes."] };
  }
  const candidates = filings.filter(filing => filing.form === "4" || filing.form === "4/A");
  const selected = candidates.slice(0, MAX_FORM4_DOCUMENTS);
  const rows: DatasetRow[] = [];
  let failed = 0;
  let parsedDocuments = 0;
  let rejected = 0;
  for (const filing of selected) {
    if (!filing.document?.toLowerCase().endsWith(".xml")) { failed += 1; continue; }
    try {
      await secTurn(options.signal);
      const xml = await fetchSourceText(filingUrl(company.cik, filing.accession, filing.document), { ...options, maxBytes: 2_000_000 });
      const parsed = insiderRows(xml, filing, company.cik, company.symbol);
      rows.push(...parsed.rows); rejected += parsed.rejected; parsedDocuments += 1;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failed += 1;
    }
  }
  if (selected.length && !parsedDocuments) throw new DirectSourceError("unavailable", "The recent Form 4 documents could not be retrieved and validated.");
  rows.sort((a, b) => String(b.filed).localeCompare(String(a.filed)) || String(b.transactionDate).localeCompare(String(a.transactionDate)));
  return { ...base, sourceName: "SEC EDGAR Form 4", sourceUrl: company.url, columns: INSIDER_COLUMNS, rows: rows.slice(0, MAX_FORM4_ROWS),
    coverage: { status: rows.length || failed || rejected ? "partial" : "empty", noteJa: `最近のForm 4を${parsedDocuments}文書解析（最大${MAX_FORM4_DOCUMENTS}）。取得不可${failed}文書・不正${rejected}取引。解析した${rows.length}件中${Math.min(rows.length, MAX_FORM4_ROWS)}件を表示。`, note: `${parsedDocuments} recent Form 4 documents parsed (maximum ${MAX_FORM4_DOCUMENTS}); ${failed} documents unavailable; ${rejected} invalid transactions excluded. ${Math.min(rows.length, MAX_FORM4_ROWS)} of ${rows.length} parsed transactions shown.` },
    notesJa: ["原文XMLの非デリバティブ取引を表示します。デリバティブ・保有のみの記録・古い提出書類は対象外です。", "P/Sは市場または相対での購入/売却です。A/M/F/Gなどの別コードは通常の購入・売却と区別します。共同提出者の取引は1行にまとめます。", "取引日と提出日は別です。訂正報告は元の報告と突合していないため、完全な売買台帳として合計できません。", "価格の欠損は空欄。SECから直接取得し、最大5分キャッシュします。"],
    notes: ["Only non-derivative transactions from original ownership XML are shown; derivative transactions, holdings-only entries and older filings are excluded.", "P/S means an open-market or private purchase/sale; A/M/F/G and other codes also occur and are not treated as purchases or sales. Joint reporting owners share a single transaction row.", "Transaction date and SEC filing date are separate. Amendments are shown as filed, not reconciled against earlier filings; the result must not be summed as a complete trading ledger.", "Missing prices remain blank. Read directly from SEC; cached for up to 5 minutes."] };
}

export async function getSecDataset(sourceId: SecSourceId, query: DirectSourceQuery, options: DirectSourceClientOptions = {}): Promise<DirectSourceDataset> {
  if (!["sec-filings", "sec-facts", "sec-insiders"].includes(sourceId)) throw new DirectSourceError("invalid_request");
  if (options.signal?.aborted) throw new DirectSourceError("unavailable");
  const configured = configuredOptions(options);
  const load = async () => {
    const controller = new AbortController();
    let timedOut = false;
    const callerAbort = () => controller.abort();
    options.signal?.addEventListener("abort", callerAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 25_000);
    try { return await loadSecDataset(sourceId, query, { ...configured, signal: controller.signal }); }
    catch (error) { if (timedOut) throw new DirectSourceError("timeout"); throw error; }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", callerAbort); }
  };
  // Injected clients stay isolated for tests. The cached dataset retains its actual fetch timestamp.
  return options.fetch ? load() : cachedSource(`sec:${sourceId}:${query.symbol ?? ""}:${query.cik ?? ""}:${query.date ?? ""}`, CACHE_MS, load, options.signal);
}
