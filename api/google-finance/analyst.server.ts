import { createHash } from "node:crypto";

import {
  PROVIDER_SCHEMA_VERSION,
  type AnalystConsensus,
  type AnalystRatingEvent,
  type AnalystRatingHistory,
  type AnalystRatingHistoryRequest,
  type DataProvenance,
  type Instrument,
  type ProviderAdapter,
  type ProviderEnvironment,
  type ProviderRegistration,
  type ProviderRequestContext,
} from "@/app/platform/provider-contracts";
import {
  ANALYST_MERGE_LOOKBACK_MONTHS,
  canonicalAnalystFirmId,
  mergeAnalystConsensus,
} from "../google-finance-benzinga/merge";

const GOOGLE_FINANCE_ORIGIN = "https://www.google.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_TTL_MS = 60 * 60_000;
const DEFAULT_MAX_HTML_BYTES = 5_000_000;
const MAX_PAGE_SIZE = 1_000;
const NEW_YORK_TIME_ZONE = "America/New_York";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type GoogleFinanceRow = readonly JsonValue[];

export type GoogleFinanceAnalystSummary = Readonly<{
  companyName: string;
  currency: string;
  targetLow?: number;
  targetHigh?: number;
  targetConsensus?: number;
  targetUpsidePercent?: number;
  analystCount?: number;
  consensus?: string;
  buy?: number;
  sell?: number;
  hold?: number;
}>;

export type GoogleFinanceAnalystData = Readonly<{
  callbackKey: string;
  summary: GoogleFinanceAnalystSummary;
  rows: readonly GoogleFinanceRow[];
}>;

export type GoogleFinanceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type GoogleFinanceProviderOptions = Readonly<{
  fetch?: GoogleFinanceFetch;
  now?: () => Date;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxHtmlBytes?: number;
}>;

export type GoogleFinanceProviderErrorCode =
  | "configuration"
  | "invalid_request"
  | "network"
  | "timeout"
  | "upstream"
  | "invalid_response";

/** Credential/body-safe provider error. Raw HTML and upstream URLs are omitted. */
export class GoogleFinanceProviderError extends Error {
  readonly code: GoogleFinanceProviderErrorCode;
  readonly status?: number;

  constructor(code: GoogleFinanceProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = "GoogleFinanceProviderError";
    this.code = code;
    this.status = status;
  }
}

const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "google-finance",
  version: "1.0.0",
  displayName: "Google Finance Analyst Ratings",
  capabilities: ["analyst.consensus", "analyst.ratings"],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: [],
} as const;

type CachedPage = Readonly<{
  data: GoogleFinanceAnalystData;
  ingestedAt: string;
  expiresAt: number;
  sourceUrl: string;
}>;

const pageCache = new Map<string, CachedPage>();
const pageInFlight = new Map<string, Promise<CachedPage>>();

export function clearGoogleFinanceProviderCache() {
  pageCache.clear();
  pageInFlight.clear();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? Math.trunc(number) : undefined;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return value !== undefined && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function environmentNumber(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : undefined;
}

function normalizedSymbol(value: string) {
  const symbol = value.normalize("NFKC").trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) ? symbol : undefined;
}

/** Yahoo-style class shares use `-`; Google Finance identifies them with `.`. */
function googleFinanceSymbol(symbol: string) {
  return symbol.replaceAll("-", ".");
}

function googleExchange(instrument: Instrument) {
  const byMic: Readonly<Record<string, string>> = {
    XNAS: "NASDAQ",
    XNYS: "NYSE",
    XASE: "NYSEAMERICAN",
  };
  const fromMic = instrument.exchangeMic ? byMic[instrument.exchangeMic.toUpperCase()] : undefined;
  if (fromMic) return fromMic;
  const exchange = instrument.exchange?.toUpperCase() ?? "";
  if (exchange.includes("NASDAQ")) return "NASDAQ";
  if (exchange.includes("AMERICAN") || exchange.includes("AMEX")) return "NYSEAMERICAN";
  if (exchange.includes("NYSE") || exchange.includes("NEW YORK")) return "NYSE";
  return undefined;
}

