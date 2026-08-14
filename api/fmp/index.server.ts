import {
  PROVIDER_SCHEMA_VERSION,
  type AnalystConsensus,
  type CompanyNewsItem,
  type CompanyProfile,
  type DataProvenance,
  type EarningsEvent,
  type FinancialHealthSnapshot,
  type FundamentalsSnapshot,
  type Instrument,
  type MarketBarInterval,
  type MarketBarRange,
  type MarketBars,
  type ProviderAdapter,
  type ProviderEnvironment,
  type ProviderRegistration,
  type ProviderRequestContext,
  type Quote,
  type ShareStructureSnapshot,
} from "@/app/platform/provider-contracts";
import { aggregateMarketBars } from "@/app/platform/market-bar-aggregation";
import { companyLogoPathForUSStock } from "@/app/platform/company-logo";

const DEFAULT_BASE_URL = "https://financialmodelingprep.com/stable";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_SEARCH_LIMIT = 50;

type JsonRecord = Record<string, unknown>;
type QueryValue = string | number | boolean | null | undefined;

export type FmpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FmpProviderOptions = Readonly<{
  fetch?: FmpFetch;
  now?: () => Date;
  timeoutMs?: number;
}>;

export type FmpProviderErrorCode =
  | "configuration"
  | "network"
  | "timeout"
  | "upstream"
  | "invalid_response";

/**
 * An intentionally small error surface. It never stores the request URL,
 * credentials, response body, or the original network error.
 */
export class FmpProviderError extends Error {
  readonly code: FmpProviderErrorCode;
  readonly status?: number;

  constructor(code: FmpProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = "FmpProviderError";
    this.code = code;
    this.status = status;
  }
}

const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "fmp",
  version: "1.0.0",
  displayName: "Financial Modeling Prep",
  capabilities: [
    "instrument.search",
    "instrument.identity",
    "market.quote",
    "market.bars",
    "fundamentals.profile",
    "fundamentals.normalized",
    "fundamentals.earnings",
    "analyst.consensus",
    "news.company",
  ],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: ["FMP_API_KEY"],
} as const;

class FmpClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FmpFetch;
  readonly #timeoutMs: number;

  constructor(
    apiKey: string,
    baseUrl: string,
    fetchImplementation: FmpFetch,
    timeoutMs: number,
  ) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImplementation;
    this.#timeoutMs = timeoutMs;
  }

  sourceUrl(path: string): string {
    return this.#urlFor(path).toString();
  }

  async get(path: string, query: Readonly<Record<string, QueryValue>> = {}): Promise<unknown> {
    const url = this.#urlFor(path);
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(name, String(value));
      }
    }
    params.set("apikey", this.#apiKey);
    url.search = params.toString();

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new FmpProviderError("timeout", "FMP request timed out."));
      }, this.#timeoutMs);
    });
    let response: Response;
    try {
      response = await Promise.race([
        this.#fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof FmpProviderError && error.code === "timeout") throw error;
      if (controller.signal.aborted) {
        throw new FmpProviderError("timeout", "FMP request timed out.");
      }
      throw new FmpProviderError("network", "FMP request failed.");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new FmpProviderError(
        "upstream",
        `FMP request failed with status ${response.status}.`,
        response.status,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new FmpProviderError("invalid_response", "FMP returned an invalid response.");
    }
  }

  #urlFor(path: string): URL {
    return new URL(path.replace(/^\/+/, ""), `${this.#baseUrl}/`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsFrom(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) return [];
  for (const key of ["historical", "results", "data"]) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  if (value.symbol || value.companyName || value.date) return [value];
  return [];
}

function firstRecord(value: unknown): JsonRecord | undefined {
  return recordsFrom(value)[0];
}

function recordForSymbol(value: unknown, expectedSymbol: string): JsonRecord | undefined {
  return recordsFrom(value).find((record) => normalizedSymbol(record.symbol) === expectedSymbol);
}

function strictNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strictInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const parsed = strictNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
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
      const parsed = Number(value.replaceAll(",", ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function positiveNumber(...values: unknown[]): number | undefined {
  const value = numberValue(...values);
  return value !== undefined && value > 0 ? value : undefined;
}

function validOhlcv(
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): boolean {
  return open > 0
    && high > 0
    && low > 0
    && close > 0
    && volume >= 0
    && high >= Math.max(open, close, low)
    && low <= Math.min(open, close, high);
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "active"].includes(normalized)) return true;
  if (["false", "0", "no", "inactive"].includes(normalized)) return false;
  return undefined;
}

function normalizedSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const symbol = value.normalize("NFKC").trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) ? symbol : null;
}

