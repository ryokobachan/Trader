import {
  MAX_MARKET_BAR_COUNT,
  MIN_MARKET_BAR_COUNT,
  PROVIDER_SCHEMA_VERSION,
  type Instrument,
  type MarketBar,
  type MarketBarInterval,
  type MarketBarRange,
  type MarketBars,
  type MarketBarsRequest,
  type MarketSessionState,
  type ProviderEnvironment,
  type ProviderRequestContext,
  type ProviderRegistration,
  type Quote,
  type SyntheticLatestClose,
} from "@/app/platform/provider-contracts";

const SIDECAR_SCHEMA_VERSION = "unicorn.tradingview-sidecar.v1";
const REALTIME_QUOTES_SCHEMA_VERSION = "unicorn.tradingview-realtime-quotes.v1";
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_TIMEOUT_MS = 65_000;
const TRADINGVIEW_SOURCE_URL = "wss://data.tradingview.com/socket.io/websocket";
const MAX_LATEST_CLOSE_SYMBOLS = 50;
const MAX_REALTIME_SYMBOLS = 50;
const MAX_SYNTHETIC_EXCHANGES = 8;
const MAX_REALTIME_EVENT_BYTES = 64 * 1_024;
const MAX_REALTIME_SNAPSHOT_BYTES = 256 * 1_024;
const MAX_FUTURE_CLOCK_SKEW_MS = 60_000;
const SYNTHETIC_EXCHANGE_PATTERN = /^[A-Z][A-Z0-9._-]{0,14}$/;

export const DEFAULT_TRADINGVIEW_SYNTHETIC_EXCHANGES = Object.freeze([
  "BINANCE",
  "BITGET",
  "KUCOIN",
  "MEXC",
] as const);

const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "tradingview-websocket",
  version: "1.3.0",
  displayName: "TradingView websocket local sidecar",
  capabilities: ["market.quote", "market.bars", "market.synthetic_latest_close"],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: ["UNICORN_TRADINGVIEW_SIDECAR_URL"],
} as const;

export type TradingViewSidecarFetch = typeof globalThis.fetch;

type ProviderDependencies = Readonly<{
  fetch?: TradingViewSidecarFetch;
  now?: () => Date;
}>;

type JsonRecord = Record<string, unknown>;

type RealtimeQuoteRequest = Readonly<{
  instrument: Instrument;
  symbol: string;
  mic: string;
  sourceSymbol: string;
}>;

export type TradingViewSidecarErrorCode =
  | "configuration"
  | "invalid_request"
  | "request_timeout"
  | "upstream_error"
  | "invalid_response";

export class TradingViewSidecarError extends Error {
  readonly code: TradingViewSidecarErrorCode;
  readonly status?: number;

