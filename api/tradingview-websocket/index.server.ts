import {
  MAX_MARKET_BAR_COUNT,
  MIN_MARKET_BAR_COUNT,
  PROVIDER_SCHEMA_VERSION,
  SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS,
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

const SIDECAR_SCHEMA_VERSION = "trader.tradingview-sidecar.v1";
const REALTIME_QUOTES_SCHEMA_VERSION = "trader.tradingview-realtime-quotes.v1";
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_TIMEOUT_MS = 65_000;
const TRADINGVIEW_SOURCE_URL = "wss://data.tradingview.com/socket.io/websocket";
const TRADINGVIEW_WORKER_UPGRADE_URL = "https://data.tradingview.com/socket.io/websocket";
const MAX_LATEST_CLOSE_SYMBOLS = 50;
const MAX_REALTIME_SYMBOLS = 50;
const MAX_SYNTHETIC_EXCHANGES = 8;
const MAX_REALTIME_EVENT_BYTES = 64 * 1_024;
const MAX_REALTIME_SNAPSHOT_BYTES = 256 * 1_024;
const MAX_LATEST_CLOSE_SNAPSHOT_BYTES = 256 * 1_024;
const TRADINGVIEW_SCANNER_URL = "https://scanner.tradingview.com/crypto/scan";
const TRADINGVIEW_SCANNER_COLUMNS = Object.freeze([
  "close",
  "update_time",
  "currency",
  "update_mode",
  "type",
  "subtype",
  "exchange",
] as const);
const MAX_TRADINGVIEW_SCANNER_RESPONSE_BYTES = 512 * 1_024;
const MAX_FUTURE_CLOCK_SKEW_MS = 60_000;
const TRADINGVIEW_SCANNER_RELATIVE_FRESHNESS_MS = SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS;
const TRADINGVIEW_WORKER_STREAM_TTL_MS = 60_000;
const TRADINGVIEW_WORKER_LIVENESS_TIMEOUT_MS = 45_000;
const TRADINGVIEW_WORKER_FRESHNESS_CHECK_MS = 15_000;
const TRADINGVIEW_WORKER_QUOTE_INITIAL_WAIT_MS = 5_000;
const TRADINGVIEW_WORKER_QUOTE_LONG_POLL_WAIT_MS = 20_000;
const TRADINGVIEW_WORKER_QUOTE_HANDSHAKE_WAIT_MS = 5_000;
const MAX_TRADINGVIEW_WORKER_FRAME_BYTES = 64 * 1_024;
const MAX_TRADINGVIEW_WORKER_BUFFER_BYTES = 128 * 1_024;
const MAX_TRADINGVIEW_WORKER_PENDING_ITEMS = 512;
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
  requiredEnv: ["TRADER_TRADINGVIEW_SIDECAR_URL"],
} as const;

export type TradingViewSidecarFetch = typeof globalThis.fetch;

export type TradingViewScannerDependencies = Readonly<{
  fetch?: TradingViewSidecarFetch;
  now?: () => Date;
}>;

