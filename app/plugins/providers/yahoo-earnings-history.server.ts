import type { EarningsEvent, Instrument } from "../../platform/provider-contracts";

const YAHOO_VISUALIZATION_URL = "https://query1.finance.yahoo.com/v1/finance/visualization";
const YAHOO_QUOTE_SUMMARY_URL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary";
const YAHOO_TIMESERIES_URL = "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries";
const DEFAULT_REQUEST_SIZE = 24;
const MAX_REQUEST_SIZE = 100;
const SIX_YEARS_SECONDS = 6 * 366 * 86_400;
const MAX_FISCAL_REPORT_LAG_DAYS = 130;

type JsonRecord = Record<string, unknown>;
type FetchImplementation = typeof globalThis.fetch;

export type YahooEarningsCredential = Readonly<{
  cookie: string;
  crumb: string;
}>;

export type YahooEarningsCredentialLoader = (
  forceRefresh?: boolean,
) => Promise<YahooEarningsCredential>;

export type YahooEarningsHistoryErrorCode =
  | "request_timeout"
  | "upstream_error"
  | "invalid_response";

export class YahooEarningsHistoryError extends Error {
  readonly code: YahooEarningsHistoryErrorCode;
  readonly status?: number;

  constructor(code: YahooEarningsHistoryErrorCode, message: string, status?: number) {
    super(message);
    this.name = "YahooEarningsHistoryError";
    this.code = code;
    this.status = status;
  }
}

export type YahooEarningsHistoryClientOptions = Readonly<{
  fetchImplementation?: FetchImplementation;
  getCredential: YahooEarningsCredentialLoader;
  timeoutMs: number;
  requestSize?: number;
  now?: () => Date;
}>;

export type YahooEarningsHistoryClient = Readonly<{
  getEarnings(instrument: Instrument): Promise<readonly EarningsEvent[]>;
}>;

type EarningsRow = Readonly<{
  reportDate: string;
  epsActual?: number;
  epsEstimate?: number;
}>;

type QuarterlyRevenue = Readonly<{
  fiscalDateEnding: string;
  revenueActual: number;
}>;

type EarningsTrend = Readonly<{
  fiscalDateEnding: string;
  epsEstimate?: number;
  revenueEstimate?: number;
}>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const record = asRecord(value);
  return typeof record?.raw === "number" && Number.isFinite(record.raw)
    ? record.raw
    : null;
}

function strictSymbol(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().toUpperCase().replace(/[./]/g, "-");
  return /^[A-Z][A-Z0-9-]{0,14}$/.test(normalized) ? normalized : null;
}

function isoDate(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString().slice(0, 10);
}

function rawDate(value: unknown): string | null {
  const candidate = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  return Number.isFinite(Date.parse(`${candidate}T00:00:00Z`)) ? candidate : null;
}

function rawValue(record: JsonRecord | null, key: string): number | undefined {
  const value = finiteNumber(record?.[key]);
  return value === null ? undefined : value;
}

function normalizedRequestSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_REQUEST_SIZE;
  return Math.min(MAX_REQUEST_SIZE, Math.max(1, Math.trunc(value!)));
}

function visualizationRequestBody(symbol: string, size: number): JsonRecord {
  // This mirrors the current query emitted by Yahoo's earnings calendar page.
  // `sp_earnings` is important: the older `earnings` entity omits newer events.
  return {
    sortType: "DESC",
    entityIdType: "sp_earnings",
    sortField: "startdatetime",
    includeFields: [
      "ticker",
      "startdatetime",
      "epsestimate",
      "epsactual",
      "epssurprisepct",
      "eventtype",
    ],
    query: {
      operator: "and",
      operands: [
        {
          operator: "or",
          operands: [{ operator: "eq", operands: ["ticker", symbol] }],
        },
        {
          operator: "or",
          operands: [
            { operator: "eq", operands: ["eventtype", "EAD"] },
            { operator: "eq", operands: ["eventtype", "ERA"] },
          ],
        },
      ],
    },
    offset: "0",
    size,
  };
}

