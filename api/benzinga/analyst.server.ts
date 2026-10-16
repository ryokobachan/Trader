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

const DEFAULT_ENDPOINT = "https://www.benzinga.com/api-next/calendar/ratings";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_LOOKBACK_DAYS = 900;
const MAX_PAGE_SIZE = 1_000;
const MAX_LOOKBACK_DAYS = 3_650;
const NEW_YORK_TIME_ZONE = "America/New_York";
const RATINGS_FIELDS = [
  "*",
  "ratings_accuracy.smart_score",
  "ratings_accuracy.overall_success_rate",
  "ratings_accuracy.total_ratings",
].join(",");

type JsonRecord = Record<string, unknown>;
type RatingBucket = "strongBuy" | "buy" | "hold" | "sell" | "strongSell";

export type BenzingaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type BenzingaProviderOptions = Readonly<{
  fetch?: BenzingaFetch;
  now?: () => Date;
  timeoutMs?: number;
  pageSize?: number;
  lookbackDays?: number;
}>;

export type BenzingaProviderErrorCode =
  | "configuration"
  | "invalid_request"
  | "network"
  | "timeout"
  | "upstream"
  | "invalid_response";

/**
 * A deliberately credential-safe error. Request URLs, response bodies,
 * credentials and original network errors are never retained.
 */
export class BenzingaProviderError extends Error {
  readonly code: BenzingaProviderErrorCode;
  readonly status?: number;

  constructor(code: BenzingaProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = "BenzingaProviderError";
    this.code = code;
    this.status = status;
  }
}

const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "benzinga",
  version: "1.1.0",
  displayName: "Benzinga Analyst Ratings",
  capabilities: ["analyst.consensus", "analyst.ratings"],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  // The api-next endpoint currently accepts unauthenticated requests. A token
  // can still be supplied through BENZINGA_API_TOKEN (or legacy API_KEY).
  requiredEnv: [],
} as const;

class BenzingaClient {
  readonly #endpoint: string;
  readonly #fetch: BenzingaFetch;
  readonly #pageSize: number;
  readonly #timeoutMs: number;
  readonly #token?: string;

  constructor(
    endpoint: string,
    fetchImplementation: BenzingaFetch,
    timeoutMs: number,
    pageSize: number,
    token?: string,
  ) {
    this.#endpoint = endpoint;
    this.#fetch = fetchImplementation;
    this.#timeoutMs = timeoutMs;
    this.#pageSize = pageSize;
    this.#token = token;
  }

  sourceUrl(): string {
    return this.#endpoint;
  }

  async getRatings(
    symbol: string,
    dateFrom: string,
    dateTo: string,
    pageSize = this.#pageSize,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(this.#endpoint);
    // Preserve the Midas collector contract as the canonical request shape.
    url.searchParams.set("pagesize", String(pageSize));
    url.searchParams.set("parameters[date_from]", dateFrom);
    url.searchParams.set("parameters[date_to]", dateTo);
    url.searchParams.set("parameters[tickers]", symbol);
    // The current public endpoint honors these aliases while presently
    // ignoring parameters[tickers], so they are sent in addition to—not in
    // place of—the Midas parameters above.
    url.searchParams.set("symbols", symbol);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("fields", RATINGS_FIELDS);
    if (this.#token) url.searchParams.set("token", this.#token);

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort();
    signal?.addEventListener("abort", abortFromRequest, { once: true });
    if (signal?.aborted) controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new BenzingaProviderError("timeout", "Benzinga request timed out."));
      }, this.#timeoutMs);
    });

    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.#fetch(url, {
            method: "GET",
            // Cloudflare's fetch supports manual redirect handling rather
            // than `redirect: "error"`; the status check below rejects 3xx.
            redirect: "manual",
            // Keep the acquisition request aligned with Midas' collector.
            headers: {
              Accept: "application/json",
              "User-Agent": "midas/benzinga-analyst-ratings",
            },
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (error instanceof BenzingaProviderError && error.code === "timeout") throw error;
        if (signal?.aborted) {
          throw new BenzingaProviderError("network", "Benzinga request was aborted.");
        }
        if (controller.signal.aborted) {
          throw new BenzingaProviderError("timeout", "Benzinga request timed out.");
        }
        throw new BenzingaProviderError("network", "Benzinga request failed.");
      }
      if (!response.ok) {
        throw new BenzingaProviderError(
          "upstream",
          `Benzinga request failed with status ${response.status}.`,
          response.status,
        );
      }
      try {
        const payload = await Promise.race([response.json(), timeoutPromise]);
        if (!hasRatingsShape(payload)) {
          throw new BenzingaProviderError(
            "invalid_response",
            "Benzinga returned an unexpected response shape.",
          );
        }
        return payload;
      } catch (error) {
        if (error instanceof BenzingaProviderError) throw error;
        if (signal?.aborted) {
          throw new BenzingaProviderError("network", "Benzinga request was aborted.");
        }
        if (controller.signal.aborted) {
          throw new BenzingaProviderError("timeout", "Benzinga request timed out.");
        }
        throw new BenzingaProviderError(
          "invalid_response",
          "Benzinga returned an invalid response.",
        );
      }
    } catch (error) {
      if (error instanceof BenzingaProviderError) throw error;
      throw new BenzingaProviderError("network", "Benzinga request failed.");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromRequest);
    }
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RATING_ENVELOPE_KEYS = ["data", "ratings", "results"] as const;
const RATING_ROW_IDENTITY_KEYS = [
  "id",
  "ticker",
  "analyst",
  "analyst_name",
  "firm_id",
  "analyst_id",
  "rating_current",
  "rating_prior",
  "pt_current",
  "pt_prior",
] as const;