  constructor(code: TradingViewSidecarErrorCode, message: string, status?: number) {
    super(message);
    this.name = "TradingViewSidecarError";
    this.code = code;
    this.status = status;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function hasExactKeys(value: JsonRecord | null, keys: readonly string[]): value is JsonRecord {
  if (!value) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(2_000, Math.min(MAX_TIMEOUT_MS, Math.trunc(parsed)));
}

function configuredCandleLimit(value: string | undefined): number {
  if (!value?.trim()) return MAX_MARKET_BAR_COUNT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return MAX_MARKET_BAR_COUNT;
  return Math.min(MAX_MARKET_BAR_COUNT, Math.max(MIN_MARKET_BAR_COUNT, parsed));
}

function boundedCandleCount(value: number, configuredLimit: number): number {
  if (!Number.isFinite(value)) return MIN_MARKET_BAR_COUNT;
  return Math.min(configuredLimit, Math.max(MIN_MARKET_BAR_COUNT, Math.trunc(value)));
}

/**
 * Ordered exchanges used for ticker-derived perpetual reference closes.
 *
 * This setting is deliberately server-only. It lets a developer extend or
 * reorder TradingView sources without allowing an untrusted browser request to
 * choose arbitrary upstream identifiers.
 */
export function tradingViewSyntheticExchanges(
  env: ProviderEnvironment,
): readonly string[] {
  const configured = env.UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES?.trim();
  if (!configured) return DEFAULT_TRADINGVIEW_SYNTHETIC_EXCHANGES;
  const exchanges = configured.split(",").map((value) => value.trim().toUpperCase());
  if (
    exchanges.length < 1
    || exchanges.length > MAX_SYNTHETIC_EXCHANGES
    || exchanges.some((exchange) => !SYNTHETIC_EXCHANGE_PATTERN.test(exchange))
    || new Set(exchanges).size !== exchanges.length
  ) {
    throw new TradingViewSidecarError(
      "configuration",
      "TradingView synthetic exchanges are invalid.",
    );
  }
  return Object.freeze(exchanges);
}

function loopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname === "::1";
}

function sidecarBaseUrl(env: ProviderEnvironment): URL {
  const configured = env.UNICORN_TRADINGVIEW_SIDECAR_URL?.trim();
  if (!configured) {
    throw new TradingViewSidecarError("configuration", "TradingView sidecar URL is required.");
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new TradingViewSidecarError("configuration", "TradingView sidecar URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol === "http:" && !loopbackHostname(url.hostname))
  ) {
    throw new TradingViewSidecarError("configuration", "TradingView sidecar URL is not permitted.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function tradingViewExchange(instrument: Instrument): string | null {
  switch (instrument.exchangeMic.toUpperCase()) {
    case "XNAS": return "NASDAQ";
    case "XNYS": return "NYSE";
    case "XASE": return "AMEX";
    case "ARCX": return "AMEX";
    case "BATS": return "CBOE";
    default: {
      const exchange = instrument.exchange.toUpperCase();
      if (exchange.includes("NASDAQ")) return "NASDAQ";
      if (exchange.includes("AMERICAN") || exchange.includes("ARCA")) return "AMEX";
      if (exchange.includes("NYSE")) return "NYSE";
      if (exchange.includes("CBOE")) return "CBOE";
      return null;
    }
  }
}

function realtimeQuoteRequests(
  instruments: readonly Instrument[],
): readonly RealtimeQuoteRequest[] {
  const requests: RealtimeQuoteRequest[] = [];
  const seen = new Set<string>();
  for (const instrument of instruments) {
    const exchange = tradingViewExchange(instrument);
    const symbol = instrument.symbol.normalize("NFKC").trim().toUpperCase();
    const mic = instrument.exchangeMic.toUpperCase();
    if (
      !exchange
      || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)
      || seen.has(symbol)
    ) continue;
    seen.add(symbol);
    requests.push(Object.freeze({
      instrument,
      symbol,
      mic,
      sourceSymbol: `${exchange}:${symbol.replaceAll("-", ".")}`,
    }));
  }
  return Object.freeze(requests);
}

const CANDLE_COUNTS = Object.freeze({
  "1m": Object.freeze({ "1d": 420, "5d": 2_100, "1mo": 5_000, "3mo": 5_000, "6mo": 5_000, "1y": 5_000, "5y": 5_000 }),
  "5m": Object.freeze({ "1d": 84, "5d": 420, "1mo": 1_800, "3mo": 5_000, "6mo": 5_000, "1y": 5_000, "5y": 5_000 }),
  "15m": Object.freeze({ "1d": 30, "5d": 140, "1mo": 600, "3mo": 1_800, "6mo": 3_600, "1y": 5_000, "5y": 5_000 }),
  "1h": Object.freeze({ "1d": 8, "5d": 40, "1mo": 180, "3mo": 540, "6mo": 1_100, "1y": 2_200, "5y": 5_000 }),
  "4h": Object.freeze({ "1d": 2, "5d": 10, "1mo": 50, "3mo": 140, "6mo": 280, "1y": 550, "5y": 2_750 }),
  "1d": Object.freeze({ "1d": 2, "5d": 7, "1mo": 24, "3mo": 70, "6mo": 135, "1y": 260, "5y": 1_310 }),
  "1wk": Object.freeze({ "1d": 2, "5d": 2, "1mo": 6, "3mo": 15, "6mo": 28, "1y": 54, "5y": 265 }),
  "1mo": Object.freeze({ "1d": 2, "5d": 2, "1mo": 2, "3mo": 4, "6mo": 7, "1y": 13, "5y": 61 }),
} as const satisfies Readonly<Record<MarketBarInterval, Readonly<Record<MarketBarRange, number>>>>);

export function tradingViewCandleCount(range: MarketBarRange, interval: MarketBarInterval): number {
  return CANDLE_COUNTS[interval][range];
}

function marketState(now: Date): MarketSessionState {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (values.weekday === "Sat" || values.weekday === "Sun") return "closed";
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre_market";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "after_hours";
  return "closed";
}

function normalizeBars(payload: unknown, expected: Readonly<{
  symbol: string;
  interval: MarketBarInterval;
  range: MarketBarRange;
  requestedCount: number;
}>): Readonly<{
  items: readonly MarketBar[];
  requestedCount: number;
  returnedCount: number;
  asOf: string;
  ingestedAt: string;
}> {
  const root = asRecord(payload);
  if (
    root?.schemaVersion !== SIDECAR_SCHEMA_VERSION
    || root.symbol !== expected.symbol
    || root.interval !== expected.interval
    || root.range !== expected.range
    || !Array.isArray(root.items)
    || (root.requestedCount !== undefined && root.requestedCount !== expected.requestedCount)
    || (root.returnedCount !== undefined && root.returnedCount !== root.items.length)
    || root.items.length > expected.requestedCount
  ) {
    throw new TradingViewSidecarError("invalid_response", "TradingView sidecar returned an invalid response.");
  }
  const bars: MarketBar[] = [];
  let previousTime = -Infinity;
  for (const item of root.items) {
    const record = asRecord(item);
    const time = isoTimestamp(record?.time);
    const open = finiteNumber(record?.open);
    const high = finiteNumber(record?.high);
    const low = finiteNumber(record?.low);
    const close = finiteNumber(record?.close);
    const volume = finiteNumber(record?.volume);
    const milliseconds = time ? Date.parse(time) : NaN;
    if (
      !time
      || !Number.isFinite(milliseconds)
      || milliseconds <= previousTime
      || open === null
      || high === null
      || low === null
      || close === null
      || volume === null
      || volume < 0
      || high < Math.max(open, close)
      || low > Math.min(open, close)
      || low > high
    ) {
      throw new TradingViewSidecarError("invalid_response", "TradingView sidecar returned invalid bars.");
    }
    previousTime = milliseconds;
    bars.push(Object.freeze({ time, open, high, low, close, volume }));
  }
  if (bars.length === 0) {
    throw new TradingViewSidecarError("invalid_response", "TradingView sidecar returned no bars.");
  }
  const asOf = isoTimestamp(root.asOf) ?? bars.at(-1)!.time;
  const ingestedAt = isoTimestamp(root.ingestedAt) ?? new Date().toISOString();
  return Object.freeze({
    items: Object.freeze(bars),
    requestedCount: expected.requestedCount,
    returnedCount: bars.length,
    asOf,
    ingestedAt,
  });
}

const SYNTHETIC_ITEM_KEYS = Object.freeze([
  "symbol",
  "sourceSymbol",
  "close",
  "currency",
  "source",
  "updatedAt",
] as const);
const SYNTHETIC_READY_EVENT_KEYS = Object.freeze([
  "schemaVersion",
  "type",
  "exchange",
  "exchanges",
  "resolutionStrategy",
  "state",
  "items",
  "ingestedAt",
] as const);
const SYNTHETIC_QUOTE_EVENT_KEYS = Object.freeze([
  "schemaVersion",
  "type",
  "exchange",
  "exchanges",
  "resolutionStrategy",
  "item",
  "ingestedAt",
] as const);
const SYNTHETIC_STATUS_EVENT_KEYS = Object.freeze([
  "schemaVersion",
  "type",
  "state",
  "ingestedAt",
] as const);

function normalizeLatestCloses(
  payload: unknown,
  expectedSymbols: readonly string[],
  expectedExchanges: readonly string[],
): readonly SyntheticLatestClose[] {
  const root = asRecord(payload);
  const responseExchanges = Array.isArray(root?.exchanges) ? root.exchanges : null;
  if (
    root?.schemaVersion !== SIDECAR_SCHEMA_VERSION
    || root.exchange !== expectedExchanges[0]
    || root.resolutionStrategy !== "ordered_fallback"
    || responseExchanges?.length !== expectedExchanges.length
    || responseExchanges.some((exchange, index) => exchange !== expectedExchanges[index])
    || !Array.isArray(root.items)
    || root.items.length !== expectedSymbols.length
  ) {
    throw new TradingViewSidecarError(
      "invalid_response",
      "TradingView sidecar returned an invalid latest-close response.",
    );
  }

  const items: SyntheticLatestClose[] = [];
  for (let index = 0; index < expectedSymbols.length; index += 1) {
    const symbol = expectedSymbols[index]!;
    const item = asRecord(root.items[index]);
    const close = item?.close === null ? null : finiteNumber(item?.close);
    const updatedAt = item?.updatedAt === null ? null : isoTimestamp(item?.updatedAt);
    const isMissing = item?.close === null && item.updatedAt === null;
    const isPresent = close !== null && close > 0 && updatedAt !== null;
    const allowedSourceSymbols = expectedExchanges.map(
      (exchange) => `${exchange}:${symbol}USDT.P`,
    );
    const expectedMissingSource = allowedSourceSymbols[0];
    if (
      item?.symbol !== symbol
      || !hasExactKeys(item, SYNTHETIC_ITEM_KEYS)
      || typeof item.sourceSymbol !== "string"
      || (isMissing
        ? item.sourceSymbol !== expectedMissingSource
        : !allowedSourceSymbols.includes(item.sourceSymbol))
      || item.currency !== "USDT"
      || item.source !== manifest.id
      || !(isMissing || isPresent)
    ) {
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView sidecar returned invalid latest-close data.",
      );
    }
    items.push(Object.freeze({
      symbol,
      sourceSymbol: item.sourceSymbol,
      close,
      currency: "USDT",
      source: manifest.id,
      updatedAt,
    }));
  }
  return Object.freeze(items);
}

function normalizeSyntheticSymbols(symbols: readonly string[]): readonly string[] {
  const normalizedSymbols = symbols.map((symbol) => symbol.normalize("NFKC").trim().toUpperCase());
  if (
    normalizedSymbols.length < 1
    || normalizedSymbols.length > MAX_LATEST_CLOSE_SYMBOLS
    || normalizedSymbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))
    || new Set(normalizedSymbols).size !== normalizedSymbols.length
  ) {
    throw new TradingViewSidecarError("invalid_request", "Latest-close symbols are invalid.");
  }
  return Object.freeze(normalizedSymbols);
}