function visualizationUrl(crumb?: string): URL {
  const url = new URL(YAHOO_VISUALIZATION_URL);
  url.searchParams.set("lang", "en-US");
  url.searchParams.set("region", "US");
  if (crumb) url.searchParams.set("crumb", crumb);
  return url;
}

function quoteSummaryUrl(symbol: string, crumb?: string): URL {
  const url = new URL(`${YAHOO_QUOTE_SUMMARY_URL}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("modules", "earningsTrend");
  if (crumb) url.searchParams.set("crumb", crumb);
  return url;
}

function timeseriesUrl(symbol: string, now: Date): URL {
  const period2 = Math.trunc(now.getTime() / 1_000) + 86_400;
  const url = new URL(`${YAHOO_TIMESERIES_URL}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("type", "quarterlyTotalRevenue");
  url.searchParams.set("period1", String(period2 - SIX_YEARS_SECONDS));
  url.searchParams.set("period2", String(period2));
  return url;
}

async function timedFetch(
  fetchImplementation: FetchImplementation,
  url: URL,
  timeoutMs: number,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImplementation(url, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) {
      throw new YahooEarningsHistoryError(
        "request_timeout",
        "Yahoo Finance earnings request timed out.",
      );
    }
    throw new YahooEarningsHistoryError(
      "upstream_error",
      "Yahoo Finance earnings request failed.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function jsonResponse(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new YahooEarningsHistoryError(
      "upstream_error",
      `Yahoo Finance returned an unsuccessful ${operation} response.`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new YahooEarningsHistoryError(
      "invalid_response",
      `Yahoo Finance returned an invalid ${operation} response.`,
    );
  }
}

async function credentialedJson(
  fetchImplementation: FetchImplementation,
  getCredential: YahooEarningsCredentialLoader,
  timeoutMs: number,
  operation: string,
  request: (
    credential: YahooEarningsCredential,
  ) => Readonly<{ url: URL; init: RequestInit }>,
): Promise<Readonly<{ payload: unknown; credential: YahooEarningsCredential }>> {
  let credential = await getCredential(false);
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const item = request(credential);
    response = await timedFetch(fetchImplementation, item.url, timeoutMs, item.init);
    if (response.status !== 401 || attempt === 1) break;
    credential = await getCredential(true);
  }
  return Object.freeze({
    payload: await jsonResponse(response!, operation),
    credential,
  });
}

function visualizationRows(payload: unknown, expectedSymbol: string): readonly EarningsRow[] {
  const root = asRecord(payload);
  const finance = asRecord(root?.finance);
  if (!finance || finance.error) {
    throw new YahooEarningsHistoryError(
      "invalid_response",
      "Yahoo Finance returned an invalid earnings calendar response.",
    );
  }
  const result = asRecord(asArray(finance.result)[0]);
  const document = asRecord(asArray(result?.documents)[0]);
  const columns = asArray(document?.columns)
    .map((column) => text(asRecord(column)?.id));
  const tickerIndex = columns.indexOf("ticker");
  const dateIndex = columns.indexOf("startdatetime");
  const estimateIndex = columns.indexOf("epsestimate");
  const actualIndex = columns.indexOf("epsactual");
  if (tickerIndex < 0 || dateIndex < 0 || estimateIndex < 0 || actualIndex < 0) {
    throw new YahooEarningsHistoryError(
      "invalid_response",
      "Yahoo Finance earnings calendar columns were invalid.",
    );
  }

  const seen = new Set<string>();
  const rows: EarningsRow[] = [];
  for (const rawRow of asArray(document?.rows)) {
    const row = asArray(rawRow);
    const ticker = strictSymbol(text(row[tickerIndex]));
    const reportDate = isoDate(row[dateIndex]);
    if (ticker !== expectedSymbol || !reportDate || seen.has(reportDate)) continue;
    const epsEstimate = finiteNumber(row[estimateIndex]);
    const epsActual = finiteNumber(row[actualIndex]);
    if (epsEstimate === null && epsActual === null) continue;
    seen.add(reportDate);
    rows.push(Object.freeze({
      reportDate,
      ...(epsActual === null ? {} : { epsActual }),
      ...(epsEstimate === null ? {} : { epsEstimate }),
    }));
  }
  return Object.freeze(rows.sort((left, right) => right.reportDate.localeCompare(left.reportDate)));
}