function hasOwn(record: JsonRecord, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRatingRecord(value: unknown): value is JsonRecord {
  if (!isRecord(value) || !(hasOwn(value, "date") || hasOwn(value, "updated"))) return false;
  return RATING_ROW_IDENTITY_KEYS.some((key) => hasOwn(value, key));
}

function isRatingsArray(value: unknown): value is JsonRecord[] {
  return Array.isArray(value)
    && (value.length === 0 || value.some((item) => isRatingRecord(item)));
}

/** Accept only the documented row array or reviewed one/two-level envelopes. */
function hasRatingsShape(value: unknown): boolean {
  if (isRatingsArray(value) || isRatingRecord(value)) return true;
  if (!isRecord(value)) return false;

  for (const key of RATING_ENVELOPE_KEYS) {
    if (!hasOwn(value, key)) continue;
    const nested = value[key];
    if (isRatingsArray(nested)) return true;
    if (!isRecord(nested)) continue;
    for (const nestedKey of RATING_ENVELOPE_KEYS) {
      if (hasOwn(nested, nestedKey) && isRatingsArray(nested[nestedKey])) return true;
    }
  }
  return false;
}

function recordsFrom(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];

  for (const key of RATING_ENVELOPE_KEYS) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
    if (isRecord(nested)) {
      for (const nestedKey of RATING_ENVELOPE_KEYS) {
        const rows = nested[nestedKey];
        if (Array.isArray(rows)) return rows.filter(isRecord);
      }
    }
  }

  return value.date || value.updated ? [value] : [];
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
    if (typeof value !== "string" || !value.trim()) continue;
    const parsed = Number(value.trim().replaceAll(",", "").replace(/^\$/, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function positiveNumber(...values: unknown[]): number | undefined {
  const value = numberValue(...values);
  return value !== undefined && value > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  const numeric = numberValue(value);
  return numeric === undefined ? undefined : Math.trunc(numeric);
}

function normalizedSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const symbol = value.normalize("NFKC").trim().toUpperCase().replace(/[./]/g, "-");
  return /^[A-Z][A-Z0-9-]{0,14}$/.test(symbol) ? symbol : null;
}

function parsedDate(value: unknown): Readonly<{
  year: number;
  month: number;
  day: number;
}> | null {
  const text = stringValue(value);
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function parsedClock(value: unknown): Readonly<{
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}> | null {
  const text = stringValue(value);
  if (!text) return null;
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const millisecond = Number((match[4] || "0").padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second, millisecond };
}

const newYorkFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NEW_YORK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function newYorkParts(milliseconds: number): Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}> | null {
  const values: Record<string, number> = {};
  for (const part of newYorkFormatter.formatToParts(new Date(milliseconds))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  if (["year", "month", "day", "hour", "minute", "second"]
    .some((key) => !Number.isFinite(values[key]))) return null;
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function newYorkDateTime(
  date: NonNullable<ReturnType<typeof parsedDate>>,
  clock: NonNullable<ReturnType<typeof parsedClock>>,
): Date | null {
  const desiredLocal = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    clock.hour,
    clock.minute,
    clock.second,
    clock.millisecond,
  );
  let candidate = desiredLocal;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const observed = newYorkParts(candidate);
    if (!observed) return null;
    const observedLocal = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
      clock.millisecond,
    );
    candidate += desiredLocal - observedLocal;
  }
  const finalParts = newYorkParts(candidate);
  if (
    !finalParts
    || finalParts.year !== date.year
    || finalParts.month !== date.month
    || finalParts.day !== date.day
    || finalParts.hour !== clock.hour
    || finalParts.minute !== clock.minute
    || finalParts.second !== clock.second
  ) return null;
  const result = new Date(candidate);
  return Number.isFinite(result.getTime()) ? result : null;
}

