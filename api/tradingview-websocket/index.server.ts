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
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_TIMEOUT_MS = 65_000;
const TRADINGVIEW_SOURCE_URL = "wss://data.tradingview.com/socket.io/websocket";
const MAX_LATEST_CLOSE_SYMBOLS = 50;
const MAX_SYNTHETIC_EXCHANGES = 8;
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
  version: "1.1.0",
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

export function createTradingViewSidecarProvider(
  env: ProviderEnvironment,
  dependencies: ProviderDependencies = {},
) {
  const baseUrl = sidecarBaseUrl(env);
  const token = env.UNICORN_TRADINGVIEW_SIDECAR_TOKEN?.trim();
  const timeoutMs = positiveInteger(env.UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxCandles = configuredCandleLimit(env.UNICORN_TRADINGVIEW_MAX_CANDLES);
  const syntheticExchanges = tradingViewSyntheticExchanges(env);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? (() => new Date());

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
    const normalizedSymbols = symbols.map((symbol) => symbol.normalize("NFKC").trim().toUpperCase());
    if (
      normalizedSymbols.length < 1
      || normalizedSymbols.length > MAX_LATEST_CLOSE_SYMBOLS
      || normalizedSymbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))
      || new Set(normalizedSymbols).size !== normalizedSymbols.length
    ) {
      throw new TradingViewSidecarError("invalid_request", "Latest-close symbols are invalid.");
    }

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
    }),
    market: Object.freeze({
      getQuote: async (instrument: Instrument): Promise<Quote | null> => {
        const normalized = await requestBars(instrument, { range: "5d", interval: "1d" }, 3);
        if (!normalized) return null;
        const latest = normalized.items.at(-1)!;
        const previous = normalized.items.at(-2);
        const previousClose = previous?.close ?? latest.open;
        if (latest.close <= 0 || previousClose <= 0 || latest.open <= 0 || latest.high <= 0 || latest.low <= 0) {
          return null;
        }
        const change = latest.close - previousClose;
        return Object.freeze({
          instrumentId: instrument.instrumentId,
          price: latest.close,
          change,
          changePercent: previousClose === 0 ? 0 : (change / previousClose) * 100,
          previousClose,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          volume: latest.volume,
          currency: "USD",
          marketState: marketState(now()),
          // Guest websocket entitlements are not guaranteed to be consolidated
          // exchange real-time data. Surface a conservative delay instead of
          // making a real-time claim the adapter cannot prove.
          delaySeconds: 900,
          provenance: Object.freeze({
            providerId: manifest.id,
            sourceId: `tradingview-websocket:${instrument.symbol}:quote`,
            asOf: normalized.asOf,
            ingestedAt: normalized.ingestedAt,
            sourceUrl: TRADINGVIEW_SOURCE_URL,
          }),
        });
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
