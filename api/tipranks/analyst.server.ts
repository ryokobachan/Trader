import {
  PROVIDER_SCHEMA_VERSION,
  type AnalystConsensus,
  type AnalystMergeCoverage,
  type AnalystRatingEvent,
  type AnalystRatingHistory,
  type AnalystRatingHistoryRequest,
  type AnalystSourceCoverage,
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

const DEFAULT_BASE_URL = "https://api.tipranks.com/api";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 100;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
const MAX_LIMIT = 1_000;
const MAX_MONTHS = 120;
const NEW_YORK_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type JsonRecord = Record<string, unknown>;
type QueryValue = string | number | boolean | undefined;

function newYorkCalendarDate(date: Date) {
  const parts: Record<string, string> = {};
  for (const part of NEW_YORK_DATE_FORMATTER.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export type TipRanksFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type TipRanksProviderOptions = Readonly<{
  fetch?: TipRanksFetch;
  now?: () => Date;
  timeoutMs?: number;
  limit?: number;
  cacheTtlMs?: number;
}>;

export type TipRanksProviderErrorCode =
  | "configuration"
  | "invalid_request"
  | "network"
  | "timeout"
  | "upstream"
  | "invalid_response";

/** Credential-safe error: it never retains URLs, headers, bodies, or causes. */
export class TipRanksProviderError extends Error {
  readonly code: TipRanksProviderErrorCode;
  readonly status?: number;

  constructor(code: TipRanksProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = "TipRanksProviderError";
    this.code = code;
    this.status = status;
  }
}

const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "tipranks",
  version: "1.0.0",
  displayName: "TipRanks Enterprise Analyst Ratings",
  capabilities: ["analyst.consensus", "analyst.ratings"],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: ["TIPRANKS_API_KEY", "TIPRANKS_API_TOKEN"],
} as const;

type CachedPayload = Readonly<{
  payload: unknown;
  ingestedAt: string;
  expiresAt: number;
}>;

const payloadCache = new Map<string, CachedPayload>();
const payloadInFlight = new Map<string, Promise<CachedPayload>>();

/** Test-only cache reset; no response data is persisted outside process memory. */
export function clearTipRanksProviderCache() {
  payloadCache.clear();
  payloadInFlight.clear();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(record: JsonRecord, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(record, name)) return record[name];
  }
  const lowerNames = new Set(names.map((name) => name.toLocaleLowerCase("en-US")));
  const entry = Object.entries(record).find(([name]) => (
    lowerNames.has(name.toLocaleLowerCase("en-US"))
  ));
  return entry?.[1];
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replaceAll(",", "").replace(/^\$/, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
    if (isRecord(value)) {
      const nested = numberValue(value.value, value.amount, value.price);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function positiveNumber(...values: unknown[]) {
  const value = numberValue(...values);
  return value !== undefined && value > 0 ? value : undefined;
}

function looksLikeRating(record: JsonRecord) {
  return property(record, "recommendationDate", "recommendation", "firmName", "analystName") !== undefined;
}

const RATING_ENVELOPE_KEYS = Object.freeze([
  "analysts",
  "ratings",
  "analystRatings",
  "experts",
  "data",
  "results",
  "items",
]);

function recordsFrom(value: unknown, depth = 0): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value) || depth > 3) return [];
  if (looksLikeRating(value)) return [value];
  for (const key of RATING_ENVELOPE_KEYS) {
    const nested = property(value, key);
    if (nested === undefined) continue;
    const records = recordsFrom(nested, depth + 1);
    if (records.length > 0 || Array.isArray(nested)) return records;
  }
  return [];
}

function hasRatingsShape(value: unknown, depth = 0): boolean {
  if (Array.isArray(value)) {
    return value.length === 0 || value.some((item) => isRecord(item) && looksLikeRating(item));
  }
  if (!isRecord(value) || depth > 3) return false;
  if (looksLikeRating(value)) return true;
  for (const key of RATING_ENVELOPE_KEYS) {
    const nested = property(value, key);
    if (nested !== undefined && hasRatingsShape(nested, depth + 1)) return true;
  }
  return false;
}

function normalizedSymbol(value: unknown) {
  return stringValue(value)?.normalize("NFKC").trim().toUpperCase();
}

function parsedCalendarDate(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const candidate = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : us
      ? `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`
      : undefined;
  if (!candidate) return undefined;
  const timestamp = Date.parse(`${candidate}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === candidate
    ? candidate
    : undefined;
}

function instant(value: unknown): Date | undefined {
  const numeric = numberValue(value);
  if (numeric !== undefined && numeric > 0) {
    const parsed = new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  const text = stringValue(value);
  if (!text) return undefined;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function nestedRecord(value: unknown) {
  return isRecord(value) ? value : {};
}

function ratingEvent(
  row: JsonRecord,
  instrument: Instrument,
  dateFrom: string,
  dateTo: string,
): AnalystRatingEvent | undefined {
  const rowSymbol = normalizedSymbol(property(row, "ticker", "symbol"));
  if (rowSymbol && rowSymbol !== instrument.symbol) return undefined;
  const timestamp = instant(property(row, "timestamp", "recommendationTimestamp", "dateTimestamp"));
  const sourceEventDate = parsedCalendarDate(property(row, "recommendationDate", "date", "ratingDate"))
    ?? timestamp?.toISOString().slice(0, 10);
  if (!sourceEventDate || sourceEventDate < dateFrom || sourceEventDate > dateTo) return undefined;

  const analyst = nestedRecord(property(row, "analyst", "expert"));
  const firm = nestedRecord(property(row, "firm", "analystFirm"));
  const analystName = stringValue(
    property(row, "analystName", "expertName"),
    property(analyst, "name", "analystName"),
  );
  const analystFirm = stringValue(
    property(row, "firmName", "analystFirmName"),
    property(firm, "name", "firmName"),
  );
  if (!analystFirm && !analystName) return undefined;

  const rawCurrency = stringValue(
    property(row, "priceTargetCurrencyCode", "currencyCode", "currency"),
  )?.toUpperCase();
  const convertedCurrency = stringValue(
    property(row, "convertedPriceTargetCurrencyCode", "convertedCurrencyCode", "convertedCurrency"),
  )?.toUpperCase();
  const rawTarget = positiveNumber(property(row, "priceTarget", "targetPrice"));
  const convertedTarget = positiveNumber(property(row, "convertedPriceTarget", "priceTargetConverted"));
  const priceTarget = convertedCurrency === "USD" && convertedTarget !== undefined
    ? convertedTarget
    : (!rawCurrency || rawCurrency === "USD")
      ? rawTarget
      : undefined;
  const currency = priceTarget !== undefined ? "USD" : rawCurrency;
  const rating = stringValue(property(row, "recommendation", "rating", "ratingCurrent"));
  const action = stringValue(property(row, "AnalystAction", "analystAction", "action"));
  const analystId = stringValue(
    property(row, "expertUID", "analystUID", "analystId"),
    property(analyst, "uid", "id"),
  );
  const firmId = stringValue(
    property(row, "firmUID", "firmId"),
    property(firm, "uid", "id"),
  );
  const eventTime = timestamp ?? new Date(`${sourceEventDate}T00:00:00.000Z`);
  const sourceId = stringValue(property(row, "uniqueOperationId", "operationId", "id"))
    || [
      instrument.symbol,
      eventTime.toISOString(),
      analystFirm,
      analystName,
      action,
      rating,
      priceTarget,
    ]
      .map((value) => encodeURIComponent(String(value ?? "")))
      .join(":");
  return {
    eventId: `tipranks:${sourceId}`,
    instrumentId: instrument.instrumentId,
    providerId: manifest.id,
    sourceProviderIds: Object.freeze([manifest.id]),
    symbol: instrument.symbol,
    companyName: instrument.name,
    exchange: instrument.exchange,
    currency,
    analystFirm,
    analystName,
    analystId,
    firmId,
    canonicalFirmId: canonicalAnalystFirmId(analystFirm, analystName),
    action,
    actionCompany: action,
    rating,
    ratingCurrent: rating,
    priceTarget,
    effectivePriceTarget: priceTarget,
    analystStarRating: numberValue(property(row, "numOfStars", "stars")),
    analystRank: numberValue(property(row, "analystRank", "rank")),
    overallSuccessRate: numberValue(property(row, "successRate")),
    totalRatings: numberValue(property(row, "totalRecommendations", "totalRatings")),
    sourceEventDate,
    eventTime: eventTime.toISOString(),
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(value)))
    : fallback;
}

function environmentNumber(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeBaseUrl(value: string | undefined) {
  try {
    const url = new URL(value?.trim() || DEFAULT_BASE_URL);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("url");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new TipRanksProviderError("configuration", "TipRanks base URL is invalid.");
  }
}

async function credentialCacheNamespace(apiKey: string, apiToken: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${apiKey}\u0000${apiToken}`),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

class TipRanksClient {
  readonly #apiKey: string;
  readonly #apiToken: string;
  readonly #baseUrl: string;
  readonly #fetch: TipRanksFetch;
  readonly #timeoutMs: number;
  readonly #limit: number;
  readonly #cacheTtlMs: number;
  readonly #now: () => Date;
  readonly #credentialCacheNamespace: Promise<string>;

  constructor(input: Readonly<{
    apiKey: string;
    apiToken: string;
    baseUrl: string;
    fetch: TipRanksFetch;
    timeoutMs: number;
    limit: number;
    cacheTtlMs: number;
    now: () => Date;
  }>) {
    this.#apiKey = input.apiKey;
    this.#apiToken = input.apiToken;
    this.#baseUrl = input.baseUrl;
    this.#fetch = input.fetch;
    this.#timeoutMs = input.timeoutMs;
    this.#limit = input.limit;
    this.#cacheTtlMs = input.cacheTtlMs;
    this.#now = input.now;
    this.#credentialCacheNamespace = credentialCacheNamespace(input.apiKey, input.apiToken);
  }

  get limit() {
    return this.#limit;
  }

  async ratings(
    symbol: string,
    months: number,
    dateFrom: string,
    dateTo: string,
    fresh: boolean,
    signal?: AbortSignal,
  ): Promise<CachedPayload> {
    const normalizedMonths = boundedInteger(months, ANALYST_MERGE_LOOKBACK_MONTHS, 1, MAX_MONTHS);
    const credentialNamespace = await this.#credentialCacheNamespace;
    const cacheKey = [
      credentialNamespace,
      this.#baseUrl,
      symbol,
      normalizedMonths,
      this.#limit,
      dateFrom,
      dateTo,
    ].join("\u0000");
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new TipRanksProviderError("configuration", "TipRanks clock is invalid.");
    }
    if (!fresh) {
      const cached = payloadCache.get(cacheKey);
      if (cached && cached.expiresAt > now.getTime()) return cached;
      const pending = signal === undefined ? payloadInFlight.get(cacheKey) : undefined;
      if (pending) return pending;
    }

    const request = this.#request(symbol, normalizedMonths, now, signal);
    const shareInFlight = !fresh && signal === undefined;
    if (shareInFlight) payloadInFlight.set(cacheKey, request);
    try {
      const result = await request;
      payloadCache.set(cacheKey, result);
      while (payloadCache.size > 256) payloadCache.delete(payloadCache.keys().next().value!);
      return result;
    } finally {
      if (shareInFlight) payloadInFlight.delete(cacheKey);
    }
  }

  async #request(
    symbol: string,
    months: number,
    startedAt: Date,
    signal?: AbortSignal,
  ): Promise<CachedPayload> {
    const url = new URL(`analysts/${encodeURIComponent(symbol)}`, `${this.#baseUrl}/`);
    const query: Readonly<Record<string, QueryValue>> = {
      num: this.#limit,
      sort: "date",
      months,
      includeUnranked: true,
    };
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort();
    signal?.addEventListener("abort", abortFromRequest, { once: true });
    if (signal?.aborted) controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new TipRanksProviderError("timeout", "TipRanks request timed out."));
      }, this.#timeoutMs);
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.#fetch(url, {
            method: "GET",
            redirect: "error",
            headers: {
              Accept: "application/json",
              "X-APIKEY": this.#apiKey,
              "X-APITOKEN": this.#apiToken,
            },
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (error instanceof TipRanksProviderError && error.code === "timeout") throw error;
        if (signal?.aborted) throw new TipRanksProviderError("network", "TipRanks request was aborted.");
        if (controller.signal.aborted) throw new TipRanksProviderError("timeout", "TipRanks request timed out.");
        throw new TipRanksProviderError("network", "TipRanks request failed.");
      }
      if (!response.ok) {
        throw new TipRanksProviderError(
          "upstream",
          `TipRanks request failed with status ${response.status}.`,
          response.status,
        );
      }
      let payload: unknown;
      try {
        payload = await Promise.race([response.json(), timeoutPromise]);
      } catch (error) {
        if (error instanceof TipRanksProviderError && error.code === "timeout") throw error;
        if (signal?.aborted) throw new TipRanksProviderError("network", "TipRanks request was aborted.");
        if (controller.signal.aborted) throw new TipRanksProviderError("timeout", "TipRanks request timed out.");
        throw new TipRanksProviderError("invalid_response", "TipRanks returned invalid JSON.");
      }
      if (!hasRatingsShape(payload)) {
        throw new TipRanksProviderError(
          "invalid_response",
          "TipRanks returned an unexpected response shape.",
        );
      }
      return {
        payload,
        ingestedAt: startedAt.toISOString(),
        expiresAt: startedAt.getTime() + this.#cacheTtlMs,
      };
    } catch (error) {
      if (error instanceof TipRanksProviderError) throw error;
      throw new TipRanksProviderError("network", "TipRanks request failed.");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromRequest);
    }
  }
}

