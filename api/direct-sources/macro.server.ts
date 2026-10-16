import type { DirectSourceDataset, DirectSourceQuery } from "../../src/app/platform/direct-source-contracts";
import { FRED_SERIES } from "./catalog";
import { cachedSource, DirectSourceError, fetchSourceJson, type DirectSourceClientOptions } from "./client.server";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DirectSourceError("invalid_response");
  return value as Record<string, unknown>;
}

export function validSourceDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function numeric(value: unknown): number | null {
  if (value === "." || value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^[+-]?\d+(?:\.\d+)?$/.test(value))) throw new DirectSourceError("invalid_response");
  const number = Number(value);
  if (!Number.isFinite(number)) throw new DirectSourceError("invalid_response");
  return number;
}

export function parseFredDataset(payload: unknown, metadata: unknown, series: string, fetchedAt: string, vintage?: string): DirectSourceDataset {
  const root = record(payload);
  const metaRoot = record(metadata);
  const metaRows = metaRoot.seriess;
  if (!Array.isArray(metaRows) || metaRows.length !== 1) throw new DirectSourceError("invalid_response");
  const meta = record(metaRows[0]);
  if (meta.id !== series || typeof meta.units !== "string" || typeof meta.frequency !== "string") throw new DirectSourceError("invalid_response");
  if (!Array.isArray(root.observations) || root.observations.length > 100) throw new DirectSourceError("invalid_response");
  if (typeof root.count !== "number" || !Number.isSafeInteger(root.count) || root.count < root.observations.length) throw new DirectSourceError("invalid_response");
  const seen = new Set<string>();
  const rows = root.observations.map(raw => {
    const row = record(raw);
    if (!validSourceDate(row.date) || !validSourceDate(row.realtime_start) || !validSourceDate(row.realtime_end) || row.realtime_start > row.realtime_end || seen.has(row.date) || (vintage && (row.date > vintage || row.realtime_start > vintage || row.realtime_end < vintage))) throw new DirectSourceError("invalid_response");
    seen.add(row.date);
    return { date: row.date, value: numeric(row.value), unit: meta.units as string, vintageStart: row.realtime_start, vintageEnd: row.realtime_end };
  }).sort((a, b) => b.date.localeCompare(a.date));
  return {
    sourceId: "fred", sourceName: `FRED · ${series}`, sourceUrl: `https://fred.stlouisfed.org/series/${series}`, fetchedAt,
    columns: [
      { key: "date", label: "Observation date", labelJa: "対象日", format: "date" },
      { key: "value", label: "Value", labelJa: "値", format: "number" },
      { key: "unit", label: "Units", labelJa: "単位" },
      { key: "vintageStart", label: "Vintage window start", labelJa: "公表値の参照期間・開始", format: "date" },
      { key: "vintageEnd", label: "Vintage window end", labelJa: "公表値の参照期間・終了", format: "date" },
    ], rows,
    coverage: { status: rows.length === 0 ? "empty" : root.count > rows.length ? "partial" : "complete", note: `${rows.length} / ${root.count} observations · ${meta.frequency}`, noteJa: `全${root.count}件のうち${rows.length}件を取得 · 頻度: ${meta.frequency}` },
    notes: [vintage ? `Vintage: ${vintage}` : "Latest available revisions.", "Vintage windows are not initial publication dates; observation dates and fetch times are distinct.", "Missing observations stay null; units are preserved."],
    notesJa: [vintage ? `公表値の参照日: ${vintage}` : "最新の改定値を含みます。", "参照期間は初回公表日ではありません。対象日と取得日時も別です。", "欠損値は空欄。率の単位は出所の表記を保持します。"],
  };
}