export type TradingViewWorkerWebSocket = Readonly<{
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  accept?: () => void;
  addEventListener: (
    type: "message" | "close" | "error",
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener: (
    type: "message" | "close" | "error",
    listener: EventListenerOrEventListenerObject,
  ) => void;
}>;

export type TradingViewWorkerStreamDependencies = Readonly<{
  connect?: (signal: AbortSignal) => Promise<TradingViewWorkerWebSocket>;
  fetch?: TradingViewSidecarFetch;
  now?: () => Date;
  sessionId?: () => string;
  streamTtlMs?: number;
  livenessTimeoutMs?: number;
  freshnessCheckMs?: number;
}>;

export type TradingViewWorkerQuoteCursor = Readonly<{
  asOf: string;
  price: number;
}>;

export type TradingViewWorkerQuoteLongPollDependencies = Readonly<{
  connect?: (signal: AbortSignal) => Promise<TradingViewWorkerWebSocket>;
  fetch?: TradingViewSidecarFetch;
  now?: () => Date;
  sessionId?: () => string;
  initialWaitMs?: number;
  longPollWaitMs?: number;
  handshakeWaitMs?: number;
}>;

export type TradingViewWorkerQuoteLongPollResult = Readonly<{
  quotes: readonly Quote[];
  reason: "initial" | "changed" | "timeout";
}>;

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
  const configured = env.TRADER_TRADINGVIEW_SYNTHETIC_EXCHANGES?.trim();
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
  const configured = env.TRADER_TRADINGVIEW_SIDECAR_URL?.trim();
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

/** Strict allowlist for TradingView's `current_session` quote field. */
export function tradingViewMarketSessionState(value: unknown): MarketSessionState | null {
  if (typeof value !== "string") return null;
  switch (value) {
    case "market":
    case "regular":
      return "regular";
    case "pre_market":
    case "premarket":
      return "pre_market";
    case "post_market":
    case "postmarket":
    case "after_hours":
      return "after_hours";
    case "closed":
    case "out_of_session":
    case "holiday":
    case "night":
      return "closed";
    default:
      return null;
  }
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
      || open <= 0
      || high <= 0
      || low <= 0
      || close <= 0
      || volume < 0
      || high < Math.max(open, close, low)
      || low > Math.min(open, close, high)
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

/**
 * Worker-compatible snapshot fallback for the exact ticker-derived perpetuals
 * used by the local TradingView websocket sidecar. The browser supplies only
 * canonical U.S. tickers; raw TradingView identifiers remain server-derived.
 */
export async function loadTradingViewScannerLatestCloses(
  env: ProviderEnvironment,
  symbols: readonly string[],
  context: ProviderRequestContext,
  dependencies: TradingViewScannerDependencies = {},
): Promise<readonly SyntheticLatestClose[]> {
  const normalizedSymbols = normalizeSyntheticSymbols(symbols);
  const exchanges = tradingViewSyntheticExchanges(env);
  const sourceSymbols = normalizedSymbols.flatMap((symbol) => (
    exchanges.map((exchange) => `${exchange}:${symbol}USDT.P`)
  ));
  const expectedSources = new Set(sourceSymbols);
  const timeoutMs = positiveInteger(
    env.TRADER_TRADINGVIEW_SIDECAR_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const observedNow = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(observedNow.getTime())) {
    throw new TradingViewSidecarError(
      "configuration",
      "TradingView scanner clock is invalid.",
    );
  }

  const controller = new AbortController();
  let didTimeOut = false;
  const abortFromContext = () => controller.abort(context.signal?.reason);
  if (context.signal?.aborted) abortFromContext();
  else context.signal?.addEventListener("abort", abortFromContext, { once: true });
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetchImplementation(TRADINGVIEW_SCANNER_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        "content-type": "application/json",
        pragma: "no-cache",
      },
      body: JSON.stringify({
        symbols: { tickers: sourceSymbols, query: { types: [] } },
        columns: TRADINGVIEW_SCANNER_COLUMNS,
        range: [0, sourceSymbols.length],
      }),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abortFromContext);
    if (didTimeOut) {
      throw new TradingViewSidecarError(
        "request_timeout",
        "TradingView scanner request timed out.",
      );
    }
    throw new TradingViewSidecarError(
      "upstream_error",
      "TradingView scanner request failed.",
    );
  }
  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new TradingViewSidecarError(
        "upstream_error",
        "TradingView scanner returned an unsuccessful response.",
        response.status,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      !contentType.toLowerCase().startsWith("application/json")
      || (Number.isFinite(declaredLength)
        && declaredLength > MAX_TRADINGVIEW_SCANNER_RESPONSE_BYTES)
      || !response.body
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView scanner returned an invalid response.",
      );
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_TRADINGVIEW_SCANNER_RESPONSE_BYTES) {
          throw new TradingViewSidecarError(
            "invalid_response",
            "TradingView scanner response exceeded the permitted size.",
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      if (didTimeOut) {
        throw new TradingViewSidecarError(
          "request_timeout",
          "TradingView scanner request timed out.",
        );
      }
      if (error instanceof TradingViewSidecarError) throw error;
      throw new TradingViewSidecarError(
        "upstream_error",
        "TradingView scanner response stream failed.",
      );
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView scanner returned invalid JSON.",
      );
    }
    const root = asRecord(payload);
    if (
      !hasExactKeys(root, ["totalCount", "data"])
      || !Number.isSafeInteger(root.totalCount)
      || !Array.isArray(root.data)
      || root.totalCount !== root.data.length
      || root.data.length > sourceSymbols.length
    ) {
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView scanner returned an invalid result set.",
      );
    }

    const seenSources = new Set<string>();
    const values = new Map<string, Readonly<{
      close: number;
      updatedAt: string;
      updatedAtMilliseconds: number;
    }>>();
    for (const candidate of root.data) {
      const row = asRecord(candidate);
      const sourceSymbol = typeof row?.s === "string" ? row.s : "";
      if (
        !hasExactKeys(row, ["s", "d"])
        || !expectedSources.has(sourceSymbol)
        || seenSources.has(sourceSymbol)
        || !Array.isArray(row.d)
        || row.d.length !== TRADINGVIEW_SCANNER_COLUMNS.length
      ) {
        throw new TradingViewSidecarError(
          "invalid_response",
          "TradingView scanner returned an unexpected symbol.",
        );
      }
      seenSources.add(sourceSymbol);
      const [
        rawClose,
        rawUpdatedAt,
        currency,
        updateMode,
        instrumentType,
        instrumentSubtype,
        returnedExchange,
      ] = row.d;
      const expectedExchange = sourceSymbol.slice(0, sourceSymbol.indexOf(":"));
      if (
        currency !== "USDT"
        || updateMode !== "streaming"
        || instrumentType !== "swap"
        || instrumentSubtype !== "crypto"
        || returnedExchange !== expectedExchange
      ) {
        throw new TradingViewSidecarError(
          "invalid_response",
          "TradingView scanner returned mislabeled quote data.",
        );
      }
      if (rawClose === null && rawUpdatedAt === null) continue;
      const close = finiteNumber(rawClose);
      const updatedAtSeconds = finiteNumber(rawUpdatedAt);
      const updatedAtMilliseconds = updatedAtSeconds === null
        ? Number.NaN
        : updatedAtSeconds * 1_000;
      if (
        close === null
        || close <= 0
        || updatedAtSeconds === null
        || !Number.isSafeInteger(updatedAtSeconds)
        || updatedAtSeconds <= 0
        || !Number.isFinite(updatedAtMilliseconds)
        || updatedAtMilliseconds > observedNow.getTime() + MAX_FUTURE_CLOCK_SKEW_MS
      ) {
        throw new TradingViewSidecarError(
          "invalid_response",
          "TradingView scanner returned malformed quote data.",
        );
      }
      // These contracts trade continuously. An old last bar is not a current
      // reference price, even when every configured venue returned the same
      // closed/stuck snapshot.
      if (
        observedNow.getTime() - updatedAtMilliseconds
        > SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS
      ) continue;
      values.set(sourceSymbol, Object.freeze({
        close,
        updatedAt: new Date(updatedAtMilliseconds).toISOString(),
        updatedAtMilliseconds,
      }));
    }

    return Object.freeze(normalizedSymbols.map((symbol) => {
      const availableValues = exchanges.flatMap((exchange) => {
        const sourceSymbol = `${exchange}:${symbol}USDT.P`;
        const value = values.get(sourceSymbol);
        return value ? [{ sourceSymbol, value }] : [];
      });
      const freshestUpdatedAt = Math.max(
        ...availableValues.map(({ value }) => value.updatedAtMilliseconds),
      );
      // Preserve configured exchange priority within one freshness cohort, but
      // never let a markedly older high-priority venue mask a current lower one.
      const selected = availableValues.find(({ value }) => (
        freshestUpdatedAt - value.updatedAtMilliseconds
        < TRADINGVIEW_SCANNER_RELATIVE_FRESHNESS_MS
      ));
      if (selected) {
        return Object.freeze({
          symbol,
          sourceSymbol: selected.sourceSymbol,
          close: selected.value.close,
          currency: "USDT" as const,
          source: manifest.id,
          updatedAt: selected.value.updatedAt,
        });
      }
      return Object.freeze({
        symbol,
        sourceSymbol: `${exchanges[0]}:${symbol}USDT.P`,
        close: null,
        currency: "USDT" as const,
        source: manifest.id,
        updatedAt: null,
      });
    }));
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abortFromContext);
  }
}

const TRADINGVIEW_WORKER_QUOTE_FIELDS = Object.freeze([
  "lp",
  "lp_time",
  "ch",
  "chp",
  "current_session",
  "currency_code",
  "volume",
  "open_price",
  "high_price",
  "low_price",
  "prev_close_price",
  "update_mode",
  "exchange",
  "pro_name",
  // Scanner and websocket results must both prove that a ticker-derived
  // source is the requested perpetual contract, rather than merely sharing a
  // name and quote currency.
  "type",
] as const);

type TradingViewWorkerQuote = Readonly<{
  close: number;
  updatedAt: string;
  updatedAtMilliseconds: number;
}>;

