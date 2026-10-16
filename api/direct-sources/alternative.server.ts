import type { DirectSourceColumn, DirectSourceDataset, DirectSourceQuery } from "../../src/app/platform/direct-source-contracts";
import { cachedSource, DirectSourceError, fetchSourceJson, fetchSourceText, type DirectSourceClientOptions } from "./client.server";

type AlternativeSourceId = "finra-short-volume" | "usaspending";
type DataRow = Readonly<Record<string, string | number | null>>;
const USASPENDING_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const FINRA_HEADER = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market";
const MAX_AWARDS = 50;

const FINRA_COLUMNS: readonly DirectSourceColumn[] = [
  { key: "date", label: "Trade date", labelJa: "取引日", format: "date" },
  { key: "symbol", label: "Symbol", labelJa: "銘柄", format: "text" },
  { key: "shortVolume", label: "Short volume (incl. exempt)", labelJa: "空売り出来高（適用除外を含む）", format: "number" },
  { key: "shortExemptVolume", label: "Of which: exempt", labelJa: "うち適用除外", format: "number" },
  { key: "totalVolume", label: "Reported total volume", labelJa: "報告出来高合計", format: "number" },
  { key: "shortVolumeRatio", label: "Short volume / reported volume", labelJa: "報告出来高に占める空売り比率", format: "ratio" },
  { key: "market", label: "Reporting facilities", labelJa: "報告施設", format: "text" },
];

const AWARD_COLUMNS: readonly DirectSourceColumn[] = [
  { key: "awardId", label: "Award ID", labelJa: "契約ID", format: "text" },
  { key: "recipient", label: "Recipient (as reported)", labelJa: "受取法人（原文）", format: "text" },
  { key: "recipientUei", label: "Recipient UEI", labelJa: "受取法人UEI", format: "text" },
  { key: "amount", label: "Award amount (USD)", labelJa: "契約単位の金額（USD）", format: "usd" },
  { key: "agency", label: "Awarding agency", labelJa: "契約機関", format: "text" },
  { key: "startDate", label: "Award start date", labelJa: "契約開始日", format: "date" },
  { key: "modifiedDate", label: "Last modified (source date)", labelJa: "最終更新日（出典日付）", format: "date" },
  { key: "url", label: "Official award record", labelJa: "公式契約記録", format: "url" },
];

function invalidResponse(): never {
  throw new DirectSourceError("invalid_response");
}

function calendarDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value ? value : null;
}

function requestedDate(value: string | undefined, today: string, minimum: string): string {
  const result = calendarDate(value);
  if (!result || result < minimum || result > today) throw new DirectSourceError("invalid_request");
  return result;
}

function requestedSymbol(value: string | undefined): string {
  const result = value?.trim().toUpperCase() ?? "";
  if (!/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)?$/.test(result) || result.length > 14) {
    throw new DirectSourceError("invalid_request");
  }
  return result;
}

function textField(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) return null;
  return result;
}

// Current FINRA files contain fractional-share volume; do not round to integers.
function shareVolume(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER ? number : null;
}

/** Validate the whole daily file, including its record-count trailer. */
export function parseFinraShortVolume(text: string, symbol: string, date: string): readonly DataRow[] {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines.length < 2 || lines.length > 100_002 || lines[0] !== FINRA_HEADER) invalidResponse();
  const trailer = lines[lines.length - 1];
  if (!/^\d+$/.test(trailer) || Number(trailer) !== lines.length - 2) invalidResponse();
  const day = date.replaceAll("-", "");
  const rows: DataRow[] = [];
  for (const line of lines.slice(1, -1)) {
    const cells = line.split("|");
    // Fail on a substituted day even when its symbol would be filtered out.
    if (cells.length !== 6 || cells[0] !== day) invalidResponse();
    if (cells[1] !== symbol) continue;
    if (rows.length || !/^[BNQDO](?:,[BNQDO])*$/.test(cells[5])) invalidResponse();
    const facilities = cells[5].split(",");
    if (new Set(facilities).size !== facilities.length) invalidResponse();
    const shortVolume = shareVolume(cells[2]);
    const shortExemptVolume = shareVolume(cells[3]);
    const totalVolume = shareVolume(cells[4]);
    if (shortVolume === null || shortExemptVolume === null || totalVolume === null || shortVolume > totalVolume || shortExemptVolume > shortVolume) invalidResponse();
    rows.push({ date, symbol, shortVolume, shortExemptVolume, totalVolume,
      // FINRA's ShortVolume already includes ShortExemptVolume.
      shortVolumeRatio: totalVolume > 0 ? shortVolume / totalVolume : null,
      market: cells[5] });
  }
  return rows;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function amountField(value: unknown): number | null {
  // Negative obligations can be real deobligations. Null is never zero.
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return null;
  return value;
}