const REALTIME_ITEM_KEYS = Object.freeze([
  "symbol",
  "sourceSymbol",
  "price",
  "previousClose",
  "change",
  "changePercent",
  "open",
  "high",
  "low",
  "volume",
  "currency",
  "session",
  "updatedAt",
  "stale",
] as const);

function normalizeRealtimeQuote(
  value: unknown,
  expectedBySymbol: ReadonlyMap<string, RealtimeQuoteRequest>,
  ingestedAtValue: unknown,
  observedNow: Date,
): Quote | null {
  const item = asRecord(value);
  const ingestedAt = isoTimestamp(ingestedAtValue);
  const symbol = typeof item?.symbol === "string" ? item.symbol : "";
  const expected = expectedBySymbol.get(symbol);
  if (
    !item
    || !expected
    || Object.keys(item).length !== REALTIME_ITEM_KEYS.length
    || Object.keys(item).some((key) => !REALTIME_ITEM_KEYS.includes(key as typeof REALTIME_ITEM_KEYS[number]))
    || item.sourceSymbol !== expected.sourceSymbol
    || item.currency !== "USD"
    || typeof item.stale !== "boolean"
    || !ingestedAt
  ) {
    throw new TradingViewSidecarError(
      "invalid_response",
      "TradingView sidecar returned invalid realtime quote data.",
    );
  }
  if (item.price === null) {
    const nullableFields = [
      "previousClose",
      "change",
      "changePercent",
      "open",
      "high",
      "low",
      "volume",
      "session",
      "updatedAt",
    ] as const;
    if (!item.stale || nullableFields.some((field) => item[field] !== null)) {
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView sidecar returned malformed missing quote data.",
      );
    }
    return null;
  }

  const price = finiteNumber(item.price);
  const previousClose = finiteNumber(item.previousClose);
  const change = finiteNumber(item.change);
  const changePercent = finiteNumber(item.changePercent);
  const open = finiteNumber(item.open);
  const high = finiteNumber(item.high);
  const low = finiteNumber(item.low);
  const volume = finiteNumber(item.volume);
  const updatedAt = isoTimestamp(item.updatedAt);
  const sessionIsValid = item.session === null
    || (typeof item.session === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(item.session));
  if (
    price === null
    || price <= 0
    || previousClose === null
    || previousClose <= 0
    || change === null
    || changePercent === null
    || open === null
    || open <= 0
    || high === null
    || high <= 0
    || low === null
    || low <= 0
    || high < low
    || volume === null
    || volume < 0
    || !updatedAt
    || !sessionIsValid
  ) {
    throw new TradingViewSidecarError(
      "invalid_response",
      "TradingView sidecar returned malformed realtime quote values.",
    );
  }
  const ingestedAtMs = Date.parse(ingestedAt);
  const updatedAtMs = Date.parse(updatedAt);
  const observedNowMs = observedNow.getTime();
  if (
    ingestedAtMs > observedNowMs + MAX_FUTURE_CLOCK_SKEW_MS
    || updatedAtMs > observedNowMs + MAX_FUTURE_CLOCK_SKEW_MS
    || updatedAtMs > ingestedAtMs + MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    throw new TradingViewSidecarError(
      "invalid_response",
      "TradingView sidecar returned an invalid realtime quote timestamp.",
    );
  }
  const expectedChange = price - previousClose;
  const expectedChangePercent = (expectedChange / previousClose) * 100;
  if (
    Math.abs(change - expectedChange) > Math.max(0.01, price * 1e-8)
    || Math.abs(changePercent - expectedChangePercent) > 0.01
  ) {
    throw new TradingViewSidecarError(
      "invalid_response",
      "TradingView sidecar returned inconsistent realtime quote changes.",
    );
  }
  const observedDelay = Math.max(
    0,
    Math.min(900, Math.trunc((Date.parse(ingestedAt) - Date.parse(updatedAt)) / 1_000)),
  );
  const delaySeconds = item.stale ? 900 : observedDelay;
  return Object.freeze({
    instrumentId: expected.instrument.instrumentId,
    price,
    change,
    changePercent,
    previousClose,
    open,
    high,
    low,
    volume,
    currency: "USD",
    marketState: marketState(observedNow),
    delaySeconds,
    provenance: Object.freeze({
      providerId: manifest.id,
      sourceId: `tradingview-websocket:${expected.sourceSymbol}:realtime-quote`,
      asOf: updatedAt,
      ingestedAt,
      sourceUrl: TRADINGVIEW_SOURCE_URL,
    }),
  });
}