function validDateRange(request: AnalystRatingHistoryRequest) {
  const dateFrom = parsedCalendarDate(request.dateFrom);
  const dateTo = parsedCalendarDate(request.dateTo);
  if (!dateFrom || !dateTo || dateFrom > dateTo) {
    throw new TipRanksProviderError("invalid_request", "TipRanks analyst rating dates are invalid.");
  }
  return { dateFrom, dateTo };
}

function monthsForRange(dateFrom: string, dateTo: string) {
  const [fromYear, fromMonth, fromDay] = dateFrom.split("-").map(Number);
  const [toYear, toMonth, toDay] = dateTo.split("-").map(Number);
  const fullMonthDelta = (toYear! - fromYear!) * 12 + toMonth! - fromMonth!;
  const roundedUp = fullMonthDelta + Number(toDay! > fromDay!);
  return Math.max(1, roundedUp);
}

function subtractCalendarMonths(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year!, month! - 1, 1));
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day!, lastDay));
  return result.toISOString().slice(0, 10);
}

function tipRanksSourceUrl(symbol: string) {
  return `https://www.tipranks.com/stocks/${encodeURIComponent(symbol.toLocaleLowerCase("en-US"))}/forecast`;
}

function historyCoverage(
  events: readonly AnalystRatingEvent[],
  asOf: string,
  truncated: boolean,
  dateFrom: string,
  dateTo: string,
): AnalystMergeCoverage {
  const latestByFirm = new Map<string, AnalystRatingEvent>();
  for (const event of events) {
    const firmId = event.canonicalFirmId;
    if (!firmId) continue;
    const current = latestByFirm.get(firmId);
    if (!current || event.eventTime > current.eventTime) latestByFirm.set(firmId, event);
  }
  const latest = [...latestByFirm.values()];
  const source: AnalystSourceCoverage = {
    providerId: manifest.id,
    status: "available",
    eventCount: events.length,
    firmCount: latest.length,
    ratingCount: latest.filter((event) => Boolean(event.ratingCurrent || event.rating)).length,
    priceTargetCount: latest.filter((event) => (
      typeof event.effectivePriceTarget === "number" && event.effectivePriceTarget > 0
    )).length,
    asOf,
    dateFrom,
    dateTo,
    ...(truncated ? { truncated: true } : {}),
  };
  return {
    status: truncated ? "partial" : "complete",
    sources: Object.freeze([source]),
  };
}