function modifiedDate(value: unknown): string | null {
  if (calendarDate(value)) return value as string;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) return null;
  // USAspending supplies no zone for this field. Preserve its calendar date.
  return calendarDate(value.slice(0, 10));
}

export function parseUsaspendingAwards(payload: unknown): Readonly<{ rows: readonly DataRow[]; rejected: number; hasNext: boolean }> {
  const root = object(payload);
  if (!root || root.spending_level !== "awards" || !Array.isArray(root.results) || root.results.length > MAX_AWARDS) invalidResponse();
  const metadata = object(root.page_metadata);
  if (!metadata || metadata.page !== 1 || typeof metadata.hasNext !== "boolean") invalidResponse();
  const rows: DataRow[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const raw of root.results) {
    const item = object(raw);
    if (!item) { rejected += 1; continue; }
    const awardId = textField(item["Award ID"], 200);
    const recipient = textField(item["Recipient Name"], 300);
    const generatedId = textField(item.generated_internal_id, 250);
    const amount = amountField(item["Award Amount"]);
    const start = calendarDate(item["Start Date"]);
    const modified = modifiedDate(item["Last Modified Date"]);
    const agency = textField(item["Awarding Agency"], 300);
    const uei = textField(item["Recipient UEI"], 12);
    const invalidOptional = (item["Award Amount"] != null && amount === null)
      || (item["Start Date"] != null && start === null)
      || (item["Last Modified Date"] != null && modified === null)
      || (item["Awarding Agency"] != null && agency === null)
      || (item["Recipient UEI"] != null && (!uei || !/^[A-Z0-9]{12}$/.test(uei)));
    if (!awardId || !recipient || !generatedId || !/^CONT_AWD_[A-Za-z0-9_.-]+$/.test(generatedId) || invalidOptional) {
      rejected += 1; continue;
    }
    if (seen.has(generatedId)) { rejected += 1; continue; }
    seen.add(generatedId);
    rows.push({ awardId, recipient, recipientUei: uei, amount, agency,
      startDate: start, modifiedDate: modified,
      url: `https://www.usaspending.gov/award/${encodeURIComponent(generatedId)}/` });
  }
  if (root.results.length && !rows.length) invalidResponse();
  return { rows, rejected, hasNext: metadata.hasNext };
}

async function finraDataset(query: DirectSourceQuery, options: DirectSourceClientOptions): Promise<DirectSourceDataset> {
  const symbol = requestedSymbol(query.symbol);
  const today = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const date = requestedDate(query.date, today, "2011-03-01");
  const sourceUrl = `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${date.replaceAll("-", "")}.txt`;
  const load = async (): Promise<DirectSourceDataset> => {
    const text = await fetchSourceText(sourceUrl, { ...options, maxBytes: 10_000_000 });
    const rows = parseFinraShortVolume(text, symbol, date);
    return {
      sourceId: "finra-short-volume", sourceName: "FINRA daily short-sale volume", sourceUrl,
      fetchedAt: (options.now?.() ?? new Date()).toISOString(), columns: FINRA_COLUMNS, rows,
      coverage: { status: rows.length ? "partial" : "empty", noteJa: rows.length ? "指定銘柄・取引日のCNMS統合ファイル。取引所外の報告分のみ。" : "指定日のファイルに該当銘柄がありません。別の日付への置き換えは行っていません。", note: rows.length
        ? "Consolidated CNMS file for the requested symbol and trade date; reported off-exchange activity only."
        : "No matching symbol in the validated file for this exact trade date. No other day was substituted." },
      notes: [
        "Short volume includes short-exempt volume. The exempt column is a subset and is not added again.",
        "This is daily trading volume, not outstanding short interest. It excludes exchange volume and non-publicly disseminated trades.",
        "Fractional-share volumes are preserved. A missing record or unavailable date does not mean zero short selling.",
      ],
      notesJa: ["空売り出来高には適用除外分が含まれます。適用除外列を再加算しません。", "日次の売買出来高であり、空売り残高ではありません。取引所内や非公開の取引は含まれません。", "小数の株数を保持します。レコードがないことや未公表日は、空売りゼロを意味しません。"],
    };
  };
  return options.fetch || options.now ? load() : cachedSource(`finra:${symbol}:${date}`, 30 * 60_000, load, options.signal);
}