type TradingViewWorkerSource = Readonly<{
  symbol: string;
  exchange: string;
  sourceSymbol: string;
}>;

function boundedWorkerDuration(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(10, Math.min(maximum, Math.trunc(value)));
}

function tradingViewWorkerSessionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `qs_${Array.from(bytes, (value) => String.fromCharCode(97 + (value % 26))).join("")}`;
}

function tradingViewFrame(payload: string): string {
  const length = new TextEncoder().encode(payload).byteLength;
  return `~m~${length}~m~${payload}`;
}

function tradingViewProtocolMessage(method: string, parameters: readonly unknown[]): string {
  return tradingViewFrame(JSON.stringify({ m: method, p: parameters }));
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

function workerSocketMessageData(event: Event): unknown {
  return (event as Event & Readonly<{ data?: unknown }>).data;
}

/**
 * Sites runs this route in Cloudflare Workers, where `WebSocketPair` and
 * outbound websocket-upgrade fetches are available. Keeping this capability
 * check Worker-specific prevents a plain Node server without the Python
 * sidecar from advertising a stream it cannot open.
 */
export function tradingViewWorkerLatestCloseStreamSupported(): boolean {
  return typeof (globalThis as typeof globalThis & Readonly<{
    WebSocketPair?: unknown;
  }>).WebSocketPair === "function";
}

async function connectTradingViewWorkerWebSocket(
  signal: AbortSignal,
  fetchImplementation: TradingViewSidecarFetch,
): Promise<TradingViewWorkerWebSocket> {
  const response = await fetchImplementation(TRADINGVIEW_WORKER_UPGRADE_URL, {
    cache: "no-store",
    headers: {
      "cache-control": "no-cache",
      origin: "https://data.tradingview.com",
      pragma: "no-cache",
      upgrade: "websocket",
    },
    signal,
  });
  const websocket = (response as Response & Readonly<{
    webSocket?: TradingViewWorkerWebSocket | null;
  }>).webSocket;
  if (!websocket) {
    await response.body?.cancel().catch(() => undefined);
    throw new TradingViewSidecarError(
      "upstream_error",
      "TradingView websocket upgrade was not accepted.",
      response.status,
    );
  }
  websocket.accept?.();
  return websocket;
}

/**
 * Open the same guest TradingView quote session used by the local Python
 * sidecar, directly from a Sites Worker. Raw upstream symbols remain wholly
 * server-derived as `{EXCHANGE}:{symbol}USDT.P` and every emitted item is
 * normalized back to the existing `tradingview-websocket` contract.
 */
export async function createTradingViewWorkerLatestCloseStream(
  env: ProviderEnvironment,
  symbols: readonly string[],
  context: ProviderRequestContext,
  dependencies: TradingViewWorkerStreamDependencies = {},
): Promise<ReadableStream<SyntheticLatestClose>> {
  const normalizedSymbols = normalizeSyntheticSymbols(symbols);
  const exchanges = tradingViewSyntheticExchanges(env);
  const sourceItems: readonly TradingViewWorkerSource[] = Object.freeze(
    normalizedSymbols.flatMap((symbol) => exchanges.map((exchange) => Object.freeze({
      symbol,
      exchange,
      sourceSymbol: `${exchange}:${symbol}USDT.P`,
    }))),
  );
  const sourceByName = new Map(sourceItems.map((item) => [item.sourceSymbol, item]));
  const now = dependencies.now ?? (() => new Date());
  const sessionId = (dependencies.sessionId ?? tradingViewWorkerSessionId)();
  if (!/^qs_[a-z]{12}$/.test(sessionId)) {
    throw new TradingViewSidecarError(
      "configuration",
      "TradingView worker quote-session identifier is invalid.",
    );
  }
  const timeoutMs = positiveInteger(
    env.TRADER_TRADINGVIEW_SIDECAR_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const streamTtlMs = boundedWorkerDuration(
    dependencies.streamTtlMs,
    TRADINGVIEW_WORKER_STREAM_TTL_MS,
    5 * 60_000,
  );
  const livenessTimeoutMs = boundedWorkerDuration(
    dependencies.livenessTimeoutMs,
    TRADINGVIEW_WORKER_LIVENESS_TIMEOUT_MS,
    5 * 60_000,
  );
  const freshnessCheckMs = boundedWorkerDuration(
    dependencies.freshnessCheckMs,
    TRADINGVIEW_WORKER_FRESHNESS_CHECK_MS,
    SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS,
  );
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const connect = dependencies.connect ?? (
    (signal: AbortSignal) => connectTradingViewWorkerWebSocket(signal, fetchImplementation)
  );

  // The upgrade signal is handshake-only. Aborting it after a successful
  // Cloudflare websocket upgrade makes workerd report a noisy AbortError even
  // when the downstream SSE client simply disconnects. Once connected, close
  // the accepted websocket explicitly from the stream's cancellation path.
  const handshakeController = new AbortController();
  let didTimeOut = false;
  const abortHandshakeFromContext = () => handshakeController.abort(context.signal?.reason);
  if (context.signal?.aborted) abortHandshakeFromContext();
  else context.signal?.addEventListener("abort", abortHandshakeFromContext, { once: true });
  const handshakeTimer = setTimeout(() => {
    didTimeOut = true;
    handshakeController.abort();
  }, timeoutMs);

  let websocket: TradingViewWorkerWebSocket;
  try {
    const pendingConnection = Promise.resolve().then(
      () => connect(handshakeController.signal),
    );
    websocket = await new Promise<TradingViewWorkerWebSocket>((resolve, reject) => {
      const abortConnection = () => reject(
        handshakeController.signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
      if (handshakeController.signal.aborted) abortConnection();
      else handshakeController.signal.addEventListener("abort", abortConnection, { once: true });
      void pendingConnection.then((connected) => {
        handshakeController.signal.removeEventListener("abort", abortConnection);
        if (handshakeController.signal.aborted) {
          try {
            connected.close(1000, "request ended");
          } catch {
            // The failed handshake remains sanitized as a provider error.
          }
          abortConnection();
          return;
        }
        resolve(connected);
      }, (error: unknown) => {
        handshakeController.signal.removeEventListener("abort", abortConnection);
        reject(error);
      });
    });
  } catch (error) {
    clearTimeout(handshakeTimer);
    context.signal?.removeEventListener("abort", abortHandshakeFromContext);
    if (didTimeOut) {
      throw new TradingViewSidecarError(
        "request_timeout",
        "TradingView websocket connection timed out.",
      );
    }
    if (error instanceof TradingViewSidecarError) throw error;
    throw new TradingViewSidecarError(
      "upstream_error",
      "TradingView websocket connection failed.",
    );
  }
  clearTimeout(handshakeTimer);
  context.signal?.removeEventListener("abort", abortHandshakeFromContext);

  let cancelConnectedStream: (() => void) | undefined;

  return new ReadableStream<SyntheticLatestClose>({
    start(controller) {
      const rawQuoteValues = new Map<string, JsonRecord>();
      const latestEpochBySource = new Map<string, number>();
      const quotesBySource = new Map<string, TradingViewWorkerQuote>();
      const selectedBySymbol = new Map<string, SyntheticLatestClose>();
      const textEncoder = new TextEncoder();
      const textDecoder = new TextDecoder("utf-8", { fatal: true });
      let frameBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      let closed = false;
      let ttlTimer: ReturnType<typeof setTimeout> | undefined;
      let livenessTimer: ReturnType<typeof setTimeout> | undefined;
      let freshnessTimer: ReturnType<typeof setInterval> | undefined;

      const missingItem = (symbol: string): SyntheticLatestClose => Object.freeze({
        symbol,
        sourceSymbol: `${exchanges[0]}:${symbol}USDT.P`,
        close: null,
        currency: "USDT",
        source: manifest.id,
        updatedAt: null,
      });

      const observedNowMilliseconds = (): number => {
        const value = now().getTime();
        if (!Number.isFinite(value)) {
          throw new TradingViewSidecarError(
            "configuration",
            "TradingView worker clock is invalid.",
          );
        }
        return value;
      };

      const selectedItem = (symbol: string): SyntheticLatestClose => {
        const observedAt = observedNowMilliseconds();
        const candidates = exchanges.flatMap((exchange) => {
          const sourceSymbol = `${exchange}:${symbol}USDT.P`;
          const value = quotesBySource.get(sourceSymbol);
          if (!value) return [];
          const age = observedAt - value.updatedAtMilliseconds;
          return age >= -MAX_FUTURE_CLOCK_SKEW_MS
            && age <= SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS
            ? [{ sourceSymbol, value }]
            : [];
        });
        if (candidates.length === 0) return missingItem(symbol);
        const freshest = Math.max(
          ...candidates.map(({ value }) => value.updatedAtMilliseconds),
        );
        const selected = candidates.find(({ value }) => (
          freshest - value.updatedAtMilliseconds
          < SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS
        ));
        if (!selected) return missingItem(symbol);
        return Object.freeze({
          symbol,
          sourceSymbol: selected.sourceSymbol,
          close: selected.value.close,
          currency: "USDT",
          source: manifest.id,
          updatedAt: selected.value.updatedAt,
        });
      };

      const sameItem = (left: SyntheticLatestClose, right: SyntheticLatestClose): boolean => (
        left.symbol === right.symbol
        && left.sourceSymbol === right.sourceSymbol
        && left.close === right.close
        && left.currency === right.currency
        && left.source === right.source
        && left.updatedAt === right.updatedAt
      );

      const enqueue = (item: SyntheticLatestClose) => {
        if (closed) return;
        if (
          controller.desiredSize !== null
          && controller.desiredSize < -MAX_TRADINGVIEW_WORKER_PENDING_ITEMS
        ) {
          throw new TradingViewSidecarError(
            "upstream_error",
            "TradingView worker stream consumer is too slow.",
          );
        }
        controller.enqueue(item);
      };

      const emitSelected = (symbol: string) => {
        const item = selectedItem(symbol);
        const previous = selectedBySymbol.get(symbol);
        if (previous && sameItem(previous, item)) return;
        selectedBySymbol.set(symbol, item);
        enqueue(item);
      };

      const emitAllSelected = () => {
        for (const symbol of normalizedSymbols) emitSelected(symbol);
      };

      const clearTimers = () => {
        if (ttlTimer) clearTimeout(ttlTimer);
        if (livenessTimer) clearTimeout(livenessTimer);
        if (freshnessTimer) clearInterval(freshnessTimer);
      };

      const removeListeners = () => {
        websocket.removeEventListener("message", onMessage);
        websocket.removeEventListener("close", onClose);
        websocket.removeEventListener("error", onError);
        context.signal?.removeEventListener("abort", onAbort);
      };

      const disposeSocket = () => {
        try {
          websocket.close(1000, "stream ended");
        } catch {
          // Closing an already-closed upstream socket is harmless.
        }
      };

      const finish = (error?: TradingViewSidecarError) => {
        if (closed) return;
        closed = true;
        clearTimers();
        removeListeners();
        disposeSocket();
        try {
          if (error) controller.error(error);
          else controller.close();
        } catch {
          // A downstream cancel can race the upstream close event.
        }
      };

      const resetLivenessTimer = () => {
        if (livenessTimer) clearTimeout(livenessTimer);
        livenessTimer = setTimeout(() => finish(new TradingViewSidecarError(
          "upstream_error",
          "TradingView websocket became unresponsive.",
        )), livenessTimeoutMs);
      };

      const quoteFieldMatches = (
        values: JsonRecord,
        field: string,
        expected: string,
        normalize = false,
      ): boolean => {
        const value = values[field];
        if (value === undefined) return true;
        if (typeof value !== "string") return false;
        return (normalize ? value.normalize("NFKC").trim().toUpperCase() : value) === expected;
      };

      const handleQuoteData = (quote: JsonRecord) => {
        const sourceSymbol = typeof quote.n === "string" ? quote.n : "";
        const requested = sourceByName.get(sourceSymbol);
        if (!requested) return;
        if (quote.s === "error" || quote.s === "permission_denied") {
          quotesBySource.delete(sourceSymbol);
          emitSelected(requested.symbol);
          return;
        }
        if (quote.s !== "ok") return;
        const values = asRecord(quote.v);
        if (!values) return;
        const merged: JsonRecord = { ...(rawQuoteValues.get(sourceSymbol) ?? {}) };
        for (const field of TRADINGVIEW_WORKER_QUOTE_FIELDS) {
          if (field in values) merged[field] = values[field];
        }
        if (
          !quoteFieldMatches(merged, "currency_code", "USDT")
          || !quoteFieldMatches(merged, "update_mode", "streaming")
          || !quoteFieldMatches(merged, "type", "swap")
          || !quoteFieldMatches(merged, "exchange", requested.exchange, true)
          || !quoteFieldMatches(merged, "pro_name", sourceSymbol)
        ) return;
        rawQuoteValues.set(sourceSymbol, merged);

        const close = finiteNumber(merged.lp);
        const epochSeconds = finiteNumber(merged.lp_time);
        if (
          close === null
          || close <= 0
          || epochSeconds === null
          || epochSeconds <= 0
          || merged.currency_code !== "USDT"
          || merged.update_mode !== "streaming"
          || merged.type !== "swap"
          || typeof merged.exchange !== "string"
          || merged.exchange.normalize("NFKC").trim().toUpperCase() !== requested.exchange
          || merged.pro_name !== sourceSymbol
        ) return;
        const previousEpoch = latestEpochBySource.get(sourceSymbol);
        if (previousEpoch !== undefined && epochSeconds < previousEpoch) return;
        const updatedAtMilliseconds = Math.trunc(epochSeconds * 1_000);
        if (
          !Number.isSafeInteger(updatedAtMilliseconds)
          || updatedAtMilliseconds <= 0
          || updatedAtMilliseconds > 8_640_000_000_000_000
        ) return;
        const updatedAt = new Date(updatedAtMilliseconds).toISOString();
        const previous = quotesBySource.get(sourceSymbol);
        latestEpochBySource.set(sourceSymbol, epochSeconds);
        if (
          previous?.close === close
          && previous.updatedAtMilliseconds === updatedAtMilliseconds
        ) return;
        quotesBySource.set(sourceSymbol, Object.freeze({
          close,
          updatedAt,
          updatedAtMilliseconds,
        }));
        emitSelected(requested.symbol);
      };

      const handlePayload = (payload: string) => {
        if (payload.startsWith("~h~")) {
          websocket.send(tradingViewFrame(payload));
          emitAllSelected();
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(payload);
        } catch {
          return;
        }
        const root = asRecord(message);
        if (!root || !Array.isArray(root.p)) return;
        if (root.m === "qsd") {
          if (root.p.length < 2 || root.p[0] !== sessionId) return;
          const quote = asRecord(root.p[1]);
          if (quote) handleQuoteData(quote);
          return;
        }
        if (
          (root.m === "critical_error" || root.m === "protocol_error")
          && root.p.length > 0
          && root.p[0] === sessionId
        ) {
          throw new TradingViewSidecarError(
            "upstream_error",
            "TradingView quote session failed.",
          );
        }
      };

      const consumeFrames = (chunk: string) => {
        frameBuffer = appendBytes(frameBuffer, textEncoder.encode(chunk));
        if (frameBuffer.byteLength > MAX_TRADINGVIEW_WORKER_BUFFER_BYTES) {
          throw new TradingViewSidecarError(
            "invalid_response",
            "TradingView websocket frame buffer exceeded the permitted size.",
          );
        }
        while (frameBuffer.byteLength > 0) {
          if (
            frameBuffer.byteLength < 3
            || frameBuffer[0] !== 126
            || frameBuffer[1] !== 109
            || frameBuffer[2] !== 126
          ) {
            throw new TradingViewSidecarError(
              "invalid_response",
              "TradingView websocket returned invalid framing.",
            );
          }
          let delimiter = -1;
          for (let index = 3; index + 2 < frameBuffer.byteLength; index += 1) {
            if (
              frameBuffer[index] === 126
              && frameBuffer[index + 1] === 109
              && frameBuffer[index + 2] === 126
            ) {
              delimiter = index;
              break;
            }
          }
          if (delimiter < 0) return;
          const lengthText = String.fromCharCode(...frameBuffer.slice(3, delimiter));
          if (!/^[1-9][0-9]{0,5}$/.test(lengthText)) {
            throw new TradingViewSidecarError(
              "invalid_response",
              "TradingView websocket returned an invalid frame length.",
            );
          }
          const payloadLength = Number(lengthText);
          if (payloadLength > MAX_TRADINGVIEW_WORKER_FRAME_BYTES) {
            throw new TradingViewSidecarError(
              "invalid_response",
              "TradingView websocket frame exceeded the permitted size.",
            );
          }
          const payloadStart = delimiter + 3;
          const payloadEnd = payloadStart + payloadLength;
          if (frameBuffer.byteLength < payloadEnd) return;
          let payload: string;
          try {
            payload = textDecoder.decode(frameBuffer.slice(payloadStart, payloadEnd));
          } catch {
            throw new TradingViewSidecarError(
              "invalid_response",
              "TradingView websocket returned invalid UTF-8.",
            );
          }
          frameBuffer = frameBuffer.slice(payloadEnd);
          handlePayload(payload);
        }
      };

      const onMessage: EventListener = (event) => {
        if (closed) return;
        const data = workerSocketMessageData(event);
        if (typeof data !== "string") return;
        resetLivenessTimer();
        try {
          consumeFrames(data);
        } catch (error) {
          finish(error instanceof TradingViewSidecarError
            ? error
            : new TradingViewSidecarError(
              "invalid_response",
              "TradingView websocket returned invalid data.",
            ));
        }
      };
      const onClose: EventListener = () => finish(new TradingViewSidecarError(
        "upstream_error",
        "TradingView websocket closed unexpectedly.",
      ));
      const onError: EventListener = () => finish(new TradingViewSidecarError(
        "upstream_error",
        "TradingView websocket failed.",
      ));
      const onAbort = () => finish();
      cancelConnectedStream = onAbort;

      websocket.addEventListener("message", onMessage);
      websocket.addEventListener("close", onClose);
      websocket.addEventListener("error", onError);
      context.signal?.addEventListener("abort", onAbort, { once: true });

      if (context.signal?.aborted) {
        onAbort();
        return;
      }

      try {
        // This mirrors `RealtimeQuoteBroker._run`: one guest quote session and
        // a two-argument `quote_add_symbols` call for every derived source.
        for (const symbol of normalizedSymbols) {
          const initial = missingItem(symbol);
          selectedBySymbol.set(symbol, initial);
          enqueue(initial);
        }
        websocket.send(tradingViewProtocolMessage(
          "set_auth_token",
          ["unauthorized_user_token"],
        ));
        websocket.send(tradingViewProtocolMessage("quote_create_session", [sessionId]));
        websocket.send(tradingViewProtocolMessage(
          "quote_set_fields",
          [sessionId, ...TRADINGVIEW_WORKER_QUOTE_FIELDS],
        ));
        for (const item of sourceItems) {
          websocket.send(tradingViewProtocolMessage(
            "quote_add_symbols",
            [sessionId, item.sourceSymbol],
          ));
        }
        resetLivenessTimer();
        freshnessTimer = setInterval(() => {
          try {
            emitAllSelected();
          } catch (error) {
            finish(error instanceof TradingViewSidecarError
              ? error
              : new TradingViewSidecarError(
                "configuration",
                "TradingView worker clock is invalid.",
              ));
          }
        }, freshnessCheckMs);
        ttlTimer = setTimeout(() => finish(), streamTtlMs);
      } catch (error) {
        finish(error instanceof TradingViewSidecarError
          ? error
          : new TradingViewSidecarError(
            "upstream_error",
            "TradingView websocket subscription failed.",
          ));
      }
    },
    cancel() {
      cancelConnectedStream?.();
    },
  }, {
    highWaterMark: MAX_TRADINGVIEW_WORKER_PENDING_ITEMS,
  });
}

function normalizeTradingViewWorkerRegularQuote(
  values: JsonRecord,
  expected: RealtimeQuoteRequest,
  observedNow: Date,
): Quote | null {
  const sourceExchange = expected.sourceSymbol.slice(0, expected.sourceSymbol.indexOf(":"));
  const returnedExchange = typeof values.exchange === "string"
    ? values.exchange.normalize("NFKC").trim().toUpperCase()
    : "";
  const expectedType = expected.instrument.assetType === "adr" ? "dr" : "stock";
  if (
    values.currency_code !== "USD"
    || values.update_mode !== "streaming"
    || values.type !== expectedType
    // TradingView guest USD quotes currently identify their real-time tape as
    // Cboe One even though `pro_name` retains the requested primary listing.
    || (returnedExchange !== sourceExchange && returnedExchange !== "CBOE ONE")
    || values.pro_name !== expected.sourceSymbol
  ) return null;

  const price = finiteNumber(values.lp);
  const epochSeconds = finiteNumber(values.lp_time);
  const previousClose = finiteNumber(values.prev_close_price);
  const open = finiteNumber(values.open_price);
  const high = finiteNumber(values.high_price);
  const low = finiteNumber(values.low_price);
  const volume = finiteNumber(values.volume);
  const observedAtMilliseconds = observedNow.getTime();
  const updatedAtMilliseconds = epochSeconds === null
    ? Number.NaN
    : Math.trunc(epochSeconds * 1_000);
  if (
    !Number.isFinite(observedAtMilliseconds)
    || price === null
    || price <= 0
    || epochSeconds === null
    || epochSeconds <= 0
    || previousClose === null
    || previousClose <= 0
    || open === null
    || open <= 0
    || high === null
    || high <= 0
    || low === null
    || low <= 0
    || high < Math.max(open, low)
    || low > Math.min(open, high)
    || volume === null
    || volume < 0
    || !Number.isSafeInteger(updatedAtMilliseconds)
    || updatedAtMilliseconds <= 0
    || updatedAtMilliseconds > observedAtMilliseconds + MAX_FUTURE_CLOCK_SKEW_MS
  ) return null;

  const updatedAt = new Date(updatedAtMilliseconds).toISOString();
  const ingestedAt = observedNow.toISOString();
  const change = price - previousClose;
  return Object.freeze({
    instrumentId: expected.instrument.instrumentId,
    price,
    change,
    changePercent: (change / previousClose) * 100,
    previousClose,
    open,
    high,
    low,
    volume,
    currency: "USD",
    marketState: tradingViewMarketSessionState(values.current_session)
      ?? marketState(observedNow),
    delaySeconds: Math.max(
      0,
      Math.min(900, Math.trunc((observedAtMilliseconds - updatedAtMilliseconds) / 1_000)),
    ),
    provenance: Object.freeze({
      providerId: manifest.id,
      sourceId: `tradingview-websocket:${expected.sourceSymbol}:realtime-quote`,
      asOf: updatedAt,
      ingestedAt,
      sourceUrl: TRADINGVIEW_SOURCE_URL,
    }),
  });
}

/**
 * One bounded Worker-native long poll for direct-listing U.S. equity quotes.
 *
 * Sites keeps this ordinary HTTP request alive while the outbound TradingView
 * guest websocket is open, so no downstream WebSocket/SSE survives the Worker
 * response boundary. A cursor-less request returns the first complete batch
 * (or the five-second initial deadline). With cursors, an unchanged initial
 * snapshot waits for the first price/as-of change for at most twenty seconds.
 */
export async function loadTradingViewWorkerQuoteLongPoll(
  instruments: readonly Instrument[],
  cursors: ReadonlyMap<string, TradingViewWorkerQuoteCursor>,
  context: ProviderRequestContext,
  dependencies: TradingViewWorkerQuoteLongPollDependencies = {},
): Promise<TradingViewWorkerQuoteLongPollResult> {
  const requests = realtimeQuoteRequests(instruments);
  if (
    requests.length < 1
    || requests.length > MAX_REALTIME_SYMBOLS
    || requests.length !== instruments.length
  ) {
    throw new TradingViewSidecarError(
      "invalid_request",
      "Realtime quote instruments are invalid.",
    );
  }
  const expectedBySource = new Map(requests.map((request) => [request.sourceSymbol, request]));
  const expectedSymbols = new Set(requests.map((request) => request.symbol));
  for (const [symbol, cursor] of cursors) {
    if (
      !expectedSymbols.has(symbol)
      || !Number.isFinite(cursor.price)
      || cursor.price <= 0
      || typeof cursor.asOf !== "string"
      || !isoTimestamp(cursor.asOf)
    ) {
      throw new TradingViewSidecarError(
        "invalid_request",
        "Realtime quote cursors are invalid.",
      );
    }
  }

  const sessionId = (dependencies.sessionId ?? tradingViewWorkerSessionId)();
  if (!/^qs_[a-z]{12}$/.test(sessionId)) {
    throw new TradingViewSidecarError(
      "configuration",
      "TradingView worker quote-session identifier is invalid.",
    );
  }
  const waitMs = cursors.size === 0
    ? boundedWorkerDuration(
      dependencies.initialWaitMs,
      TRADINGVIEW_WORKER_QUOTE_INITIAL_WAIT_MS,
      TRADINGVIEW_WORKER_QUOTE_INITIAL_WAIT_MS,
    )
    : boundedWorkerDuration(
      dependencies.longPollWaitMs,
      TRADINGVIEW_WORKER_QUOTE_LONG_POLL_WAIT_MS,
      TRADINGVIEW_WORKER_QUOTE_LONG_POLL_WAIT_MS,
    );
  const handshakeWaitMs = Math.min(
    waitMs,
    boundedWorkerDuration(
      dependencies.handshakeWaitMs,
      TRADINGVIEW_WORKER_QUOTE_HANDSHAKE_WAIT_MS,
      TRADINGVIEW_WORKER_QUOTE_HANDSHAKE_WAIT_MS,
    ),
  );
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const connect = dependencies.connect ?? (
    (signal: AbortSignal) => connectTradingViewWorkerWebSocket(signal, fetchImplementation)
  );
  const now = dependencies.now ?? (() => new Date());
  const startedAt = Date.now();

  const handshakeController = new AbortController();
  let handshakeTimedOut = false;
  const abortHandshakeFromContext = () => handshakeController.abort(context.signal?.reason);
  if (context.signal?.aborted) abortHandshakeFromContext();
  else context.signal?.addEventListener("abort", abortHandshakeFromContext, { once: true });
  const handshakeTimer = setTimeout(() => {
    handshakeTimedOut = true;
    handshakeController.abort();
  }, handshakeWaitMs);

  let websocket: TradingViewWorkerWebSocket;
  try {
    websocket = await connect(handshakeController.signal);
    if (handshakeController.signal.aborted) {
      try {
        websocket.close(1000, "request ended");
      } catch {
        // The sanitized handshake failure below is authoritative.
      }
      throw handshakeController.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  } catch (error) {
    if (handshakeTimedOut) {
      throw new TradingViewSidecarError(
        "request_timeout",
        "TradingView websocket connection timed out.",
      );
    }
    if (error instanceof TradingViewSidecarError) throw error;
    throw new TradingViewSidecarError(
      "upstream_error",
      "TradingView websocket connection failed.",
    );
  } finally {
    clearTimeout(handshakeTimer);
    context.signal?.removeEventListener("abort", abortHandshakeFromContext);
  }

  return new Promise<TradingViewWorkerQuoteLongPollResult>((resolve, reject) => {
    const rawQuoteValues = new Map<string, JsonRecord>();
    const latestEpochBySource = new Map<string, number>();
    const quotesByInstrumentId = new Map<string, Quote>();
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder("utf-8", { fatal: true });
    let frameBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let settled = false;
    const timers: { response?: ReturnType<typeof setTimeout> } = {};

    const orderedQuotes = () => Object.freeze(requests.flatMap((request) => {
      const quote = quotesByInstrumentId.get(request.instrument.instrumentId);
      return quote ? [quote] : [];
    }));
    const cleanup = () => {
      if (timers.response) clearTimeout(timers.response);
      websocket.removeEventListener("message", onMessage);
      websocket.removeEventListener("close", onClose);
      websocket.removeEventListener("error", onError);
      context.signal?.removeEventListener("abort", onAbort);
      try {
        websocket.close(1000, "long poll ended");
      } catch {
        // A close/error callback may already have disposed the socket.
      }
    };
    const finish = (reason: TradingViewWorkerQuoteLongPollResult["reason"]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Object.freeze({ quotes: orderedQuotes(), reason }));
    };
    const fail = (error: TradingViewSidecarError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cursorChanged = (request: RealtimeQuoteRequest, quote: Quote) => {
      const cursor = cursors.get(request.symbol);
      return !cursor
        || cursor.price !== quote.price
        || isoTimestamp(cursor.asOf) !== quote.provenance.asOf;
    };
    const handleQuoteData = (quoteData: JsonRecord) => {
      const sourceSymbol = typeof quoteData.n === "string" ? quoteData.n : "";
      const expected = expectedBySource.get(sourceSymbol);
      if (!expected || quoteData.s !== "ok") return;
      const values = asRecord(quoteData.v);
      if (!values) return;
      const merged: JsonRecord = { ...(rawQuoteValues.get(sourceSymbol) ?? {}) };
      for (const field of TRADINGVIEW_WORKER_QUOTE_FIELDS) {
        if (field in values) merged[field] = values[field];
      }
      rawQuoteValues.set(sourceSymbol, merged);
      const quote = normalizeTradingViewWorkerRegularQuote(merged, expected, now());
      if (!quote) return;
      const epochSeconds = finiteNumber(merged.lp_time)!;
      const previousEpoch = latestEpochBySource.get(sourceSymbol);
      if (previousEpoch !== undefined && epochSeconds < previousEpoch) return;
      latestEpochBySource.set(sourceSymbol, epochSeconds);
      quotesByInstrumentId.set(expected.instrument.instrumentId, quote);

      if (cursors.size > 0 && cursorChanged(expected, quote)) {
        finish("changed");
        return;
      }
      if (cursors.size === 0 && quotesByInstrumentId.size === requests.length) {
        finish("initial");
      }
    };
    const handlePayload = (payload: string) => {
      if (payload.startsWith("~h~")) {
        websocket.send(tradingViewFrame(payload));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(payload);
      } catch {
        return;
      }
      const root = asRecord(message);
      if (!root || !Array.isArray(root.p)) return;
      if (root.m === "qsd") {
        if (root.p.length < 2 || root.p[0] !== sessionId) return;
        const quote = asRecord(root.p[1]);
        if (quote) handleQuoteData(quote);
        return;
      }
      if (
        (root.m === "critical_error" || root.m === "protocol_error")
        && root.p.length > 0
        && root.p[0] === sessionId
      ) {
        fail(new TradingViewSidecarError(
          "upstream_error",
          "TradingView quote session failed.",
        ));
      }
    };
    const consumeFrames = (chunk: string) => {
      frameBuffer = appendBytes(frameBuffer, textEncoder.encode(chunk));
      if (frameBuffer.byteLength > MAX_TRADINGVIEW_WORKER_BUFFER_BYTES) {
        throw new TradingViewSidecarError(
          "invalid_response",
          "TradingView websocket frame buffer exceeded the permitted size.",
        );
      }
      while (frameBuffer.byteLength > 0) {
        if (
          frameBuffer.byteLength < 3
          || frameBuffer[0] !== 126
          || frameBuffer[1] !== 109
          || frameBuffer[2] !== 126
        ) {
          throw new TradingViewSidecarError(
            "invalid_response",
            "TradingView websocket returned invalid framing.",
          );
        }
        let delimiter = -1;
        for (let index = 3; index + 2 < frameBuffer.byteLength; index += 1) {
          if (
            frameBuffer[index] === 126
            && frameBuffer[index + 1] === 109
            && frameBuffer[index + 2] === 126
          ) {
            delimiter = index;
            break;
          }
        }
        if (delimiter < 0) return;
        const lengthText = String.fromCharCode(...frameBuffer.slice(3, delimiter));
        if (!/^[1-9][0-9]{0,5}$/.test(lengthText)) {
          throw new TradingViewSidecarError(
            "invalid_response",
            "TradingView websocket returned an invalid frame length.",
          );
        }
        const payloadLength = Number(lengthText);
        if (payloadLength > MAX_TRADINGVIEW_WORKER_FRAME_BYTES) {
          throw new TradingViewSidecarError(
            "invalid_response",
            "TradingView websocket frame exceeded the permitted size.",
          );
        }
        const payloadStart = delimiter + 3;
        const payloadEnd = payloadStart + payloadLength;
        if (frameBuffer.byteLength < payloadEnd) return;
        const payload = textDecoder.decode(frameBuffer.slice(payloadStart, payloadEnd));
        frameBuffer = frameBuffer.slice(payloadEnd);
        handlePayload(payload);
        if (settled) return;
      }
    };
    const onMessage: EventListener = (event) => {
      if (settled) return;
      const data = workerSocketMessageData(event);
      if (typeof data !== "string") return;
      try {
        consumeFrames(data);
      } catch (error) {
        fail(error instanceof TradingViewSidecarError
          ? error
          : new TradingViewSidecarError(
            "invalid_response",
            "TradingView websocket returned invalid data.",
          ));
      }
    };
    const onClose: EventListener = () => fail(new TradingViewSidecarError(
      "upstream_error",
      "TradingView websocket closed unexpectedly.",
    ));
    const onError: EventListener = () => fail(new TradingViewSidecarError(
      "upstream_error",
      "TradingView websocket failed.",
    ));
    const onAbort = () => fail(new TradingViewSidecarError(
      "upstream_error",
      "Realtime quote request was canceled.",
    ));

    websocket.addEventListener("message", onMessage);
    websocket.addEventListener("close", onClose);
    websocket.addEventListener("error", onError);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) {
      onAbort();
      return;
    }

    try {
      websocket.send(tradingViewProtocolMessage(
        "set_auth_token",
        ["unauthorized_user_token"],
      ));
      websocket.send(tradingViewProtocolMessage("quote_create_session", [sessionId]));
      websocket.send(tradingViewProtocolMessage(
        "quote_set_fields",
        [sessionId, ...TRADINGVIEW_WORKER_QUOTE_FIELDS],
      ));
      for (const request of requests) {
        websocket.send(tradingViewProtocolMessage(
          "quote_add_symbols",
          [sessionId, request.sourceSymbol],
        ));
      }
    } catch {
      fail(new TradingViewSidecarError(
        "upstream_error",
        "TradingView websocket subscription failed.",
      ));
      return;
    }

    const elapsed = Date.now() - startedAt;
    timers.response = setTimeout(() => {
      finish(cursors.size === 0 ? "initial" : "timeout");
    }, Math.max(10, waitMs - elapsed));
  });
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
  trustProviderSession: boolean,
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
    marketState: trustProviderSession
      ? tradingViewMarketSessionState(item.session) ?? marketState(observedNow)
      : marketState(observedNow),
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
  const trustProviderSession = root.state === "connected";
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
    const quote = normalizeRealtimeQuote(
      item,
      expectedBySymbol,
      root.ingestedAt,
      observedNow,
      trustProviderSession,
    );
    if (quote) quotes.push(quote);
  }
  return Object.freeze(quotes);
}

export function createTradingViewSidecarProvider(
  env: ProviderEnvironment,
  dependencies: ProviderDependencies = {},
) {
  const baseUrl = sidecarBaseUrl(env);
  const token = env.TRADER_TRADINGVIEW_SIDECAR_TOKEN?.trim();
  if (!loopbackHostname(baseUrl.hostname) && !token) {
    throw new TradingViewSidecarError(
      "configuration",
      "A TradingView sidecar token is required for remote HTTPS endpoints.",
    );
  }
  const timeoutMs = positiveInteger(env.TRADER_TRADINGVIEW_SIDECAR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxCandles = configuredCandleLimit(env.TRADER_TRADINGVIEW_MAX_CANDLES);
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
      await response.body?.cancel().catch(() => undefined);
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
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      if (error instanceof TradingViewSidecarError) throw error;
      throw new TradingViewSidecarError(
        "upstream_error",
        "TradingView sidecar response stream failed.",
      );
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TradingViewSidecarError(
        "invalid_response",
        "TradingView sidecar returned invalid UTF-8.",
      );
    }
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
    let sourceConnected = false;

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
              if (root.state !== "connected") {
                throw new TradingViewSidecarError("upstream_error", "TradingView realtime source is reconnecting.");
              }
              sourceConnected = true;
              const quotes = normalizeRealtimeSnapshot(root, requests, now());
              for (const quote of quotes) controller.enqueue(quote);
            } else if (eventName === "quote") {
              if (root?.schemaVersion !== REALTIME_QUOTES_SCHEMA_VERSION || root.type !== "quote") {
                throw new TradingViewSidecarError("invalid_response", "TradingView sidecar returned an invalid quote event.");
              }
              if (!sourceConnected) {
                throw new TradingViewSidecarError("upstream_error", "TradingView realtime source is not connected.");
              }
              const quote = normalizeRealtimeQuote(
                root.item,
                expectedBySymbol,
                root.ingestedAt,
                now(),
                true,
              );
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
                sourceConnected = false;
                throw new TradingViewSidecarError("upstream_error", "TradingView realtime source disconnected.");
              }
              sourceConnected = true;
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

  async function requestLatestCloses(
    symbols: readonly string[],
    context: ProviderRequestContext,
  ): Promise<readonly SyntheticLatestClose[]> {
    const normalizedSymbols = normalizeSyntheticSymbols(symbols);

    const url = new URL("v1/latest-closes", baseUrl);
    const linked = linkedRequestController(context);
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
        cache: "no-store",
        signal: linked.controller.signal,
      });
    } catch {
      linked.cleanup();
      if (linked.timedOut()) {
        throw new TradingViewSidecarError("request_timeout", "TradingView sidecar request timed out.");
      }
      throw new TradingViewSidecarError("upstream_error", "TradingView sidecar request failed.");
    }
    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new TradingViewSidecarError(
          "upstream_error",
          "TradingView sidecar returned an unsuccessful response.",
          response.status,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        await response.body?.cancel().catch(() => undefined);
        throw new TradingViewSidecarError(
          "invalid_response",
          "TradingView sidecar returned an invalid content type.",
        );
      }
      const text = await boundedResponseText(response, MAX_LATEST_CLOSE_SNAPSHOT_BYTES);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new TradingViewSidecarError(
          "invalid_response",
          "TradingView sidecar returned invalid JSON.",
        );
      }
      return normalizeLatestCloses(payload, normalizedSymbols, syntheticExchanges);
    } catch (error) {
      if (linked.timedOut()) {
        throw new TradingViewSidecarError(
          "request_timeout",
          "TradingView sidecar request timed out.",
        );
      }
      throw error;
    } finally {
      linked.cleanup();
    }
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
      ): Promise<readonly SyntheticLatestClose[]> => requestLatestCloses(symbols, context),
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