function normalizeRealtimeSnapshot(
  payload: unknown,
  requests: readonly RealtimeQuoteRequest[],
  observedNow: Date,
): readonly Quote[] {
  const root = asRecord(payload);
  if (
    root?.schemaVersion !== REALTIME_QUOTES_SCHEMA_VERSION
    || !["connected", "reconnecting", "disconnected"].includes(String(root.state))
    || !Array.isArray(root.items)
    || root.items.length !== requests.length
  ) {
    throw new TradingViewSidecarError(
      "invalid_response",
      "TradingView sidecar returned an invalid realtime snapshot.",
    );
  }
  const expectedBySymbol = new Map(requests.map((request) => [request.symbol, request]));
  const seen = new Set<string>();
  const quotes: Quote[] = [];
  for (let index = 0; index < root.items.length; index += 1) {
    const item = asRecord(root.items[index]);
    const expected = requests[index]!;
    if (item?.symbol !== expected.symbol || seen.has(expected.symbol)) {
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView sidecar returned a mismatched realtime snapshot.",
      );
    }
    seen.add(expected.symbol);
    const quote = normalizeRealtimeQuote(item, expectedBySymbol, root.ingestedAt, observedNow);
    if (quote) quotes.push(quote);
  }
  return Object.freeze(quotes);
}