async function usaspendingDataset(query: DirectSourceQuery, options: DirectSourceClientOptions): Promise<DirectSourceDataset> {
  const recipient = textField(query.recipient, 120);
  if (!recipient || recipient.length < 2) throw new DirectSourceError("invalid_request");
  const today = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const end = requestedDate(query.date ?? today, today, "2008-10-01");
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  const body = JSON.stringify({
    filters: { time_period: [{ start_date: start, end_date: end }], award_type_codes: ["A", "B", "C", "D"], recipient_search_text: [recipient] },
    fields: ["Award ID", "Recipient Name", "Recipient UEI", "Award Amount", "Awarding Agency", "Start Date", "Last Modified Date", "generated_internal_id"],
    page: 1, limit: MAX_AWARDS, sort: "Last Modified Date", order: "desc", subawards: false,
  });
  const load = async (): Promise<DirectSourceDataset> => {
    let payload: unknown;
    try {
      payload = await fetchSourceJson(USASPENDING_URL, { ...options, method: "POST", body, headers: { "Content-Type": "application/json" }, maxBytes: 2_000_000 });
    } catch (error) {
      // Some local workerd runtimes cannot connect to this host. Trader's
      // authenticated helper makes the same public request using urllib.
      // Only transport changes; the same parser validates every returned row.
      if (!(error instanceof DirectSourceError) || error.code !== "unavailable" || options.signal?.aborted) throw error;
      const environment = options.environment ?? process.env;
      const base = environment.TRADER_TRADINGVIEW_SIDECAR_URL?.trim();
      const token = environment.TRADER_TRADINGVIEW_SIDECAR_TOKEN?.trim();
      if (!base || !token) throw error;
      let url: URL;
      try { url = new URL(base); } catch { throw error; }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw error;
      url.pathname = "/v1/research/usaspending";
      const bridged = object(await fetchSourceJson(url.toString(), {
        ...options, allowLoopback: true, method: "POST", body: JSON.stringify({ recipient, endDate: end }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, maxBytes: 2_100_000,
      }));
      if (bridged?.schemaVersion !== "trader.usaspending.v1" || bridged.recipient !== recipient || bridged.endDate !== end) throw new DirectSourceError("invalid_response");
      payload = bridged.payload;
    }
    const parsed = parseUsaspendingAwards(payload);
    return {
      sourceId: "usaspending", sourceName: "USAspending federal contract awards", sourceUrl: USASPENDING_URL,
      fetchedAt: (options.now?.() ?? new Date()).toISOString(), columns: AWARD_COLUMNS, rows: parsed.rows,
      coverage: { status: parsed.rows.length ? "partial" : "empty", noteJa: `${start}〜${end}の米政府元請契約を企業名で検索。更新日順で最大${MAX_AWARDS}件。${parsed.hasNext ? "続きの結果があります。" : ""}${parsed.rejected ? `不正・重複レコード${parsed.rejected}件を除外しました。` : ""}`, note: `${start}–${end}: recipient text search, federal prime contracts, up to ${MAX_AWARDS} awards ordered by last modification.${parsed.hasNext ? " More matching awards exist beyond this page." : ""}${parsed.rejected ? ` ${parsed.rejected} malformed or duplicate records were omitted.` : ""}` },
      notes: [
        "Recipient search follows USAspending's name/UEI/DUNS matching and may return related recipients. The reported legal entity is preserved; no ticker or parent-company mapping is inferred.",
        "Award Amount is an award-level value. It is not new spending within the search window, contract revenue, or a company sales estimate. Negative values are preserved.",
        "Award start and last-modified dates are source dates, not disclosure-availability timestamps. This current snapshot is not point-in-time backtest data.",
      ],
      notesJa: ["取得元の検索では関連する受取企業も表示されます。原文の法人名を保持し、銘柄や親会社への対応を推測しません。", "表示金額は契約単位の値です。検索期間中の新規支出・契約売上・企業の売上予想とは異なります。負の金額も保持します。", "契約開始日・更新日は出所の日付で、投資判断時に利用可能だった日時を示すものではありません。"],
    };
  };
  return options.fetch || options.now ? load() : cachedSource(`usaspending:${recipient}:${end}`, 30 * 60_000, load, options.signal);
}

export async function getAlternativeDataset(sourceId: AlternativeSourceId, query: DirectSourceQuery, options: DirectSourceClientOptions = {}): Promise<DirectSourceDataset> {
  if (sourceId === "finra-short-volume") return finraDataset(query, options);
  if (sourceId === "usaspending") return usaspendingDataset(query, options);
  throw new DirectSourceError("invalid_request");
}