function googleFinanceUrl(symbol: string, exchange: string) {
  const url = new URL(
    `/finance/beta/quote/${encodeURIComponent(symbol)}:${encodeURIComponent(exchange)}`,
    GOOGLE_FINANCE_ORIGIN,
  );
  url.searchParams.set("tab", "analysis");
  url.searchParams.set("hl", "en");
  return url;
}

function matchingDelimiter(value: string, start: number, open: string, close: string) {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function dataArrayFromCallback(callback: string) {
  const dataProperty = /(?:^|[{,])\s*data\s*:/g.exec(callback);
  if (!dataProperty) return undefined;
  const arrayStart = callback.indexOf("[", dataProperty.index + dataProperty[0].length);
  if (arrayStart < 0) return undefined;
  const arrayEnd = matchingDelimiter(callback, arrayStart, "[", "]");
  if (arrayEnd === undefined) return undefined;
  try {
    return JSON.parse(callback.slice(arrayStart, arrayEnd + 1)) as JsonValue;
  } catch {
    return undefined;
  }
}

function analystDataShape(value: JsonValue): value is JsonValue[] {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return false;
  const summary = value[0];
  if (
    typeof summary[0] !== "string"
    || typeof summary[1] !== "string"
    || typeof summary[2] !== "number"
    || typeof summary[3] !== "number"
    || typeof summary[4] !== "number"
    || typeof summary[5] !== "number"
    || typeof summary[6] !== "number"
    || typeof summary[7] !== "string"
    || typeof summary[8] !== "number"
    || typeof summary[9] !== "number"
    || typeof summary[10] !== "number"
  ) {
    return false;
  }
  if (value[1] === undefined) return true;
  if (!Array.isArray(value[1])) return false;
  const rows = value[1];
  return rows.length === 0 || rows.every((row) => (
    Array.isArray(row)
    && row.length >= 28
    && typeof row[0] === "string"
    && typeof row[2] === "string"
    && typeof row[3] === "string"
    && typeof row[4] === "string"
  ));
}

function containsListing(
  value: JsonValue,
  expected: Readonly<{ symbol: string; exchange: string }>,
) {
  const stack: JsonValue[] = [value];
  let visited = 0;
  while (stack.length > 0 && visited < 200_000) {
    const current = stack.pop()!;
    visited += 1;
    if (Array.isArray(current)) {
      if (
        current.length === 2
        && current[0] === expected.symbol
        && current[1] === expected.exchange
      ) {
        return true;
      }
      for (const nested of current) stack.push(nested);
    } else if (current && typeof current === "object") {
      for (const nested of Object.values(current)) stack.push(nested);
    }
  }
  return false;
}

function analystData(
  callbackKey: string,
  data: JsonValue[],
): GoogleFinanceAnalystData {
  const summary = data[0] as JsonValue[];
  const rows = Array.isArray(data[1])
    ? (data[1] as JsonValue[]).filter(Array.isArray) as GoogleFinanceRow[]
    : [];
  return Object.freeze({
    callbackKey,
    summary: Object.freeze({
      companyName: summary[0] as string,
      currency: summary[1] as string,
      targetLow: positiveNumber(summary[2]),
      targetHigh: positiveNumber(summary[3]),
      targetConsensus: positiveNumber(summary[4]),
      targetUpsidePercent: finiteNumber(summary[5]),
      analystCount: nonNegativeInteger(summary[6]),
      consensus: stringValue(summary[7]),
      buy: nonNegativeInteger(summary[8]),
      sell: nonNegativeInteger(summary[9]),
      hold: nonNegativeInteger(summary[10]),
    }),
    rows: Object.freeze(rows.map((row) => Object.freeze([...row]))),
  });
}

/**
 * Extract the analyst callback without evaluating any inline JavaScript. The
 * callback key (currently ds:7) is deliberately discovered by data shape.
 */
export function extractGoogleFinanceAnalystData(
  html: string,
  expectedListing?: Readonly<{ symbol: string; exchange: string }>,
): GoogleFinanceAnalystData {
  const marker = "AF_initDataCallback(";
  let cursor = 0;
  let listingMatched = expectedListing === undefined;
  let preferred: GoogleFinanceAnalystData | undefined;
  let fallback: GoogleFinanceAnalystData | undefined;
  while (cursor < html.length) {
    const markerIndex = html.indexOf(marker, cursor);
    if (markerIndex < 0) break;
    const argumentStart = markerIndex + marker.length - 1;
    const argumentEnd = matchingDelimiter(html, argumentStart, "(", ")");
    if (argumentEnd === undefined) break;
    const callback = html.slice(argumentStart + 1, argumentEnd);
    const keyMatch = /\bkey\s*:\s*(["'])([^"']+)\1/.exec(callback);
    const data = dataArrayFromCallback(callback);
    if (data !== undefined && expectedListing && containsListing(data, expectedListing)) {
      listingMatched = true;
    }
    if (keyMatch && data !== undefined && analystDataShape(data)) {
      const candidate = analystData(keyMatch[2]!, data);
      if (keyMatch[2] === "ds:7") preferred = candidate;
      else fallback ??= candidate;
    }
    cursor = argumentEnd + 1;
  }
  if (!listingMatched) {
    throw new GoogleFinanceProviderError(
      "invalid_response",
      "Google Finance listing identity did not match the request.",
    );
  }
  const selected = preferred ?? fallback;
  if (selected) return selected;
  throw new GoogleFinanceProviderError(
    "invalid_response",
    "Google Finance analyst callback was not found.",
  );
}

function parsedUsDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const iso = date.toISOString().slice(0, 10);
  return iso === `${match[3]}-${match[1]}-${match[2]}` ? iso : undefined;
}

function normalizedUpdatedAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const timestamp = Date.parse(withZone);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function eventTime(sourceDate: string, updatedAt: string | undefined) {
  if (updatedAt?.startsWith(sourceDate)) return updatedAt;
  return `${sourceDate}T12:00:00.000Z`;
}

function targetFromRow(row: GoogleFinanceRow, fallbackCurrency: string) {
  const convertedTarget = positiveNumber(row[22]);
  const convertedCurrency = stringValue(row[24]);
  if (convertedTarget !== undefined && convertedCurrency) {
    return { target: convertedTarget, currency: convertedCurrency.toUpperCase() };
  }
  const nativeTarget = positiveNumber(row[19]);
  const nativeCurrency = stringValue(row[21]);
  return {
    target: nativeTarget,
    currency: (nativeCurrency ?? fallbackCurrency).toUpperCase(),
  };
}

function eventFromRow(
  row: GoogleFinanceRow,
  instrument: Instrument,
  fallbackCurrency: string,
): AnalystRatingEvent | undefined {
  const sourceEventDate = parsedUsDate(row[4]);
  const firm = stringValue(row[2]);
  const rating = stringValue(row[3]);
  if (!sourceEventDate || !firm || !rating) return undefined;
  const analystName = stringValue(row[1]);
  const target = targetFromRow(row, fallbackCurrency);
  const updatedAt = normalizedUpdatedAt(row[26]);
  const rawId = stringValue(row[0]);
  const totalRatings = nonNegativeInteger(row[11]);
  const hasAccuracyHistory = totalRatings !== undefined && totalRatings > 0;
  const eventId = rawId ?? createHash("sha256").update([
    instrument.symbol,
    firm,
    analystName ?? "",
    sourceEventDate,
    rating,
    target.target ?? "",
    stringValue(row[27]) ?? "",
  ].join("\u0000")).digest("hex");
  const canonicalFirmId = canonicalAnalystFirmId(firm, analystName);
  return Object.freeze({
    eventId,
    instrumentId: instrument.instrumentId,
    providerId: manifest.id,
    ratingProviderId: manifest.id,
    ...(target.target === undefined ? {} : { priceTargetProviderId: manifest.id }),
    sourceProviderIds: Object.freeze([manifest.id]),
    symbol: instrument.symbol,
    companyName: instrument.name,
    exchange: instrument.exchange,
    currency: target.currency,
    analystFirm: firm,
    analystName,
    canonicalFirmId,
    action: stringValue(row[27]),
    actionCompany: stringValue(row[27]),
    rating,
    ratingCurrent: rating,
    priceTarget: target.target,
    effectivePriceTarget: target.target,
    analystStarRating: hasAccuracyHistory ? finiteNumber(row[13]) : undefined,
    overallSuccessRate: hasAccuracyHistory ? finiteNumber(row[9]) : undefined,
    totalRatings,
    sourceEventDate,
    eventTime: eventTime(sourceEventDate, updatedAt),
    updatedAt,
  });
}

const newYorkDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: NEW_YORK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function newYorkCalendarDate(date: Date) {
  const parts: Record<string, string> = {};
  for (const part of newYorkDateFormatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function subtractCalendarMonths(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year!, month! - 1, 1));
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  result.setUTCDate(Math.min(day!, lastDay));
  return result.toISOString().slice(0, 10);
}

function validDateRange(request: AnalystRatingHistoryRequest) {
  const validCalendarDate = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (
    !validCalendarDate(request.dateFrom)
    || !validCalendarDate(request.dateTo)
    || request.dateFrom > request.dateTo
  ) {
    throw new GoogleFinanceProviderError("invalid_request", "Google Finance dates are invalid.");
  }
  return { dateFrom: request.dateFrom, dateTo: request.dateTo };
}

function historyCoverage(
  items: readonly AnalystRatingEvent[],
  dateFrom: string,
  dateTo: string,
  asOf: string,
  truncated: boolean,
) {
  const latestByFirm = new Map<string, AnalystRatingEvent>();
  for (const item of items) {
    const key = item.canonicalFirmId ?? item.analystFirm ?? item.analystName;
    if (!key) continue;
    const current = latestByFirm.get(key);
    if (!current || item.eventTime > current.eventTime) latestByFirm.set(key, item);
  }
  const latest = [...latestByFirm.values()];
  const source = Object.freeze({
    providerId: manifest.id,
    status: "available" as const,
    eventCount: items.length,
    firmCount: latest.length,
    ratingCount: latest.filter((item) => stringValue(item.ratingCurrent ?? item.rating)).length,
    priceTargetCount: latest.filter((item) => positiveNumber(item.effectivePriceTarget) !== undefined).length,
    asOf,
    dateFrom,
    dateTo,
    ...(truncated ? { truncated: true } : {}),
  });
  return Object.freeze({
    status: truncated ? "partial" as const : "complete" as const,
    sources: Object.freeze([source]),
  });
}

class GoogleFinanceClient {
  readonly #fetch: GoogleFinanceFetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #maxHtmlBytes: number;

  constructor(input: Readonly<{
    fetch: GoogleFinanceFetch;
    now: () => Date;
    timeoutMs: number;
    cacheTtlMs: number;
    maxHtmlBytes: number;
  }>) {
    this.#fetch = input.fetch;
    this.#now = input.now;
    this.#timeoutMs = input.timeoutMs;
    this.#cacheTtlMs = input.cacheTtlMs;
    this.#maxHtmlBytes = input.maxHtmlBytes;
  }

  async analystPage(
    symbol: string,
    exchange: string,
    fresh: boolean,
    signal?: AbortSignal,
  ): Promise<CachedPage> {
    const cacheKey = `${symbol}\u0000${exchange}`;
    const startedAt = this.#now();
    if (!Number.isFinite(startedAt.getTime())) {
      throw new GoogleFinanceProviderError("configuration", "Google Finance clock is invalid.");
    }
    if (!fresh) {
      const cached = pageCache.get(cacheKey);
      if (cached && cached.expiresAt > startedAt.getTime()) return cached;
      const pending = signal === undefined ? pageInFlight.get(cacheKey) : undefined;
      if (pending) return pending;
    }
    const request = this.#request(symbol, exchange, startedAt, signal);
    const shareInFlight = !fresh && signal === undefined;
    if (shareInFlight) pageInFlight.set(cacheKey, request);
    try {
      const result = await request;
      pageCache.set(cacheKey, result);
      while (pageCache.size > 256) pageCache.delete(pageCache.keys().next().value!);
      return result;
    } finally {
      if (shareInFlight) pageInFlight.delete(cacheKey);
    }
  }

  async #request(
    symbol: string,
    exchange: string,
    startedAt: Date,
    signal?: AbortSignal,
  ): Promise<CachedPage> {
    const url = googleFinanceUrl(symbol, exchange);
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort();
    signal?.addEventListener("abort", abortFromRequest, { once: true });
    if (signal?.aborted) controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new GoogleFinanceProviderError("timeout", "Google Finance request timed out."));
      }, this.#timeoutMs);
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.#fetch(url, {
            method: "GET",
            // Cloudflare's fetch rejects `redirect: "error"`. Manual mode
            // prevents automatic credential/header forwarding; non-2xx
            // redirects are rejected by the response status check below.
            redirect: "manual",
            headers: {
              Accept: "text/html,application/xhtml+xml",
              "Accept-Language": "en-US,en;q=0.9",
              "User-Agent": "Mozilla/5.0 (compatible; Trader/1.0; +https://localhost)",
            },
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (error instanceof GoogleFinanceProviderError) throw error;
        if (signal?.aborted) {
          throw new GoogleFinanceProviderError("network", "Google Finance request was aborted.");
        }
        if (controller.signal.aborted) {
          throw new GoogleFinanceProviderError("timeout", "Google Finance request timed out.");
        }
        throw new GoogleFinanceProviderError("network", "Google Finance request failed.");
      }
      if (!response.ok) {
        throw new GoogleFinanceProviderError(
          "upstream",
          `Google Finance request failed with status ${response.status}.`,
          response.status,
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > this.#maxHtmlBytes) {
        throw new GoogleFinanceProviderError("invalid_response", "Google Finance response was too large.");
      }
      let html: string;
      try {
        if (response.body) {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let byteLength = 0;
          while (true) {
            const part = await Promise.race([reader.read(), timeoutPromise]);
            if (part.done) break;
            byteLength += part.value.byteLength;
            if (byteLength > this.#maxHtmlBytes) {
              controller.abort();
              await reader.cancel().catch(() => undefined);
              throw new GoogleFinanceProviderError(
                "invalid_response",
                "Google Finance response was too large.",
              );
            }
            chunks.push(part.value);
          }
          const body = new Uint8Array(byteLength);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          html = new TextDecoder("utf-8").decode(body);
        } else {
          html = await Promise.race([response.text(), timeoutPromise]);
          if (new TextEncoder().encode(html).byteLength > this.#maxHtmlBytes) {
            throw new GoogleFinanceProviderError(
              "invalid_response",
              "Google Finance response was too large.",
            );
          }
        }
      } catch (error) {
        if (error instanceof GoogleFinanceProviderError) throw error;
        if (signal?.aborted) {
          throw new GoogleFinanceProviderError("network", "Google Finance request was aborted.");
        }
        if (controller.signal.aborted) {
          throw new GoogleFinanceProviderError("timeout", "Google Finance request timed out.");
        }
        throw new GoogleFinanceProviderError("invalid_response", "Google Finance returned invalid HTML.");
      }
      const data = extractGoogleFinanceAnalystData(html, { symbol, exchange });
      return Object.freeze({
        data,
        ingestedAt: startedAt.toISOString(),
        expiresAt: startedAt.getTime() + this.#cacheTtlMs,
        sourceUrl: url.toString(),
      });
    } catch (error) {
      if (error instanceof GoogleFinanceProviderError) throw error;
      throw new GoogleFinanceProviderError("network", "Google Finance request failed.");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromRequest);
    }
  }
}