function isoDateTime(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
      const parsed = new Date(milliseconds);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    const trimmed = value.trim();
    const candidate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
      ? `${trimmed}T00:00:00.000Z`
      : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(trimmed)
        ? `${trimmed.replace(" ", "T")}Z`
        : trimmed;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function safeHttpUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = stringValue(value);
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
    } catch {
      // Try the next upstream alias rather than rejecting the whole record.
    }
  }
  return undefined;
}

function normalizeBaseUrl(value: string | undefined): string {
  try {
    const url = new URL(value?.trim() || DEFAULT_BASE_URL);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error("unsupported");
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new FmpProviderError("configuration", "FMP provider configuration is invalid.");
  }
}

function normalizedTimeout(env: ProviderEnvironment, override?: number): number {
  if (override !== undefined && Number.isFinite(override)) {
    return Math.min(60_000, Math.max(1, Math.trunc(override)));
  }
  const seconds = numberValue(env.FMP_TIMEOUT_SECONDS);
  if (seconds === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(60_000, Math.max(1_000, Math.trunc(seconds * 1000)));
}

function usageIsExplicitlyAllowed(env: ProviderEnvironment): boolean {
  const usageMode = env.UNICORN_USAGE_MODE?.trim().toLowerCase();
  return usageMode === "personal"
    || booleanValue(env.UNICORN_ALLOW_RESTRICTED_PUBLIC_DISPLAY) === true;
}

function usCountry(value: unknown): boolean {
  const country = stringValue(value)?.toUpperCase().replaceAll(".", "");
  return country === "US"
    || country === "USA"
    || country === "UNITED STATES"
    || country === "UNITED STATES OF AMERICA";
}

const US_LISTING_EXCHANGES = new Set([
  "AMEX",
  "ARCA",
  "BATS",
  "CBOE",
  "NASDAQ",
  "NASDAQ CAPITAL MARKET",
  "NASDAQ GLOBAL MARKET",
  "NASDAQ GLOBAL SELECT",
  "NASDAQ GLOBAL SELECT MARKET",
  "NASDAQCM",
  "NASDAQGM",
  "NASDAQGS",
  "NEW YORK STOCK EXCHANGE",
  "NYSE",
  "NYSE AMERICAN",
  "NYSE ARCA",
  "NYSE MKT",
  "NYSEARCA",
]);

function normalizedExchangeName(value: string): string {
  return value.toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

function isUsListingExchange(value: string): boolean {
  return US_LISTING_EXCHANGES.has(normalizedExchangeName(value));
}

function exchangeMic(value: string): string {
  const exchange = value.toUpperCase();
  if (exchange.includes("NASDAQ")) return "XNAS";
  if (exchange.includes("NYSE ARCA") || exchange === "ARCA") return "ARCX";
  if (exchange.includes("NYSE") || exchange === "NEW YORK STOCK EXCHANGE") return "XNYS";
  if (exchange.includes("AMEX") || exchange.includes("AMERICAN")) return "XASE";
  if (exchange.includes("CBOE") || exchange.includes("BATS")) return "BATS";
  return exchange.replace(/[^A-Z0-9]/g, "").slice(0, 8) || "US";
}

function assetTypeFromProfile(profile: JsonRecord): Instrument["assetType"] | null {
  if (
    booleanValue(profile.isEtf) === true
    || booleanValue(profile.isETF) === true
    || booleanValue(profile.isFund) === true
  ) return null;
  const descriptor = [profile.type, profile.assetType, profile.securityType]
    .map((value) => stringValue(value)?.toUpperCase() || "")
    .join(" ");
  if (/\b(?:ETF|FUND|MUTUAL FUND)\b/.test(descriptor)) return null;
  if (
    booleanValue(profile.isAdr) === true
    || booleanValue(profile.isADR) === true
    || /\bADR\b|DEPOSITARY/.test(descriptor)
  ) {
    return "adr";
  }
  return "common_stock";
}

/** FMP uses hyphens for U.S. share classes even when users enter a dot. */
function normalizedFmpListedSymbol(value: unknown): string | null {
  return normalizedSymbol(value)?.replaceAll(".", "-") ?? null;
}

function sourceAsOf(context: ProviderRequestContext, fallback: string): string {
  return isoDateTime(context.asOf) || fallback;
}

function provenance(
  client: FmpClient,
  sourceId: string,
  sourcePath: string,
  asOf: string,
  ingestedAt: string,
): DataProvenance {
  return {
    providerId: manifest.id,
    sourceId,
    sourceUrl: client.sourceUrl(sourcePath),
    asOf,
    ingestedAt,
  };
}

function shareStructureFromPayload(
  payload: unknown,
  instrument: Instrument,
  context: ProviderRequestContext,
  client: FmpClient,
  ingestedAt: string,
): ShareStructureSnapshot | null {
  const record = recordForSymbol(payload, instrument.symbol);
  if (!record) return null;
  const freeFloatPercent = strictNumber(record.freeFloat);
  const freeFloatRatio = freeFloatPercent !== undefined
    && freeFloatPercent >= 0
    && freeFloatPercent <= 100
    ? freeFloatPercent / 100
    : undefined;
  const outstandingShares = strictInteger(record.outstandingShares, 1);
  const candidateFloatShares = strictInteger(record.floatShares, 0);
  const floatShares = candidateFloatShares !== undefined
    && (outstandingShares === undefined || candidateFloatShares <= outstandingShares)
    ? candidateFloatShares
    : undefined;
  if (freeFloatRatio === undefined && floatShares === undefined && outstandingShares === undefined) return null;
  return {
    ...(freeFloatRatio === undefined ? {} : { freeFloatRatio }),
    ...(floatShares === undefined ? {} : { floatShares }),
    ...(outstandingShares === undefined ? {} : { outstandingShares }),
    provenance: provenance(
      client,
      `fmp:shares-float:${instrument.symbol}`,
      "shares-float",
      isoDateTime(record.date) || sourceAsOf(context, ingestedAt),
      ingestedAt,
    ),
  };
}

function financialHealthFromPayload(
  payload: unknown,
  instrument: Instrument,
  context: ProviderRequestContext,
  client: FmpClient,
  ingestedAt: string,
): FinancialHealthSnapshot | null {
  const record = recordForSymbol(payload, instrument.symbol);
  if (!record) return null;
  const altmanZScore = strictNumber(record.altmanZScore);
  const piotroskiScore = strictInteger(record.piotroskiScore, 0, 9);
  if (altmanZScore === undefined && piotroskiScore === undefined) return null;
  return {
    ...(altmanZScore === undefined ? {} : { altmanZScore }),
    ...(piotroskiScore === undefined ? {} : { piotroskiScore }),
    provenance: provenance(
      client,
      `fmp:financial-scores:${instrument.symbol}`,
      "financial-scores",
      sourceAsOf(context, ingestedAt),
      ingestedAt,
    ),
  };
}

function instrumentFromProfile(
  profile: JsonRecord,
  context: ProviderRequestContext,
  client: FmpClient,
  ingestedAt: string,
): Instrument | null {
  const symbol = normalizedFmpListedSymbol(profile.symbol);
  const name = stringValue(profile.companyName, profile.name);
  const active = booleanValue(profile.isActivelyTrading);
  const assetType = assetTypeFromProfile(profile);
  const currency = stringValue(profile.currency)?.toUpperCase();
  const reportedExchange = stringValue(profile.exchangeShortName, profile.exchange);
  if (!symbol || !name || active !== true || !assetType) return null;
  if (currency && currency !== "USD") return null;
  // `country` is the issuer domicile in FMP, not the listing venue. Accept a
  // foreign issuer only when FMP explicitly identifies a supported U.S.
  // exchange. Retain the legacy fallback for U.S. issuers whose profile omits
  // an exchange, but never infer a U.S. listing from an unknown venue.
  if (reportedExchange) {
    if (!isUsListingExchange(reportedExchange)) return null;
  } else if (!usCountry(profile.country)) {
    return null;
  }

  const exchange = reportedExchange || "US";
  const mic = exchangeMic(exchange);
  const asOf = sourceAsOf(context, ingestedAt);
  return {
    instrumentId: `us:${mic}:${symbol}`,
    symbol,
    name,
    assetType,
    active: true,
    listingCountry: "US",
    exchange,
    exchangeMic: mic,
    currency: "USD",
    sector: stringValue(profile.sector),
    industry: stringValue(profile.industry),
    provenance: provenance(client, `fmp:profile:${symbol}`, "profile", asOf, ingestedAt),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index]);
      } catch {
        results[index] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function optionalGet(
  client: FmpClient,
  path: string,
  query: Readonly<Record<string, QueryValue>>,
): Promise<unknown | null> {
  try {
    return await client.get(path, query);
  } catch {
    return null;
  }
}

function calculateGrowth(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined || previous === 0) return undefined;
  return (current - previous) / Math.abs(previous);
}

function hasSnapshotData(snapshot: Omit<FundamentalsSnapshot, "instrumentId" | "currency" | "provenance">): boolean {
  return Object.entries(snapshot).some(([name, value]) => (
    name !== "period"
    && (typeof value === "number" || name === "shareStructure" || name === "financialHealth")
  ));
}

function rangeDays(range: MarketBarRange): number {
  return {
    "1d": 2,
    "5d": 8,
    "1mo": 35,
    "3mo": 100,
    "6mo": 190,
    "1y": 370,
    "5y": 1_830,
  }[range];
}

function barEndpoint(interval: MarketBarInterval): string {
  return {
    "1m": "historical-chart/1min",
    "5m": "historical-chart/5min",
    "15m": "historical-chart/15min",
    "1h": "historical-chart/1hour",
    "4h": "historical-chart/1hour",
    "1d": "historical-price-eod/full",
    "1wk": "historical-price-eod/full",
    "1mo": "historical-price-eod/full",
  }[interval];
}

function marketState(record: JsonRecord): Quote["marketState"] {
  const state = stringValue(record.marketState, record.marketStatus)?.toUpperCase() || "";
  if (state.includes("PRE")) return "pre_market";
  if (state.includes("POST") || state.includes("AFTER")) return "after_hours";
  if (state.includes("REGULAR") || state.includes("OPEN")) return "regular";
  if (booleanValue(record.isMarketOpen) === true) return "regular";
  return "closed";
}

function stableId(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createFmpProvider(
  env: ProviderEnvironment,
  options: FmpProviderOptions = {},
): ProviderAdapter {
  const apiKey = env.FMP_API_KEY?.trim();
  if (!apiKey) {
    throw new FmpProviderError("configuration", "FMP provider is not configured.");
  }
  if (!usageIsExplicitlyAllowed(env)) {
    throw new FmpProviderError(
      "configuration",
      "FMP provider requires an explicitly permitted usage mode.",
    );
  }

  const now = options.now || (() => new Date());
  const client = new FmpClient(
    apiKey,
    normalizeBaseUrl(env.FMP_BASE_URL),
    options.fetch || globalThis.fetch.bind(globalThis),
    normalizedTimeout(env, options.timeoutMs),
  );

  const adapter: ProviderAdapter = {
    manifest,
    instrument: {
      searchUSStocks: async ({ query, limit = 20 }, context) => {
        const normalizedQuery = query.normalize("NFKC").trim();
        if (!normalizedQuery) return [];
        const normalizedLimit = Number.isFinite(limit)
          ? Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)))
          : 20;
        const [symbolPayload, namePayload] = await Promise.all([
          optionalGet(client, "search-symbol", { query: normalizedQuery }),
          optionalGet(client, "search-name", { query: normalizedQuery }),
        ]);

        const candidates = new Map<string, string>();
        const exactSymbol = normalizedFmpListedSymbol(normalizedQuery);
        if (exactSymbol) candidates.set(exactSymbol, exactSymbol);
        for (const row of [...recordsFrom(symbolPayload), ...recordsFrom(namePayload)]) {
          const symbol = normalizedFmpListedSymbol(row.symbol);
          if (symbol && !candidates.has(symbol)) candidates.set(symbol, symbol);
        }
        const symbols = [...candidates.keys()].slice(0, Math.min(50, normalizedLimit * 3));
        const profiles = await mapWithConcurrency(symbols, 4, async (symbol) => {
          const payload = await client.get("profile", { symbol });
          const profile = firstRecord(payload);
          return profile && normalizedFmpListedSymbol(profile.symbol) === symbol ? profile : undefined;
        });
        const ingestedAt = now().toISOString();
        return profiles
          .map((profile) => profile && instrumentFromProfile(profile, context, client, ingestedAt))
          .filter((instrument): instrument is Instrument => Boolean(instrument))
          .slice(0, normalizedLimit);
      },
      getUSStockBySymbol: async (requestedSymbol, context) => {
        const symbol = normalizedFmpListedSymbol(requestedSymbol);
        if (!symbol) return null;
        const profile = firstRecord(await client.get("profile", { symbol }));
        if (!profile || normalizedFmpListedSymbol(profile.symbol) !== symbol) return null;
        return instrumentFromProfile(profile, context, client, now().toISOString());
      },
    },
    market: {
      getQuote: async (instrument) => {
        const record = firstRecord(await client.get("quote", { symbol: instrument.symbol }));
        if (!record) return null;
        const price = numberValue(record.price);
        const previousClose = numberValue(record.previousClose);
        const open = numberValue(record.open);
        const high = numberValue(record.dayHigh, record.high);
        const low = numberValue(record.dayLow, record.low);
        const volume = numberValue(record.volume);
        const rawTimestamp = numberValue(record.timestamp);
        if (
          price === undefined
          || price <= 0
          || previousClose === undefined
          || previousClose <= 0
          || open === undefined
          || open <= 0
          || high === undefined
          || high <= 0
          || low === undefined
          || low <= 0
          || high < low
          || volume === undefined
          || volume < 0
          || rawTimestamp === undefined
        ) return null;
        const change = numberValue(record.change) ?? price - previousClose;
        const ingestedAt = now().toISOString();
        const asOf = isoDateTime(rawTimestamp);
        if (!asOf) return null;
        const observedDelay = Math.max(0, Math.trunc((now().getTime() - new Date(asOf).getTime()) / 1000));
        return {
          instrumentId: instrument.instrumentId,
          price,
          change,
          changePercent: numberValue(record.changesPercentage, record.changePercentage)
            ?? (previousClose === 0 ? 0 : (change / previousClose) * 100),
          previousClose,
          open,
          high,
          low,
          volume,
          marketCap: numberValue(record.marketCap),
          currency: "USD",
          marketState: marketState(record),
          delaySeconds: numberValue(record.delaySeconds) ?? observedDelay,
          provenance: provenance(
            client,
            `fmp:quote:${instrument.symbol}`,
            "quote",
            asOf,
            ingestedAt,
          ),
        } satisfies Quote;
      },
      getBars: async (instrument, request, context) => {
        const endpoint = barEndpoint(request.interval);
        const requestedAsOf = isoDateTime(context.asOf);
        const requestedEnd = requestedAsOf ? new Date(requestedAsOf) : now();
        const requestedStart = new Date(requestedEnd);
        requestedStart.setUTCDate(requestedStart.getUTCDate() - rangeDays(request.range));
        const payload = await client.get(endpoint, {
          symbol: instrument.symbol,
          from: dateOnly(requestedStart),
          to: dateOnly(requestedEnd),
        });
        const byTime = new Map<string, MarketBars["items"][number]>();
        for (const row of recordsFrom(payload)) {
          const time = isoDateTime(row.date, row.timestamp);
          const open = numberValue(row.open);
          const high = numberValue(row.high);
          const low = numberValue(row.low);
          const close = numberValue(row.close);
          const volume = numberValue(row.volume);
          if (
            !time
            || open === undefined
            || high === undefined
            || low === undefined
            || close === undefined
            || volume === undefined
            || !validOhlcv(open, high, low, close, volume)
          ) continue;
          const adjustedClose = numberValue(row.adjClose, row.adjustedClose);
          byTime.set(time, {
            time,
            open,
            high,
            low,
            close,
            volume,
            ...(adjustedClose === undefined ? {} : { adjustedClose }),
          });
        }
        const normalizedItems = [...byTime.values()].sort((left, right) => left.time.localeCompare(right.time));
        const items = request.interval === "4h" || request.interval === "1wk" || request.interval === "1mo"
          ? aggregateMarketBars(normalizedItems, request.interval)
          : normalizedItems;
        if (items.length === 0) return null;
        const ingestedAt = now().toISOString();
        const latestAsOf = items.at(-1)?.time || sourceAsOf(context, ingestedAt);
        return {
          instrumentId: instrument.instrumentId,
          interval: request.interval,
          range: request.range,
          adjustment: "split_adjusted",
          items,
          provenance: provenance(
            client,
            `fmp:bars:${instrument.symbol}:${request.interval}`,
            endpoint,
            latestAsOf,
            ingestedAt,
          ),
        } satisfies MarketBars;
      },
    },
    fundamentals: {
      getProfile: async (instrument, context) => {
        const record = firstRecord(await client.get("profile", { symbol: instrument.symbol }));
        if (!record) return null;
        const ingestedAt = now().toISOString();
        const asOf = sourceAsOf(context, ingestedAt);
        return {
          instrumentId: instrument.instrumentId,
          description: stringValue(record.description),
          website: safeHttpUrl(record.website),
          sector: stringValue(record.sector),
          industry: stringValue(record.industry),
          country: stringValue(record.country),
          city: stringValue(record.city),
          employees: numberValue(record.fullTimeEmployees, record.employees),
          logoUrl: companyLogoPathForUSStock(instrument.symbol),
          beta: numberValue(record.beta),
          marketCap: numberValue(record.mktCap, record.marketCap),
          ipoDate: stringValue(record.ipoDate),
          provenance: provenance(
            client,
            `fmp:profile:${instrument.symbol}`,
            "profile",
            asOf,
            ingestedAt,
          ),
        } satisfies CompanyProfile;
      },
      getFundamentals: async (instrument, context) => {
        const query = { symbol: instrument.symbol } as const;
        const [
          metricsPayload,
          ratiosPayload,
          incomePayload,
          balancePayload,
          cashFlowPayload,
          sharesFloatPayload,
          financialScoresPayload,
        ] = await Promise.all([
          optionalGet(client, "key-metrics-ttm", query),
          optionalGet(client, "ratios-ttm", query),
          optionalGet(client, "income-statement", { ...query, period: "annual", limit: 2 }),
          optionalGet(client, "balance-sheet-statement", { ...query, period: "annual", limit: 1 }),
          optionalGet(client, "cash-flow-statement", { ...query, period: "annual", limit: 1 }),
          optionalGet(client, "shares-float", query),
          optionalGet(client, "financial-scores", query),
        ]);
        const metrics = firstRecord(metricsPayload) || {};
        const ratios = firstRecord(ratiosPayload) || {};
        const incomeRows = recordsFrom(incomePayload).sort((left, right) => {
          const leftDate = stringValue(left.date, left.calendarYear) || "";
          const rightDate = stringValue(right.date, right.calendarYear) || "";
          return rightDate.localeCompare(leftDate);
        });
        const currentIncome = incomeRows[0] || {};
        const previousIncome = incomeRows[1] || {};
        const balance = firstRecord(balancePayload) || {};
        const cashFlow = firstRecord(cashFlowPayload) || {};

        const revenue = numberValue(currentIncome.revenue, metrics.revenueTTM);
        const freeCashFlow = numberValue(cashFlow.freeCashFlow, metrics.freeCashFlowTTM);
        const ebitda = numberValue(currentIncome.ebitda, metrics.ebitdaTTM);
        const ingestedAt = now().toISOString();
        const shareStructure = shareStructureFromPayload(
          sharesFloatPayload,
          instrument,
          context,
          client,
          ingestedAt,
        );
        const financialHealth = financialHealthFromPayload(
          financialScoresPayload,
          instrument,
          context,
          client,
          ingestedAt,
        );

        const values = {
          period: stringValue(currentIncome.calendarYear, currentIncome.fiscalYear, currentIncome.period, currentIncome.date),
          revenue,
          revenueGrowth: numberValue(ratios.revenueGrowthTTM)
            ?? calculateGrowth(numberValue(currentIncome.revenue), numberValue(previousIncome.revenue)),
          grossProfit: numberValue(currentIncome.grossProfit, metrics.grossProfitTTM),
          operatingIncome: numberValue(currentIncome.operatingIncome, metrics.operatingIncomeTTM),
          ebitda,
          netIncome: numberValue(currentIncome.netIncome, metrics.netIncomeTTM),
          eps: numberValue(currentIncome.epsDiluted, currentIncome.eps, metrics.netIncomePerShareTTM),
          epsGrowth: numberValue(ratios.epsGrowthTTM)
            ?? calculateGrowth(
              numberValue(currentIncome.epsDiluted, currentIncome.eps),
              numberValue(previousIncome.epsDiluted, previousIncome.eps),
            ),
          enterpriseValue: numberValue(metrics.enterpriseValueTTM, ratios.enterpriseValueTTM),
          trailingPe: numberValue(metrics.peRatioTTM, ratios.priceEarningsRatioTTM),
          forwardPe: numberValue(metrics.forwardPE, ratios.forwardPERatioTTM),
          pegRatio: numberValue(metrics.pegRatioTTM, ratios.priceToEarningsGrowthRatioTTM),
          priceToBook: numberValue(metrics.pbRatioTTM, ratios.priceToBookRatioTTM),
          priceToSales: numberValue(metrics.priceToSalesRatioTTM, ratios.priceToSalesRatioTTM),
          priceToFreeCashFlow: numberValue(
            metrics.priceToFreeCashFlowsRatioTTM,
            ratios.priceToFreeCashFlowRatioTTM,
          ),
          enterpriseValueToRevenue: numberValue(metrics.evToSalesTTM, ratios.enterpriseValueToSalesRatioTTM),
          enterpriseValueToEbitda: numberValue(metrics.evToEBITDATTM, ratios.enterpriseValueMultipleTTM),
          earningsYield: numberValue(metrics.earningsYieldTTM, ratios.earningsYieldTTM),
          roe: numberValue(metrics.returnOnEquityTTM, ratios.returnOnEquityTTM),
          roa: numberValue(metrics.returnOnAssetsTTM, ratios.returnOnAssetsTTM),
          roic: numberValue(metrics.returnOnInvestedCapitalTTM, ratios.returnOnInvestedCapitalTTM),
          grossMargin: numberValue(ratios.grossProfitMarginTTM, currentIncome.grossProfitRatio),
          operatingMargin: numberValue(ratios.operatingProfitMarginTTM, currentIncome.operatingIncomeRatio),
          ebitdaMargin: numberValue(ratios.ebitdaMarginTTM)
            ?? (ebitda !== undefined && revenue !== undefined && revenue !== 0
              ? ebitda / revenue
              : undefined),
          netMargin: numberValue(ratios.netProfitMarginTTM, currentIncome.netIncomeRatio),
          freeCashFlowMargin: freeCashFlow !== undefined && revenue !== undefined && revenue !== 0
            ? freeCashFlow / revenue
            : undefined,
          assetTurnover: numberValue(ratios.assetTurnoverTTM),
          interestCoverage: numberValue(ratios.interestCoverageRatioTTM),
          cashAndShortTermInvestments: numberValue(
            balance.cashAndShortTermInvestments,
            balance.cashAndCashEquivalents,
          ),
          totalAssets: numberValue(balance.totalAssets),
          totalDebt: numberValue(balance.totalDebt),
          netDebt: numberValue(balance.netDebt),
          shareholdersEquity: numberValue(balance.totalStockholdersEquity, balance.totalEquity),
          dividendYield: numberValue(metrics.dividendYieldTTM, ratios.dividendYieldTTM),
          dividendPerShare: numberValue(ratios.dividendPerShareTTM, metrics.dividendPerShareTTM),
          payoutRatio: numberValue(ratios.dividendPayoutRatioTTM, ratios.payoutRatioTTM),
          operatingCashFlow: numberValue(
            cashFlow.operatingCashFlow,
            cashFlow.netCashProvidedByOperatingActivities,
            metrics.operatingCashFlowTTM,
          ),
          capitalExpenditure: numberValue(
            cashFlow.capitalExpenditure,
            cashFlow.investmentsInPropertyPlantAndEquipment,
          ),
          freeCashFlow,
          freeCashFlowYield: numberValue(metrics.freeCashFlowYieldTTM),
          debtToEquity: numberValue(
            metrics.debtToEquityTTM,
            ratios.debtToEquityRatioTTM,
            ratios.debtEquityRatioTTM,
          ),
          currentRatio: numberValue(metrics.currentRatioTTM, ratios.currentRatioTTM),
          quickRatio: numberValue(ratios.quickRatioTTM),
          cashRatio: numberValue(ratios.cashRatioTTM),
          revenuePerShare: numberValue(ratios.revenuePerShareTTM, metrics.revenuePerShareTTM),
          bookValuePerShare: numberValue(ratios.bookValuePerShareTTM, metrics.bookValuePerShareTTM),
          operatingCashFlowPerShare: numberValue(
            ratios.operatingCashFlowPerShareTTM,
            metrics.operatingCashFlowPerShareTTM,
          ),
          freeCashFlowPerShare: numberValue(ratios.freeCashFlowPerShareTTM, metrics.freeCashFlowPerShareTTM),
          ...(shareStructure ? { shareStructure } : {}),
          ...(financialHealth ? { financialHealth } : {}),
        };
        if (!hasSnapshotData(values)) return null;
        const reportAsOf = [currentIncome.date, balance.date, cashFlow.date]
          .map((value) => stringValue(value))
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1);
        return {
          instrumentId: instrument.instrumentId,
          currency: "USD",
          ...values,
          provenance: provenance(
            client,
            `fmp:fundamentals-composite:${instrument.symbol}`,
            "key-metrics-ttm",
            sourceAsOf(context, isoDateTime(reportAsOf) || ingestedAt),
            ingestedAt,
          ),
        } satisfies FundamentalsSnapshot;
      },
      getEarnings: async (instrument) => {
        const payload = await client.get("earnings", { symbol: instrument.symbol, limit: 20 });
        const ingestedAt = now().toISOString();
        return recordsFrom(payload)
          .map((row): EarningsEvent | null => {
            const reportDate = stringValue(row.date, row.reportDate, row.reportedDate);
            const reportDateIso = isoDateTime(reportDate);
            if (!reportDate || !reportDateIso) return null;
            return {
              reportDate: reportDate.slice(0, 10),
              fiscalDateEnding: stringValue(row.fiscalDateEnding),
              epsActual: numberValue(row.epsActual, row.actualEps, row.actualEPS),
              epsEstimate: numberValue(row.epsEstimated, row.epsEstimate, row.estimatedEps),
              revenueActual: numberValue(row.revenueActual, row.actualRevenue),
              revenueEstimate: numberValue(row.revenueEstimated, row.revenueEstimate),
              provenance: provenance(
                client,
                `fmp:earnings:${instrument.symbol}:${reportDate.slice(0, 10)}`,
                "earnings",
                reportDateIso,
                ingestedAt,
              ),
            };
          })
          .filter((event): event is EarningsEvent => Boolean(event))
          .sort((left, right) => right.reportDate.localeCompare(left.reportDate));
      },
    },
    analyst: {
      getConsensus: async (instrument, context) => {
        const query = { symbol: instrument.symbol } as const;
        const [targetPayload, gradesPayload, estimatesPayload] = await Promise.all([
          optionalGet(client, "price-target-consensus", query),
          optionalGet(client, "grades-consensus", query),
          optionalGet(client, "analyst-estimates", { ...query, period: "annual", page: 0, limit: 10 }),
        ]);
        const target = firstRecord(targetPayload) || {};
        const grades = firstRecord(gradesPayload) || {};
        const estimates = recordsFrom(estimatesPayload).sort((left, right) => {
          const leftDate = stringValue(left.date) || "";
          const rightDate = stringValue(right.date) || "";
          return leftDate.localeCompare(rightDate);
        });
        const today = dateOnly(now());
        const estimate = estimates.find((row) => (stringValue(row.date) || "") >= today)
          || estimates[0]
          || {};
        const strongBuy = numberValue(grades.strongBuy);
        const buy = numberValue(grades.buy);
        const hold = numberValue(grades.hold);
        const sell = numberValue(grades.sell);
        const strongSell = numberValue(grades.strongSell);
        const gradesCount = [strongBuy, buy, hold, sell, strongSell]
          .filter((value): value is number => value !== undefined)
          .reduce((sum, value) => sum + value, 0);
        const hasGradeDistribution = gradesCount > 0;
        const values = {
          targetLow: positiveNumber(target.targetLow, target.low),
          targetHigh: positiveNumber(target.targetHigh, target.high),
          targetConsensus: positiveNumber(target.targetConsensus, target.consensus),
          targetMedian: positiveNumber(target.targetMedian, target.median),
          strongBuy: hasGradeDistribution ? strongBuy : undefined,
          buy: hasGradeDistribution ? buy : undefined,
          hold: hasGradeDistribution ? hold : undefined,
          sell: hasGradeDistribution ? sell : undefined,
          strongSell: hasGradeDistribution ? strongSell : undefined,
          analystCount: positiveNumber(
            target.analystCount,
            estimate.numberAnalystEstimatedEps,
            estimate.numberAnalystsEstimatedEps,
          ) ?? (gradesCount > 0 ? gradesCount : undefined),
          forwardEps: numberValue(estimate.estimatedEpsAvg, estimate.epsAvg),
          forwardRevenue: numberValue(estimate.estimatedRevenueAvg, estimate.revenueAvg),
        };
        if (!Object.values(values).some((value) => typeof value === "number")) return null;
        const ingestedAt = now().toISOString();
        return {
          instrumentId: instrument.instrumentId,
          ...values,
          provenance: provenance(
            client,
            `fmp:analyst-consensus:${instrument.symbol}`,
            "price-target-consensus",
            sourceAsOf(context, ingestedAt),
            ingestedAt,
          ),
        } satisfies AnalystConsensus;
      },
    },
    news: {
      getCompanyNews: async (instrument) => {
        const payload = await client.get("news/stock", { symbols: instrument.symbol, limit: 20 });
        const ingestedAt = now().toISOString();
        const seenIds = new Set<string>();
        const seenUrls = new Set<string>();
        return recordsFrom(payload)
          .map((row): CompanyNewsItem | null => {
            const title = stringValue(row.title);
            const url = safeHttpUrl(row.url);
            const publishedAt = isoDateTime(row.publishedDate, row.publishedAt, row.date);
            if (!title || !url || !publishedAt) return null;
            const sourceIdentity = stringValue(row.id) || stableId(`${url}|${publishedAt}`);
            return {
              id: `fmp:${sourceIdentity}`,
              instrumentId: instrument.instrumentId,
              title,
              summary: stringValue(row.text, row.summary),
              url,
              publisher: stringValue(row.site, row.publisher) || "Unknown",
              publishedAt,
              imageUrl: safeHttpUrl(row.image, row.imageUrl),
              provenance: provenance(
                client,
                `fmp:news:${sourceIdentity}`,
                "news/stock",
                publishedAt,
                ingestedAt,
              ),
            };
          })
          .filter((item): item is CompanyNewsItem => Boolean(item))
          .filter((item) => {
            const canonicalUrl = item.url.toString();
            if (seenIds.has(item.id) || seenUrls.has(canonicalUrl)) return false;
            seenIds.add(item.id);
            seenUrls.add(canonicalUrl);
            return true;
          })
          .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
      },
    },
  };

  return Object.freeze(adapter);
}

export const fmpProviderRegistration = {
  manifest,
  create: (env) => createFmpProvider(env),
} as const satisfies ProviderRegistration;