function quarterlyRevenue(payload: unknown, expectedSymbol: string): readonly QuarterlyRevenue[] {
  const root = asRecord(payload);
  const timeseries = asRecord(root?.timeseries);
  if (!timeseries || timeseries.error) return [];
  const rows: QuarterlyRevenue[] = [];
  for (const value of asArray(timeseries.result)) {
    const result = asRecord(value);
    const meta = asRecord(result?.meta);
    const types = asArray(meta?.type).map(text);
    const symbols = asArray(meta?.symbol).map((symbol) => strictSymbol(text(symbol)));
    if (!types.includes("quarterlyTotalRevenue") || !symbols.includes(expectedSymbol)) continue;
    for (const rawRow of asArray(result?.quarterlyTotalRevenue)) {
      const row = asRecord(rawRow);
      const fiscalDateEnding = rawDate(row?.asOfDate);
      const revenueActual = finiteNumber(asRecord(row?.reportedValue)?.raw)
        ?? finiteNumber(row?.dataValue);
      const currency = text(row?.currencyCode).toUpperCase();
      if (!fiscalDateEnding || revenueActual === null || (currency && currency !== "USD")) continue;
      rows.push(Object.freeze({ fiscalDateEnding, revenueActual }));
    }
  }
  return Object.freeze(rows.sort(
    (left, right) => left.fiscalDateEnding.localeCompare(right.fiscalDateEnding),
  ));
}

function earningsTrends(payload: unknown): readonly EarningsTrend[] {
  const root = asRecord(payload);
  const summary = asRecord(root?.quoteSummary);
  if (!summary || summary.error) return [];
  const result = asRecord(asArray(summary.result)[0]);
  const trendRoot = asRecord(result?.earningsTrend);
  const items: EarningsTrend[] = [];
  for (const value of asArray(trendRoot?.trend)) {
    const trend = asRecord(value);
    const period = text(trend?.period);
    const fiscalDateEnding = rawDate(trend?.endDate);
    if (!fiscalDateEnding || (period !== "0q" && period !== "+1q")) continue;
    const earningsEstimate = asRecord(trend?.earningsEstimate);
    const revenueEstimate = asRecord(trend?.revenueEstimate);
    const epsEstimate = rawValue(earningsEstimate, "avg");
    const estimatedRevenue = rawValue(revenueEstimate, "avg");
    if (epsEstimate === undefined && estimatedRevenue === undefined) continue;
    items.push(Object.freeze({
      fiscalDateEnding,
      ...(epsEstimate === undefined ? {} : { epsEstimate }),
      ...(estimatedRevenue === undefined ? {} : { revenueEstimate: estimatedRevenue }),
    }));
  }
  return Object.freeze(items.sort(
    (left, right) => left.fiscalDateEnding.localeCompare(right.fiscalDateEnding),
  ));
}

function precedingFiscalItem<T extends { fiscalDateEnding: string }>(
  reportDate: string,
  items: readonly T[],
): T | null {
  const reportTime = Date.parse(`${reportDate}T00:00:00Z`);
  let closest: T | null = null;
  let closestLag = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const fiscalTime = Date.parse(`${item.fiscalDateEnding}T00:00:00Z`);
    const lagDays = (reportTime - fiscalTime) / 86_400_000;
    if (lagDays < 0 || lagDays > MAX_FISCAL_REPORT_LAG_DAYS || lagDays >= closestLag) continue;
    closest = item;
    closestLag = lagDays;
  }
  return closest;
}