export function createTradingViewSidecarProvider(
  env: ProviderEnvironment,
  dependencies: ProviderDependencies = {},
) {
  const baseUrl = sidecarBaseUrl(env);
  const token = env.UNICORN_TRADINGVIEW_SIDECAR_TOKEN?.trim();
  if (!loopbackHostname(baseUrl.hostname) && !token) {
    throw new TradingViewSidecarError(
      "configuration",
      "A TradingView sidecar token is required for remote HTTPS endpoints.",
    );
  }
  const timeoutMs = positiveInteger(env.UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxCandles = configuredCandleLimit(env.UNICORN_TRADINGVIEW_MAX_CANDLES);
  const syntheticExchanges = tradingViewSyntheticExchanges(env);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? (() => new Date());

  function realtimeRequestBody(requests: readonly RealtimeQuoteRequest[]): string {
    return JSON.stringify({
      items: requests.map((request) => ({
        symbol: request.symbol,
        mic: request.mic,
      })),
    });
  }

  function linkedRequestController(
    context: ProviderRequestContext,
  ): Readonly<{
    controller: AbortController;
    clearHandshakeTimeout: () => void;
    cleanup: () => void;
    timedOut: () => boolean;
  }> {
    const controller = new AbortController();
    let didTimeOut = false;
    const abortFromContext = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted) abortFromContext();
    else context.signal?.addEventListener("abort", abortFromContext, { once: true });
    const timer = setTimeout(() => {
      didTimeOut = true;
      controller.abort();
    }, timeoutMs);
    return Object.freeze({
      controller,
      clearHandshakeTimeout: () => clearTimeout(timer),
      cleanup: () => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abortFromContext);
      },
      timedOut: () => didTimeOut,
    });
  }

  async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView sidecar response exceeded the permitted size.",
      );
    }
    if (!response.body) {
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView sidecar returned an empty response.",
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
          throw new TradingViewSidecarError(
            "invalid_response",
            "TradingView sidecar response exceeded the permitted size.",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  async function openRealtimeResponse(
    path: "v1/realtime-quotes" | "v1/realtime-quotes/stream",
    requests: readonly RealtimeQuoteRequest[],
    context: ProviderRequestContext,
  ): Promise<Readonly<{
    response: Response;
    linked: ReturnType<typeof linkedRequestController>;
  }>> {
    if (
      requests.length < 1
      || requests.length > MAX_REALTIME_SYMBOLS
      || new Set(requests.map((request) => request.symbol)).size !== requests.length
    ) {
      throw new TradingViewSidecarError("invalid_request", "Realtime quote instruments are invalid.");
    }
    const linked = linkedRequestController(context);
    let response: Response;
    try {
      response = await fetchImplementation(new URL(path, baseUrl), {
        method: "POST",
        headers: {
          accept: path.endsWith("/stream") ? "text/event-stream" : "application/json",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: realtimeRequestBody(requests),
        cache: "no-store",
        signal: linked.controller.signal,
      });
      if (path.endsWith("/stream")) linked.clearHandshakeTimeout();
    } catch {
      linked.cleanup();
      if (linked.timedOut()) {
        throw new TradingViewSidecarError("request_timeout", "TradingView sidecar request timed out.");
      }
      throw new TradingViewSidecarError("upstream_error", "TradingView sidecar request failed.");
    }
    if (!response.ok) {
      linked.cleanup();
      await response.body?.cancel().catch(() => undefined);
      throw new TradingViewSidecarError(
        "upstream_error",
        "TradingView sidecar returned an unsuccessful response.",
        response.status,
      );
    }
    return Object.freeze({ response, linked });
  }

  async function requestRealtimeSnapshot(
    requests: readonly RealtimeQuoteRequest[],
    context: ProviderRequestContext,
  ): Promise<readonly Quote[]> {
    const { response, linked } = await openRealtimeResponse("v1/realtime-quotes", requests, context);
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        throw new TradingViewSidecarError(
          "invalid_response",
          "TradingView sidecar returned an invalid content type.",
        );
      }
      const text = await boundedResponseText(response, MAX_REALTIME_SNAPSHOT_BYTES);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new TradingViewSidecarError(
          "invalid_response",
          "TradingView sidecar returned invalid JSON.",
        );
      }
      return normalizeRealtimeSnapshot(payload, requests, now());
    } finally {
      linked.cleanup();
    }
  }

  async function requestRealtimeStream(
    requests: readonly RealtimeQuoteRequest[],
    context: ProviderRequestContext,
  ): Promise<ReadableStream<Quote>> {
    const { response, linked } = await openRealtimeResponse(
      "v1/realtime-quotes/stream",
      requests,
      context,
    );
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("text/event-stream") || !response.body) {
      linked.cleanup();
      await response.body?.cancel().catch(() => undefined);
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView sidecar returned an invalid event stream.",
      );
    }

    const upstream = response.body.getReader();
    const decoder = new TextDecoder();
    const expectedBySymbol = new Map(requests.map((request) => [request.symbol, request]));
    let canceled = false;

    return new ReadableStream<Quote>({
      start(controller) {
        void (async () => {
          let buffer = "";
          let eventName = "";
          let dataLines: string[] = [];
          let eventBytes = 0;

          const dispatch = () => {
            if (dataLines.length === 0) {
              eventName = "";
              eventBytes = 0;
              return;
            }
            let payload: unknown;
            try {
              payload = JSON.parse(dataLines.join("\n"));
            } catch {
              throw new TradingViewSidecarError(
                "invalid_response",
                "TradingView sidecar returned an invalid realtime event.",
              );
            }
            const root = asRecord(payload);
            if (eventName === "ready") {
              if (root?.type !== "ready") {
                throw new TradingViewSidecarError("invalid_response", "TradingView sidecar returned an invalid ready event.");
              }
              const quotes = normalizeRealtimeSnapshot(root, requests, now());
              for (const quote of quotes) controller.enqueue(quote);
              if (root.state !== "connected") {
                throw new TradingViewSidecarError("upstream_error", "TradingView realtime source is reconnecting.");
              }
            } else if (eventName === "quote") {
              if (root?.schemaVersion !== REALTIME_QUOTES_SCHEMA_VERSION || root.type !== "quote") {
                throw new TradingViewSidecarError("invalid_response", "TradingView sidecar returned an invalid quote event.");
              }
              const quote = normalizeRealtimeQuote(root.item, expectedBySymbol, root.ingestedAt, now());
              if (quote) controller.enqueue(quote);
            } else if (eventName === "status") {
              if (
                root?.schemaVersion !== REALTIME_QUOTES_SCHEMA_VERSION
                || root.type !== "status"
                || !["connected", "reconnecting", "disconnected"].includes(String(root.state))
                || !isoTimestamp(root.ingestedAt)
              ) {
                throw new TradingViewSidecarError("invalid_response", "TradingView sidecar returned an invalid status event.");
              }
              if (root.state !== "connected") {
                throw new TradingViewSidecarError("upstream_error", "TradingView realtime source disconnected.");
              }
            }
            eventName = "";
            dataLines = [];
            eventBytes = 0;
          };

          try {
            while (!canceled) {
              const { done, value } = await upstream.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              if (buffer.length > MAX_REALTIME_EVENT_BYTES * 2) {
                throw new TradingViewSidecarError("invalid_response", "TradingView realtime event exceeded the permitted size.");
              }
              while (true) {
                const newline = buffer.indexOf("\n");
                if (newline < 0) break;
                const line = buffer.slice(0, newline).replace(/\r$/, "");
                buffer = buffer.slice(newline + 1);
                if (line === "") {
                  dispatch();
                  continue;
                }
                if (line.startsWith(":")) continue;
                eventBytes += line.length;
                if (eventBytes > MAX_REALTIME_EVENT_BYTES) {
                  throw new TradingViewSidecarError("invalid_response", "TradingView realtime event exceeded the permitted size.");
                }
                if (line.startsWith("event:")) eventName = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
              }
            }
            if (!canceled) controller.close();
          } catch (error) {
            if (!canceled && !linked.controller.signal.aborted) controller.error(error);
            else if (!canceled) controller.close();
          } finally {
            canceled = true;
            linked.cleanup();
            await upstream.cancel().catch(() => undefined);
            upstream.releaseLock();
          }
        })();
      },
      async cancel(reason) {
        canceled = true;
        linked.controller.abort(reason);
        linked.cleanup();
        await upstream.cancel(reason).catch(() => undefined);
      },
    });
  }

  async function requestBars(
    instrument: Instrument,
    request: MarketBarsRequest,
    count = tradingViewCandleCount(request.range, request.interval),
  ): Promise<Readonly<{
    items: readonly MarketBar[];
    requestedCount: number;
    returnedCount: number;
    asOf: string;
    ingestedAt: string;
  }> | null> {
    const exchange = tradingViewExchange(instrument);
    if (!exchange || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(instrument.symbol)) return null;
    const url = new URL("v1/bars", baseUrl);
    url.searchParams.set("symbol", instrument.symbol);
    url.searchParams.set("exchange", exchange);
    url.searchParams.set("range", request.range);
    url.searchParams.set("interval", request.interval);
    const requestedCount = boundedCandleCount(count, maxCandles);
    url.searchParams.set("count", String(requestedCount));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new TradingViewSidecarError("request_timeout", "TradingView sidecar request timed out.");
      }
      throw new TradingViewSidecarError("upstream_error", "TradingView sidecar request failed.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new TradingViewSidecarError("upstream_error", "TradingView sidecar returned an unsuccessful response.", response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TradingViewSidecarError("invalid_response", "TradingView sidecar returned invalid JSON.");
    }
    return normalizeBars(payload, {
      symbol: instrument.symbol,
      interval: request.interval,
      range: request.range,
      requestedCount,
    });
  }

  async function requestLatestCloses(symbols: readonly string[]): Promise<readonly SyntheticLatestClose[]> {
    const normalizedSymbols = normalizeSyntheticSymbols(symbols);

    const url = new URL("v1/latest-closes", baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ symbols: normalizedSymbols }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new TradingViewSidecarError("request_timeout", "TradingView sidecar request timed out.");
      }
      throw new TradingViewSidecarError("upstream_error", "TradingView sidecar request failed.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new TradingViewSidecarError(
        "upstream_error",
        "TradingView sidecar returned an unsuccessful response.",
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TradingViewSidecarError("invalid_response", "TradingView sidecar returned invalid JSON.");
    }
    return normalizeLatestCloses(payload, normalizedSymbols, syntheticExchanges);
  }

  async function requestLatestCloseStream(
    symbols: readonly string[],
    context: ProviderRequestContext,
  ): Promise<ReadableStream<SyntheticLatestClose>> {
    const normalizedSymbols = normalizeSyntheticSymbols(symbols);
    const linked = linkedRequestController(context);
    let response: Response;
    try {
      response = await fetchImplementation(new URL("v1/latest-closes/stream", baseUrl), {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ symbols: normalizedSymbols }),
        cache: "no-store",
        signal: linked.controller.signal,
      });
      linked.clearHandshakeTimeout();
    } catch {
      linked.cleanup();
      if (linked.timedOut()) {
        throw new TradingViewSidecarError("request_timeout", "TradingView sidecar request timed out.");
      }
      throw new TradingViewSidecarError("upstream_error", "TradingView sidecar request failed.");
    }
    if (!response.ok) {
      linked.cleanup();
      await response.body?.cancel().catch(() => undefined);
      throw new TradingViewSidecarError(
        "upstream_error",
        "TradingView sidecar returned an unsuccessful response.",
        response.status,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("text/event-stream") || !response.body) {
      linked.cleanup();
      await response.body?.cancel().catch(() => undefined);
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView sidecar returned an invalid latest-close event stream.",
      );
    }

    const upstream = response.body.getReader();
    const decoder = new TextDecoder();
    const expectedSymbols = new Set(normalizedSymbols);
    let canceled = false;

    return new ReadableStream<SyntheticLatestClose>({
      start(controller) {
        void (async () => {
          let buffer = "";
          let eventName = "";
          let dataLines: string[] = [];
          let eventBytes = 0;

          const dispatch = () => {
            if (dataLines.length === 0) {
              eventName = "";
              eventBytes = 0;
              return;
            }
            let payload: unknown;
            try {
              payload = JSON.parse(dataLines.join("\n"));
            } catch {
              throw new TradingViewSidecarError(
                "invalid_response",
                "TradingView sidecar returned an invalid latest-close event.",
              );
            }
            const root = asRecord(payload);
            if (eventName === "ready") {
              if (
                !hasExactKeys(root, SYNTHETIC_READY_EVENT_KEYS)
                || root.type !== "ready"
                || !["connected", "reconnecting", "disconnected"].includes(String(root.state))
                || !isoTimestamp(root.ingestedAt)
              ) {
                throw new TradingViewSidecarError(
                  "invalid_response",
                  "TradingView sidecar returned an invalid latest-close ready event.",
                );
              }
              for (const item of normalizeLatestCloses(
                root,
                normalizedSymbols,
                syntheticExchanges,
              )) controller.enqueue(item);
            } else if (eventName === "quote") {
              const item = asRecord(root?.item);
              const symbol = typeof item?.symbol === "string" ? item.symbol : "";
              if (
                !hasExactKeys(root, SYNTHETIC_QUOTE_EVENT_KEYS)
                || root.schemaVersion !== SIDECAR_SCHEMA_VERSION
                || root.type !== "quote"
                || !expectedSymbols.has(symbol)
                || !isoTimestamp(root.ingestedAt)
              ) {
                throw new TradingViewSidecarError(
                  "invalid_response",
                  "TradingView sidecar returned an invalid latest-close quote event.",
                );
              }
              const [normalized] = normalizeLatestCloses(
                { ...root, items: [item] },
                [symbol],
                syntheticExchanges,
              );
              controller.enqueue(normalized!);
            } else if (eventName === "status") {
              if (
                !hasExactKeys(root, SYNTHETIC_STATUS_EVENT_KEYS)
                || root.schemaVersion !== SIDECAR_SCHEMA_VERSION
                || root.type !== "status"
                || !["connected", "reconnecting", "disconnected"].includes(String(root.state))
                || !isoTimestamp(root.ingestedAt)
              ) {
                throw new TradingViewSidecarError(
                  "invalid_response",
                  "TradingView sidecar returned an invalid latest-close status event.",
                );
              }
            } else {
              throw new TradingViewSidecarError(
                "invalid_response",
                "TradingView sidecar returned an unknown latest-close event.",
              );
            }
            eventName = "";
            dataLines = [];
            eventBytes = 0;
          };

          try {
            while (!canceled) {
              const { done, value } = await upstream.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              if (buffer.length > MAX_REALTIME_EVENT_BYTES * 2) {
                throw new TradingViewSidecarError(
                  "invalid_response",
                  "TradingView latest-close event exceeded the permitted size.",
                );
              }
              while (true) {
                const newline = buffer.indexOf("\n");
                if (newline < 0) break;
                const line = buffer.slice(0, newline).replace(/\r$/, "");
                buffer = buffer.slice(newline + 1);
                if (line === "") {
                  dispatch();
                  continue;
                }
                if (line.startsWith(":")) continue;
                eventBytes += line.length;
                if (eventBytes > MAX_REALTIME_EVENT_BYTES) {
                  throw new TradingViewSidecarError(
                    "invalid_response",
                    "TradingView latest-close event exceeded the permitted size.",
                  );
                }
                if (line.startsWith("event:")) eventName = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
              }
            }
            if (!canceled) controller.close();
          } catch (error) {
            if (!canceled && !linked.controller.signal.aborted) controller.error(error);
            else if (!canceled) controller.close();
          } finally {
            canceled = true;
            linked.cleanup();
            await upstream.cancel().catch(() => undefined);
            upstream.releaseLock();
          }
        })();
      },
      async cancel(reason) {
        canceled = true;
        linked.controller.abort(reason);
        linked.cleanup();
        await upstream.cancel(reason).catch(() => undefined);
      },
    });
  }

  return Object.freeze({
    manifest,
    syntheticMarket: Object.freeze({
      getLatestCloses: async (
        symbols: readonly string[],
        context: ProviderRequestContext,
      ): Promise<readonly SyntheticLatestClose[]> => {
        void context;
        return requestLatestCloses(symbols);
      },
      getLatestCloseStream: async (
        symbols: readonly string[],
        context: ProviderRequestContext,
      ): Promise<ReadableStream<SyntheticLatestClose>> => requestLatestCloseStream(symbols, context),
    }),
    market: Object.freeze({
      getQuote: async (
        instrument: Instrument,
        context: ProviderRequestContext,
      ): Promise<Quote | null> => {
        const requests = realtimeQuoteRequests([instrument]);
        if (requests.length !== 1) return null;
        return (await requestRealtimeSnapshot(requests, context))[0] ?? null;
      },
      getQuotes: async (
        instruments: readonly Instrument[],
        context: ProviderRequestContext,
      ): Promise<readonly Quote[]> => {
        const requests = realtimeQuoteRequests(instruments);
        if (requests.length === 0) return Object.freeze([]);
        return requestRealtimeSnapshot(requests, context);
      },
      getQuoteStream: async (
        instruments: readonly Instrument[],
        context: ProviderRequestContext,
      ): Promise<ReadableStream<Quote>> => {
        const requests = realtimeQuoteRequests(instruments);
        if (requests.length === 0) {
          throw new TradingViewSidecarError(
            "invalid_request",
            "Realtime quote instruments are invalid.",
          );
        }
        return requestRealtimeStream(requests, context);
      },
      getBars: async (
        instrument: Instrument,
        request: MarketBarsRequest,
      ): Promise<MarketBars | null> => {
        const normalized = await requestBars(
          instrument,
          request,
          request.count ?? tradingViewCandleCount(request.range, request.interval),
        );
        if (!normalized) return null;
        return Object.freeze({
          instrumentId: instrument.instrumentId,
          interval: request.interval,
          range: request.range,
          adjustment: "split_adjusted",
          items: normalized.items,
          requestedCount: normalized.requestedCount,
          returnedCount: normalized.returnedCount,
          provenance: Object.freeze({
            providerId: manifest.id,
            sourceId: `tradingview-websocket:${instrument.symbol}:${request.interval}`,
            asOf: normalized.asOf,
            ingestedAt: normalized.ingestedAt,
            sourceUrl: TRADINGVIEW_SOURCE_URL,
          }),
        });
      },
    }),
  });
}

export const tradingViewWebsocketProviderRegistration = {
  manifest,
  create: (env: ProviderEnvironment) => createTradingViewSidecarProvider(env),
} as const satisfies ProviderRegistration;