export function createGoogleFinanceProvider(
  env: ProviderEnvironment,
  options: GoogleFinanceProviderOptions = {},
): ProviderAdapter {
  const now = options.now ?? (() => new Date());
  const configuredTimeoutSeconds = environmentNumber(env.GOOGLE_FINANCE_TIMEOUT_SECONDS);
  const configuredCacheTtlSeconds = environmentNumber(env.GOOGLE_FINANCE_CACHE_TTL_SECONDS);
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? (
      configuredTimeoutSeconds === undefined ? undefined : configuredTimeoutSeconds * 1_000
    ),
    DEFAULT_TIMEOUT_MS,
    1,
    60_000,
  );
  const cacheTtlMs = boundedInteger(
    options.cacheTtlMs ?? (
      configuredCacheTtlSeconds === undefined ? undefined : configuredCacheTtlSeconds * 1_000
    ),
    DEFAULT_CACHE_TTL_MS,
    60_000,
    86_400_000,
  );
  const maxHtmlBytes = boundedInteger(
    options.maxHtmlBytes ?? environmentNumber(env.GOOGLE_FINANCE_MAX_HTML_BYTES),
    DEFAULT_MAX_HTML_BYTES,
    100_000,
    20_000_000,
  );
  const client = new GoogleFinanceClient({
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    now,
    timeoutMs,
    cacheTtlMs,
    maxHtmlBytes,
  });

  const history = async (
    instrument: Instrument,
    request: AnalystRatingHistoryRequest,
    context: ProviderRequestContext,
  ): Promise<AnalystRatingHistory> => {
    const symbol = normalizedSymbol(instrument.symbol);
    const exchange = googleExchange(instrument);
    if (
      !symbol
      || !exchange
      || instrument.currency !== "USD"
      || instrument.listingCountry !== "US"
    ) {
      throw new GoogleFinanceProviderError("invalid_request", "A supported US stock listing is required.");
    }
    const requestSymbol = googleFinanceSymbol(symbol);
    const { dateFrom, dateTo } = validDateRange(request);
    const pageSize = boundedInteger(request.pageSize, MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const loaded = await client.analystPage(
      requestSymbol,
      exchange,
      context.fresh === true,
      context.signal,
    );
    const normalized = loaded.data.rows
      .map((row) => eventFromRow(row, instrument, loaded.data.summary.currency))
      .filter((event): event is AnalystRatingEvent => event !== undefined)
      .filter((event) => event.sourceEventDate >= dateFrom && event.sourceEventDate <= dateTo)
      .sort((left, right) => (
        right.sourceEventDate.localeCompare(left.sourceEventDate)
        || right.eventTime.localeCompare(left.eventTime)
        || left.eventId.localeCompare(right.eventId)
      ));
    const items = normalized.slice(0, pageSize);
    const providerNow = now();
    if (!Number.isFinite(providerNow.getTime())) {
      throw new GoogleFinanceProviderError("configuration", "Google Finance clock is invalid.");
    }
    const providerDate = newYorkCalendarDate(providerNow);
    const documentedConsensusFrom = subtractCalendarMonths(
      providerDate,
      ANALYST_MERGE_LOOKBACK_MONTHS,
    );
    const truncated = normalized.length > pageSize || dateFrom < documentedConsensusFrom;
    const asOf = items[0]?.eventTime ?? loaded.ingestedAt;
    const provenance: DataProvenance = Object.freeze({
      providerId: manifest.id,
      sourceId: `google-finance:${loaded.data.callbackKey}:${symbol}:${exchange}:${dateFrom}:${dateTo}`,
      sourceUrl: loaded.sourceUrl,
      asOf,
      ingestedAt: loaded.ingestedAt,
    });
    return Object.freeze({
      instrumentId: instrument.instrumentId,
      symbol,
      dateFrom,
      dateTo,
      pageSize,
      items: Object.freeze(items),
      consensusLookbackMonths: ANALYST_MERGE_LOOKBACK_MONTHS,
      coverage: historyCoverage(items, dateFrom, dateTo, asOf, truncated),
      sources: Object.freeze([provenance]),
      provenance,
    });
  };

  const adapter: ProviderAdapter = {
    manifest,
    analyst: {
      getConsensus: async (
        instrument: Instrument,
        context: ProviderRequestContext,
      ): Promise<AnalystConsensus | null> => {
        const cutoff = context.asOf ? new Date(context.asOf) : now();
        if (!Number.isFinite(cutoff.getTime())) {
          throw new GoogleFinanceProviderError("invalid_request", "Google Finance cutoff is invalid.");
        }
        const dateTo = newYorkCalendarDate(cutoff);
        const dateFrom = subtractCalendarMonths(dateTo, ANALYST_MERGE_LOOKBACK_MONTHS);
        const ratings = await history(
          instrument,
          { dateFrom, dateTo, pageSize: MAX_PAGE_SIZE },
          context,
        );
        return mergeAnalystConsensus({
          instrument,
          sources: [{
            providerId: manifest.id,
            status: "available",
            history: ratings,
            truncated: ratings.coverage?.sources[0]?.truncated,
          }],
          ingestedAt: ratings.provenance.ingestedAt,
          providerId: manifest.id,
        });
      },
      getRatingHistory: history,
    },
  };
  return Object.freeze(adapter);
}

export const googleFinanceProviderRegistration = {
  manifest,
  create: (env) => createGoogleFinanceProvider(env),
} as const satisfies ProviderRegistration;