function normalizedEvents(
  instrument: Instrument,
  rows: readonly EarningsRow[],
  revenues: readonly QuarterlyRevenue[],
  trends: readonly EarningsTrend[],
  ingestedAt: string,
): readonly EarningsEvent[] {
  const usedRevenueDates = new Set<string>();
  const events = rows.map((row): EarningsEvent => {
    let fiscalDateEnding: string | undefined;
    let revenueActual: number | undefined;
    let revenueEstimate: number | undefined;
    let epsEstimate = row.epsEstimate;

    if (row.epsActual !== undefined) {
      const revenue = precedingFiscalItem(
        row.reportDate,
        revenues.filter((item) => !usedRevenueDates.has(item.fiscalDateEnding)),
      );
      if (revenue) {
        fiscalDateEnding = revenue.fiscalDateEnding;
        revenueActual = revenue.revenueActual;
        usedRevenueDates.add(revenue.fiscalDateEnding);
      }
    } else {
      const trend = precedingFiscalItem(row.reportDate, trends);
      if (trend) {
        fiscalDateEnding = trend.fiscalDateEnding;
        epsEstimate ??= trend.epsEstimate;
        revenueEstimate = trend.revenueEstimate;
      }
    }

    return Object.freeze({
      reportDate: row.reportDate,
      ...(fiscalDateEnding ? { fiscalDateEnding } : {}),
      ...(row.epsActual === undefined ? {} : { epsActual: row.epsActual }),
      ...(epsEstimate === undefined ? {} : { epsEstimate }),
      ...(revenueActual === undefined ? {} : { revenueActual }),
      ...(revenueEstimate === undefined ? {} : { revenueEstimate }),
      provenance: Object.freeze({
        providerId: "yahoo",
        sourceId: `yahoo-earnings:${instrument.symbol}:${row.reportDate}`,
        asOf: row.reportDate,
        ingestedAt,
        // Never retain the credential-bearing request URL in canonical data.
        sourceUrl: visualizationUrl().toString(),
      }),
    });
  });
  return Object.freeze(events);
}

export function createYahooEarningsHistoryClient(
  options: YahooEarningsHistoryClientOptions,
): YahooEarningsHistoryClient {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Math.min(15_000, Math.max(10, Math.trunc(options.timeoutMs)));
  const requestSize = normalizedRequestSize(options.requestSize);
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    getEarnings: async (instrument) => {
      const symbol = strictSymbol(instrument.symbol);
      if (!symbol) return [];
      const visualization = await credentialedJson(
        fetchImplementation,
        options.getCredential,
        timeoutMs,
        "earnings calendar",
        (credential) => ({
          url: visualizationUrl(credential.crumb),
          init: {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              cookie: credential.cookie,
              "user-agent": "Unicorn/0.1 (Yahoo compatibility provider; personal use only)",
            },
            body: JSON.stringify(visualizationRequestBody(symbol, requestSize)),
          },
        }),
      );
      const rows = visualizationRows(visualization.payload, symbol);
      if (rows.length === 0) return [];

      const [trendResult, revenueResult] = await Promise.allSettled([
        credentialedJson(
          fetchImplementation,
          options.getCredential,
          timeoutMs,
          "earnings trend",
          (credential) => ({
            url: quoteSummaryUrl(symbol, credential.crumb),
            init: {
              headers: {
                accept: "application/json",
                cookie: credential.cookie,
                "user-agent": "Unicorn/0.1 (Yahoo compatibility provider; personal use only)",
              },
            },
          }),
        ),
        (async () => {
          const response = await timedFetch(
            fetchImplementation,
            timeseriesUrl(symbol, now()),
            timeoutMs,
            {
              headers: {
                accept: "application/json",
                "user-agent": "Unicorn/0.1 (Yahoo compatibility provider; personal use only)",
              },
            },
          );
          return jsonResponse(response, "quarterly revenue");
        })(),
      ]);

      const trends = trendResult.status === "fulfilled"
        ? earningsTrends(trendResult.value.payload)
        : [];
      const revenues = revenueResult.status === "fulfilled"
        ? quarterlyRevenue(revenueResult.value, symbol)
        : [];
      return normalizedEvents(
        instrument,
        rows,
        revenues,
        trends,
        now().toISOString(),
      );
    },
  });
}