export function parseFearGreedDataset(payload: unknown, fetchedAt: string): DirectSourceDataset {
  const item = record(record(payload).fear_and_greed);
  const score = (value: unknown) => { const number = numeric(value); if (number !== null && (number < 0 || number > 100)) throw new DirectSourceError("invalid_response"); return number; };
  const current = score(item.score);
  if (current === null || typeof item.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(item.timestamp) || !Number.isFinite(Date.parse(item.timestamp)) || typeof item.rating !== "string" || item.rating.length > 80) throw new DirectSourceError("invalid_response");
  const sourceTime = new Date(item.timestamp).toISOString();
  return {
    sourceId: "cnn-fear-greed", sourceName: "CNN Fear & Greed", sourceUrl: "https://www.cnn.com/markets/fear-and-greed", fetchedAt,
    columns: [
      { key: "sourceTime", label: "Source updated at", labelJa: "出所の更新時刻", format: "date" },
      { key: "score", label: "Score (0–100)", labelJa: "スコア（0–100）", format: "number" },
      { key: "rating", label: "Sentiment", labelJa: "市場心理" },
      { key: "previousClose", label: "Previous close", labelJa: "前回終値", format: "number" },
      { key: "week", label: "1 week ago", labelJa: "1週間前", format: "number" },
      { key: "month", label: "1 month ago", labelJa: "1か月前", format: "number" },
      { key: "year", label: "1 year ago", labelJa: "1年前", format: "number" },
    ],
    rows: [{ sourceTime, score: current, rating: item.rating, previousClose: score(item.previous_close), week: score(item.previous_1_week), month: score(item.previous_1_month), year: score(item.previous_1_year) }],
    coverage: { status: "partial", note: "Latest snapshot", noteJa: "最新スナップショット" },
    notes: ["Previous reference values have no exact observation dates.", "Uses CNN's website API; availability and schema may change."],
    notesJa: ["過去の参考値には具体的な日付が付与されていません。", "CNNのサイト内部APIを使用します。応答形式や利用可否は変わる場合があります。"],
  };
}

export async function getMacroDataset(sourceId: "fred" | "cnn-fear-greed", query: DirectSourceQuery, options: DirectSourceClientOptions = {}): Promise<DirectSourceDataset> {
  const now = options.now?.() ?? new Date();
  if (sourceId === "cnn-fear-greed") {
    const load = async () => parseFearGreedDataset(await fetchSourceJson("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
      ...options, headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", Accept: "application/json,text/plain,*/*", Referer: "https://www.cnn.com/markets/fear-and-greed" },
    }), (options.now?.() ?? new Date()).toISOString());
    return options.fetch ? load() : cachedSource("direct:cnn", 15 * 60_000, load, options.signal);
  }
  const series = query.series ?? "DGS10";
  if (!FRED_SERIES.some(item => item.id === series)) throw new DirectSourceError("invalid_request");
  if (query.date && (!validSourceDate(query.date) || query.date < "1900-01-01" || query.date > now.toISOString().slice(0, 10))) throw new DirectSourceError("invalid_request");
  const apiKey = (options.environment ?? process.env).FRED_API_KEY?.trim();
  if (!apiKey) throw new DirectSourceError("configuration_required");
  const load = async () => {
    const params = new URLSearchParams({ series_id: series, api_key: apiKey, file_type: "json" });
    if (query.date) { params.set("realtime_start", query.date); params.set("realtime_end", query.date); }
    const metadata = await fetchSourceJson(`https://api.stlouisfed.org/fred/series?${params}`, options);
    params.set("limit", "100"); params.set("sort_order", "desc");
    if (query.date) {
      params.set("realtime_start", query.date); params.set("realtime_end", query.date); params.set("observation_end", query.date);
    }
    const payload = await fetchSourceJson(`https://api.stlouisfed.org/fred/series/observations?${params}`, options);
    return parseFredDataset(payload, metadata, series, (options.now?.() ?? new Date()).toISOString(), query.date);
  };
  return options.fetch ? load() : cachedSource(`direct:fred:${series}:${query.date ?? "latest"}`, 30 * 60_000, load, options.signal);
}