function unixDate(value: unknown): Date | null {
  const numeric = numberValue(value);
  if (numeric === undefined || numeric <= 0) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  const result = new Date(milliseconds);
  return Number.isFinite(result.getTime()) ? result : null;
}

function sourceEventDate(row: JsonRecord): Date | null {
  const date = parsedDate(row.date);
  if (!date) return null;
  const suppliedClock = stringValue(row.time);
  if (suppliedClock) {
    const clock = parsedClock(suppliedClock);
    if (clock) return newYorkDateTime(date, clock);
  }
  return newYorkDateTime(date, { hour: 0, minute: 0, second: 0, millisecond: 0 });
}

function parseInstant(value: string | undefined): Date | null {
  if (!value?.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizedIdentity(value: unknown): string | undefined {
  return stringValue(value)?.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function identityKey(row: JsonRecord): string | null {
  const firm = normalizedIdentity(row.firm_id) || normalizedIdentity(row.analyst);
  const analyst = normalizedIdentity(row.analyst_id) || normalizedIdentity(row.analyst_name);
  if (!firm && !analyst) return null;
  return `${firm || "unknown-firm"}\u0000${analyst || "firm-level"}`;
}

function normalizedRating(value: unknown): string | undefined {
  return stringValue(value)
    ?.normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[-‐‑‒–—−_/]+/g, " ")
    .replace(/\s+/g, " ");
}

function ratingBucket(value: unknown): RatingBucket | undefined {
  const rating = normalizedRating(value);
  if (!rating) return undefined;
  const aliases: Readonly<Record<string, RatingBucket>> = {
    "strong buy": "strongBuy",
    buy: "buy",
    outperform: "buy",
    overweight: "buy",
    "market outperform": "buy",
    "sector outperform": "buy",
    positive: "buy",
    accumulate: "buy",
    hold: "hold",
    neutral: "hold",
    "equal weight": "hold",
    "market perform": "hold",
    "sector perform": "hold",
    "sector weight": "hold",
    "in line": "hold",
    "peer perform": "hold",
    sell: "sell",
    underperform: "sell",
    underweight: "sell",
    "market underperform": "sell",
    "sector underperform": "sell",
    negative: "sell",
    reduce: "sell",
    "strong sell": "strongSell",
  };
  return aliases[rating];
}

type NormalizedEvent = Readonly<{
  identity?: string;
  sourceId: string;
  symbol: string;
  companyName?: string;
  exchange?: string;
  currency?: string;
  cusip?: string;
  isin?: string;
  analystFirm?: string;
  analystName?: string;
  analystId?: string;
  firmId?: string;
  action?: string;
  actionCompany?: string;
  actionPriceTarget?: string;
  rating?: string;
  ratingCurrent?: string;
  ratingPrior?: string;
  priceTarget?: number;
  previousPriceTarget?: number;
  adjustedPriceTarget?: number;
  adjustedPreviousPriceTarget?: number;
  priceTargetPercentChange?: number;
  importance?: number;
  smartScore?: number;
  overallSuccessRate?: number;
  totalRatings?: number;
  sourceEventDate: string;
  eventTime: Date;
  updatedTime: Date | null;
  url?: string;
  calendarUrl?: string;
  newsUrl?: string;
  target?: number;
  ratingCategory?: RatingBucket;
}>;

function normalizedEvent(
  row: JsonRecord,
  requestedSymbol: string,
  oldestAllowed: number,
  cutoff: number,
  rejectLateUpdates = true,
): NormalizedEvent | null {
  const symbol = normalizedSymbol(row.ticker ?? row.symbol ?? requestedSymbol);
  if (symbol !== requestedSymbol) return null;
  const identity = identityKey(row);
  const eventDate = parsedDate(row.date);
  const eventTime = sourceEventDate(row);
  if (!eventDate || !eventTime) return null;
  const eventMilliseconds = eventTime.getTime();
  const updatedTime = unixDate(row.updated);
  if (
    eventMilliseconds < oldestAllowed
    || eventMilliseconds > cutoff
    || (rejectLateUpdates && updatedTime && updatedTime.getTime() > cutoff)
  ) return null;

  const analystFirm = stringValue(row.analyst);
  const analystName = stringValue(row.analyst_name);
  const analystId = stringValue(row.analyst_id);
  const firmId = stringValue(row.firm_id);
  const actionCompany = stringValue(row.action_company);
  const actionPriceTarget = stringValue(row.action_pt);
  const ratingCurrent = stringValue(row.rating_current);
  const currency = stringValue(row.currency)?.toUpperCase();
  // Benzinga sometimes mixes non-USD target events into a U.S. ticker feed.
  // Keep the rating event, but never relabel an explicitly non-USD target as USD.
  // A missing currency inherits the requested U.S. instrument's USD contract.
  const targetsAreUsd = !currency || currency === "USD";
  const priceTarget = targetsAreUsd ? positiveNumber(row.pt_current) : undefined;
  const previousPriceTarget = targetsAreUsd ? positiveNumber(row.pt_prior) : undefined;
  const adjustedPriceTarget = targetsAreUsd ? positiveNumber(row.adjusted_pt_current) : undefined;
  const adjustedPreviousPriceTarget = targetsAreUsd ? positiveNumber(row.adjusted_pt_prior) : undefined;
  const ratingsAccuracy = isRecord(row.ratings_accuracy) ? row.ratings_accuracy : {};
  const target = positiveNumber(adjustedPriceTarget) ?? positiveNumber(priceTarget);
  return {
    identity: identity ?? undefined,
    sourceId: stringValue(row.id) || [
      "benzinga",
      requestedSymbol,
      eventTime.toISOString(),
      stringValue(row.analyst),
      stringValue(row.analyst_name),
      ratingCurrent,
      priceTarget,
      previousPriceTarget,
    ].map((value) => encodeURIComponent(String(value ?? ""))).join(":"),
    symbol,
    companyName: stringValue(row.name),
    exchange: stringValue(row.exchange),
    currency,
    cusip: stringValue(row.cusip),
    isin: stringValue(row.isin),
    analystFirm,
    analystName,
    analystId,
    firmId,
    action: [actionCompany, actionPriceTarget].filter(Boolean).join(" / ") || undefined,
    actionCompany,
    actionPriceTarget,
    rating: ratingCurrent,
    ratingCurrent,
    ratingPrior: stringValue(row.rating_prior),
    priceTarget,
    previousPriceTarget,
    adjustedPriceTarget,
    adjustedPreviousPriceTarget,
    priceTargetPercentChange: numberValue(row.pt_pct_change),
    importance: integerValue(row.importance),
    smartScore: numberValue(ratingsAccuracy.smart_score),
    overallSuccessRate: numberValue(ratingsAccuracy.overall_success_rate),
    totalRatings: integerValue(ratingsAccuracy.total_ratings),
    sourceEventDate: [
      eventDate.year.toString().padStart(4, "0"),
      eventDate.month.toString().padStart(2, "0"),
      eventDate.day.toString().padStart(2, "0"),
    ].join("-"),
    eventTime,
    updatedTime,
    url: stringValue(row.url),
    calendarUrl: stringValue(row.url_calendar),
    newsUrl: stringValue(row.url_news),
    target,
    ratingCategory: ratingBucket(ratingCurrent),
  };
}

function isNewer(left: NormalizedEvent, right: NormalizedEvent): boolean {
  const eventDifference = left.eventTime.getTime() - right.eventTime.getTime();
  if (eventDifference !== 0) return eventDifference > 0;
  const updateDifference = (left.updatedTime?.getTime() || 0) - (right.updatedTime?.getTime() || 0);
  if (updateDifference !== 0) return updateDifference > 0;
  return left.sourceId.localeCompare(right.sourceId) > 0;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function provenance(
  client: BenzingaClient,
  symbol: string,
  asOf: string,
  ingestedAt: string,
): DataProvenance {
  return {
    providerId: manifest.id,
    sourceId: `benzinga:analyst-consensus:${symbol}`,
    sourceUrl: client.sourceUrl(),
    asOf,
    ingestedAt,
  };
}

function historyProvenance(
  client: BenzingaClient,
  symbol: string,
  dateFrom: string,
  dateTo: string,
  asOf: string,
  ingestedAt: string,
): DataProvenance {
  return {
    providerId: manifest.id,
    sourceId: `benzinga:analyst-ratings:${symbol}:${dateFrom}:${dateTo}`,
    // sourceUrl is deliberately query-free so a token can never reach the DTO.
    sourceUrl: client.sourceUrl(),
    asOf,
    ingestedAt,
  };
}

function analystRatingEvent(
  event: NormalizedEvent,
  instrumentId: string,
): AnalystRatingEvent {
  return {
    eventId: event.sourceId,
    instrumentId,
    providerId: manifest.id,
    sourceProviderIds: Object.freeze([manifest.id]),
    symbol: event.symbol,
    companyName: event.companyName,
    exchange: event.exchange,
    currency: event.currency,
    cusip: event.cusip,
    isin: event.isin,
    analystFirm: event.analystFirm,
    analystName: event.analystName,
    analystId: event.analystId,
    firmId: event.firmId,
    action: event.action,
    actionCompany: event.actionCompany,
    actionPriceTarget: event.actionPriceTarget,
    rating: event.rating,
    ratingCurrent: event.ratingCurrent,
    ratingPrior: event.ratingPrior,
    priceTarget: event.priceTarget,
    previousPriceTarget: event.previousPriceTarget,
    adjustedPriceTarget: event.adjustedPriceTarget,
    adjustedPreviousPriceTarget: event.adjustedPreviousPriceTarget,
    effectivePriceTarget: event.target,
    priceTargetPercentChange: event.priceTargetPercentChange,
    importance: event.importance,
    smartScore: event.smartScore,
    overallSuccessRate: event.overallSuccessRate,
    totalRatings: event.totalRatings,
    sourceEventDate: event.sourceEventDate,
    eventTime: event.eventTime.toISOString(),
    updatedAt: event.updatedTime?.toISOString(),
  };
}

function nextCalendarDate(value: NonNullable<ReturnType<typeof parsedDate>>) {
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function historyDateBounds(request: AnalystRatingHistoryRequest): Readonly<{
  dateFrom: string;
  dateTo: string;
  oldestAllowed: number;
  cutoff: number;
}> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.dateFrom)
    || !/^\d{4}-\d{2}-\d{2}$/.test(request.dateTo)) {
    throw new BenzingaProviderError("invalid_request", "Analyst rating dates are invalid.");
  }
  const from = parsedDate(request.dateFrom);
  const to = parsedDate(request.dateTo);
  if (!from || !to || request.dateFrom > request.dateTo) {
    throw new BenzingaProviderError("invalid_request", "Analyst rating date range is invalid.");
  }
  const calendarSpan = Date.UTC(to.year, to.month - 1, to.day)
    - Date.UTC(from.year, from.month - 1, from.day);
  if (calendarSpan > MAX_LOOKBACK_DAYS * 86_400_000) {
    throw new BenzingaProviderError("invalid_request", "Analyst rating date range is too large.");
  }
  const oldestAllowed = newYorkDateTime(from, {
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  })?.getTime();
  const exclusiveEnd = newYorkDateTime(nextCalendarDate(to), {
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  })?.getTime();
  if (oldestAllowed === undefined || exclusiveEnd === undefined || oldestAllowed >= exclusiveEnd) {
    throw new BenzingaProviderError("invalid_request", "Analyst rating date range is invalid.");
  }
  return {
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    oldestAllowed,
    cutoff: exclusiveEnd - 1,
  };
}

function normalizeEndpoint(value: string | undefined): string {
  try {
    const endpoint = new URL(value?.trim() || DEFAULT_ENDPOINT);
    if (!(["https:", "http:"].includes(endpoint.protocol))) throw new Error("protocol");
    if (endpoint.username || endpoint.password) throw new Error("credentials");
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString();
  } catch {
    throw new BenzingaProviderError(
      "configuration",
      "Benzinga provider endpoint is invalid.",
    );
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(value)))
    : fallback;
}