export function createTipRanksProvider(
  env: ProviderEnvironment,
  options: TipRanksProviderOptions = {},
): ProviderAdapter {
  const apiKey = env.TIPRANKS_API_KEY?.trim();
  const apiToken = env.TIPRANKS_API_TOKEN?.trim();
  if (!apiKey || !apiToken) {
    throw new TipRanksProviderError("configuration", "TipRanks credentials are required.");
  }
  const now = options.now || (() => new Date());
  const limit = boundedInteger(
    options.limit ?? environmentNumber(env.TIPRANKS_ANALYST_RATINGS_LIMIT),
    DEFAULT_LIMIT,
    1,
    MAX_LIMIT,
  );
  const configuredTimeoutSeconds = environmentNumber(env.TIPRANKS_TIMEOUT_SECONDS);
  const configuredCacheTtlSeconds = environmentNumber(env.TIPRANKS_CACHE_TTL_SECONDS);
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
  const client = new TipRanksClient({
    apiKey,
    apiToken,
    baseUrl: normalizeBaseUrl(env.TIPRANKS_BASE_URL),
    fetch: options.fetch || globalThis.fetch.bind(globalThis),
    timeoutMs,
    limit,
    cacheTtlMs,
    now,
  });

  const history = async (
    instrument: Instrument,
    request: AnalystRatingHistoryRequest,
    context: ProviderRequestContext,
  ): Promise<AnalystRatingHistory> => {
    const symbol = normalizedSymbol(instrument.symbol);
    if (!symbol || instrument.currency !== "USD" || instrument.listingCountry !== "US") {
      throw new TipRanksProviderError("invalid_request", "A US stock symbol is required.");
    }
    const { dateFrom, dateTo } = validDateRange(request);
    const pageSize = boundedInteger(request.pageSize, client.limit, 1, MAX_LIMIT);
    const providerNow = now();
    if (!Number.isFinite(providerNow.getTime())) {
      throw new TipRanksProviderError("configuration", "TipRanks clock is invalid.");
    }
    const providerDate = newYorkCalendarDate(providerNow);
    const requestedMonths = monthsForRange(dateFrom, providerDate > dateTo ? providerDate : dateTo);
    const loaded = await client.ratings(
      symbol,
      Math.min(requestedMonths, MAX_MONTHS),
      dateFrom,
      dateTo,
      context.fresh === true,
      context.signal,
    );
    if (!hasRatingsShape(loaded.payload)) {
      throw new TipRanksProviderError("invalid_response", "TipRanks returned an unexpected response shape.");
    }
    const rows = recordsFrom(loaded.payload);
    const items = rows
      .map((row) => ratingEvent(row, instrument, dateFrom, dateTo))
      .filter((event): event is AnalystRatingEvent => event !== undefined)
      .sort((left, right) => right.eventTime.localeCompare(left.eventTime))
      .slice(0, pageSize);
    const truncated = requestedMonths > MAX_MONTHS
      || rows.length >= client.limit
      || items.length < rows.length && items.length >= pageSize;
    const asOf = items[0]?.eventTime ?? `${dateTo}T23:59:59.999Z`;
    const provenance: DataProvenance = {
      providerId: manifest.id,
      sourceId: `tipranks:analyst-ratings:${symbol}:${dateFrom}:${dateTo}`,
      sourceUrl: tipRanksSourceUrl(symbol),
      asOf,
      ingestedAt: loaded.ingestedAt,
    };
    return {
      instrumentId: instrument.instrumentId,
      symbol,
      dateFrom,
      dateTo,
      pageSize,
      items: Object.freeze(items),
      consensusLookbackMonths: ANALYST_MERGE_LOOKBACK_MONTHS,
      coverage: historyCoverage(items, asOf, truncated, dateFrom, dateTo),
      sources: Object.freeze([provenance]),
      provenance,
    };
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
          throw new TipRanksProviderError("invalid_request", "TipRanks consensus cutoff is invalid.");
        }
        const dateTo = newYorkCalendarDate(cutoff);
        const dateFrom = subtractCalendarMonths(dateTo, ANALYST_MERGE_LOOKBACK_MONTHS);
        const ratings = await history(
          instrument,
          { dateFrom, dateTo, pageSize: client.limit },
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

export const tipRanksProviderRegistration = {
  manifest,
  create: (env) => createTipRanksProvider(env),
} as const satisfies ProviderRegistration;