function timeoutMs(env: ProviderEnvironment, override: number | undefined): number {
  if (override !== undefined) return boundedInteger(override, DEFAULT_TIMEOUT_MS, 1, 60_000);
  const seconds = numberValue(env.BENZINGA_TIMEOUT_SECONDS);
  return seconds === undefined
    ? DEFAULT_TIMEOUT_MS
    : boundedInteger(seconds * 1_000, DEFAULT_TIMEOUT_MS, 1, 60_000);
}

function disabled(env: ProviderEnvironment): boolean {
  return ["1", "true", "yes", "on"].includes(
    env.BENZINGA_ANALYST_RATINGS_DISABLED?.trim().toLowerCase() || "",
  );
}

export function createBenzingaProvider(
  env: ProviderEnvironment,
  options: BenzingaProviderOptions = {},
): ProviderAdapter {
  if (disabled(env)) {
    throw new BenzingaProviderError("configuration", "Benzinga provider is disabled.");
  }

  const now = options.now || (() => new Date());
  const pageSize = boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const lookbackDays = boundedInteger(
    options.lookbackDays,
    DEFAULT_LOOKBACK_DAYS,
    1,
    MAX_LOOKBACK_DAYS,
  );
  const token = env.BENZINGA_API_TOKEN?.trim() || env.BENZINGA_API_KEY?.trim();
  const client = new BenzingaClient(
    normalizeEndpoint(env.BENZINGA_ANALYST_RATINGS_ENDPOINT),
    options.fetch || globalThis.fetch.bind(globalThis),
    timeoutMs(env, options.timeoutMs),
    pageSize,
    token,
  );

  const adapter: ProviderAdapter = {
    manifest,
    analyst: {
      getConsensus: async (
        instrument: Instrument,
        context: ProviderRequestContext,
      ): Promise<AnalystConsensus | null> => {
        const symbol = normalizedSymbol(instrument.symbol);
        if (!symbol || instrument.currency !== "USD" || instrument.listingCountry !== "US") {
          return null;
        }

        const ingestedAtDate = now();
        if (!Number.isFinite(ingestedAtDate.getTime())) {
          throw new BenzingaProviderError("configuration", "Benzinga clock is invalid.");
        }
        const ingestedAt = ingestedAtDate.toISOString();
        const cutoffDate = parseInstant(context.asOf) || ingestedAtDate;
        const cutoff = cutoffDate.getTime();
        const oldestAllowed = cutoff - lookbackDays * 86_400_000;
        const rows = recordsFrom(await client.getRatings(
          symbol,
          new Date(oldestAllowed).toISOString().slice(0, 10),
          cutoffDate.toISOString().slice(0, 10),
          undefined,
          context.signal,
        ));
        const latestByAnalystFirm = new Map<string, NormalizedEvent>();
        for (const row of rows) {
          const event = normalizedEvent(row, symbol, oldestAllowed, cutoff);
          if (!event?.identity) continue;
          const current = latestByAnalystFirm.get(event.identity);
          if (!current || isNewer(event, current)) {
            latestByAnalystFirm.set(event.identity, event);
          }
        }

        const eligible = [...latestByAnalystFirm.values()].filter(
          (event): event is NormalizedEvent & { target: number } => (
            (!event.currency || event.currency === "USD") && event.target !== undefined
          ),
        );
        if (eligible.length === 0) return null;

        const targets = eligible.map((event) => event.target);
        const counts: Record<RatingBucket, number> = {
          strongBuy: 0,
          buy: 0,
          hold: 0,
          sell: 0,
          strongSell: 0,
        };
        let mappedRatings = 0;
        for (const event of eligible) {
          if (!event.ratingCategory) continue;
          counts[event.ratingCategory] += 1;
          mappedRatings += 1;
        }

        const latestAsOf = eligible.reduce(
          (latest, event) => Math.max(latest, event.eventTime.getTime()),
          0,
        );
        return {
          instrumentId: instrument.instrumentId,
          targetLow: Math.min(...targets),
          targetHigh: Math.max(...targets),
          targetConsensus: targets.reduce((sum, target) => sum + target, 0) / targets.length,
          targetMedian: median(targets),
          analystCount: eligible.length,
          ...(mappedRatings > 0 ? counts : {}),
          provenance: provenance(
            client,
            symbol,
            new Date(latestAsOf).toISOString(),
            ingestedAt,
          ),
        };
      },
      getRatingHistory: async (
        instrument: Instrument,
        request: AnalystRatingHistoryRequest,
        context: ProviderRequestContext,
      ): Promise<AnalystRatingHistory> => {
        const symbol = normalizedSymbol(instrument.symbol);
        if (!symbol || instrument.currency !== "USD" || instrument.listingCountry !== "US") {
          throw new BenzingaProviderError("invalid_request", "A US stock symbol is required.");
        }
        const bounds = historyDateBounds(request);
        const effectivePageSize = boundedInteger(
          request.pageSize,
          pageSize,
          1,
          MAX_PAGE_SIZE,
        );
        const ingestedAtDate = now();
        if (!Number.isFinite(ingestedAtDate.getTime())) {
          throw new BenzingaProviderError("configuration", "Benzinga clock is invalid.");
        }
        const ingestedAt = ingestedAtDate.toISOString();
        const rows = recordsFrom(await client.getRatings(
          symbol,
          bounds.dateFrom,
          bounds.dateTo,
          effectivePageSize,
          context.signal,
        ));
        const byEventId = new Map<string, NormalizedEvent>();
        for (const row of rows) {
          // Midas stores the complete event stream; analyst identity and a
          // later Benzinga update are not prerequisites for history display.
          const event = normalizedEvent(
            row,
            symbol,
            bounds.oldestAllowed,
            bounds.cutoff,
            false,
          );
          if (!event) continue;
          const existing = byEventId.get(event.sourceId);
          if (!existing || isNewer(event, existing)) byEventId.set(event.sourceId, event);
        }
        const normalized = [...byEventId.values()]
          .sort((left, right) => (
            right.eventTime.getTime() - left.eventTime.getTime()
            || right.sourceId.localeCompare(left.sourceId)
          ));
        const items = normalized.map((event) => analystRatingEvent(event, instrument.instrumentId));
        const asOf = normalized[0]?.eventTime.toISOString()
          || new Date(bounds.cutoff).toISOString();
        const latestByFirm = new Map<string, NormalizedEvent>();
        for (const event of normalized) {
          const firmKey = normalizedIdentity(event.analystFirm)
            || normalizedIdentity(event.analystName);
          if (!firmKey) continue;
          const current = latestByFirm.get(firmKey);
          if (!current || isNewer(event, current)) latestByFirm.set(firmKey, event);
        }
        const latestFirmEvents = [...latestByFirm.values()];
        const truncated = rows.length >= effectivePageSize;
        const sourceProvenance = historyProvenance(
          client,
          symbol,
          bounds.dateFrom,
          bounds.dateTo,
          asOf,
          ingestedAt,
        );
        return {
          instrumentId: instrument.instrumentId,
          symbol,
          dateFrom: bounds.dateFrom,
          dateTo: bounds.dateTo,
          pageSize: effectivePageSize,
          items,
          coverage: {
            status: truncated ? "partial" : "complete",
            sources: Object.freeze([{
              providerId: manifest.id,
              status: "available",
              eventCount: normalized.length,
              firmCount: latestFirmEvents.length,
              ratingCount: latestFirmEvents.filter((event) => Boolean(event.rating)).length,
              priceTargetCount: latestFirmEvents.filter((event) => (
                (!event.currency || event.currency === "USD") && event.target !== undefined
              )).length,
              asOf,
              dateFrom: bounds.dateFrom,
              dateTo: bounds.dateTo,
              ...(truncated ? { truncated: true } : {}),
            }]),
          },
          sources: Object.freeze([sourceProvenance]),
          provenance: sourceProvenance,
        };
      },
    },
  };

  return Object.freeze(adapter);
}

export const benzingaProviderRegistration = {
  manifest,
  create: (env) => createBenzingaProvider(env),
} as const satisfies ProviderRegistration;
