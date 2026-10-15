import {
  SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS,
  WATCHLIST_AFTER_HOURS_MAX_SYMBOLS,
  WATCHLIST_AFTER_HOURS_POLL_SCHEMA_VERSION,
  type ProviderEnvironment,
  type SyntheticLatestClose,
  type WatchlistAfterHoursPollCursor,
  type WatchlistAfterHoursPollResponse,
} from "./provider-contracts";
import { providerEnvironment } from "./provider-environment.server";
import {
  requestOwnerErrorResponse,
  requestOwnerId,
} from "./request-owner.server";
import {
  isSameOriginWatchlistStreamRequest,
  watchlistAfterHoursErrorResponse,
} from "./watchlist-after-hours-request.server";
import {
  createTradingViewSidecarProvider,
  createTradingViewWorkerLatestCloseStream,
  TradingViewSidecarError,
  tradingViewSyntheticExchanges,
  tradingViewWorkerLatestCloseStreamSupported,
} from "@api/tradingview-websocket/index.server";

const MAX_BODY_BYTES = 16_384;
const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const MAX_WAIT_TIMEOUT_MS = 25_000;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

type WatchlistAfterHoursStreamFactory = (
  environment: ProviderEnvironment,
  symbols: readonly string[],
  context: Readonly<{ requestId: string; signal?: AbortSignal }>,
) => Promise<ReadableStream<SyntheticLatestClose>>;

export type WatchlistAfterHoursLongPollDependencies = Readonly<{
  environment?: ProviderEnvironment;
  createStream?: WatchlistAfterHoursStreamFactory;
  now?: () => Date;
  waitTimeoutMs?: number;
}>;

type ParsedPollRequest = Readonly<{
  symbols: readonly string[];
  cursors: ReadonlyMap<string, WatchlistAfterHoursPollCursor>;
}>;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function boundedWaitTimeout(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.max(10, Math.min(MAX_WAIT_TIMEOUT_MS, Math.trunc(value)));
}

async function parsePollRequest(request: Request): Promise<ParsedPollRequest | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return null;
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return null;
  }
  if (!bodyText || new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const root = asRecord(payload);
  if (!root || !hasExactKeys(root, ["symbols", "cursors"])) return null;
  if (
    !Array.isArray(root.symbols)
    || root.symbols.length < 1
    || root.symbols.length > WATCHLIST_AFTER_HOURS_MAX_SYMBOLS
    || !Array.isArray(root.cursors)
    || root.cursors.length > root.symbols.length
  ) return null;

  const symbols: string[] = [];
  const symbolSet = new Set<string>();
  for (const value of root.symbols) {
    if (typeof value !== "string") return null;
    const symbol = value.normalize("NFKC").trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol) || symbolSet.has(symbol)) return null;
    symbolSet.add(symbol);
    symbols.push(symbol);
  }

  const cursors = new Map<string, WatchlistAfterHoursPollCursor>();
  for (const value of root.cursors) {
    const cursor = asRecord(value);
    if (!cursor || !hasExactKeys(cursor, ["symbol", "sourceSymbol", "close", "updatedAt"])) {
      return null;
    }
    if (
      typeof cursor.symbol !== "string"
      || typeof cursor.sourceSymbol !== "string"
      || typeof cursor.close !== "number"
      || !Number.isFinite(cursor.close)
      || cursor.close <= 0
    ) return null;
    const symbol = cursor.symbol.normalize("NFKC").trim().toUpperCase();
    const updatedAt = canonicalTimestamp(cursor.updatedAt);
    if (
      !symbolSet.has(symbol)
      || cursors.has(symbol)
      || !updatedAt
    ) return null;
    cursors.set(symbol, Object.freeze({
      symbol,
      sourceSymbol: cursor.sourceSymbol,
      close: cursor.close,
      updatedAt,
    }));
  }
  return Object.freeze({ symbols: Object.freeze(symbols), cursors });
}

function sourceExchange(sourceSymbol: string, symbol: string): string | null {
  const suffix = `:${symbol}USDT.P`;
  return sourceSymbol.endsWith(suffix)
    ? sourceSymbol.slice(0, -suffix.length)
    : null;
}

function validCursorSources(
  cursors: ReadonlyMap<string, WatchlistAfterHoursPollCursor>,
  exchanges: readonly string[],
) {
  for (const cursor of cursors.values()) {
    const exchange = sourceExchange(cursor.sourceSymbol, cursor.symbol);
    if (!exchange || !exchanges.includes(exchange)) return false;
  }
  return true;
}

/**
 * Compare one canonical Worker tick with the browser's last accepted value.
 *
 * A newly opened TradingView session can report a lower-priority venue before
 * its preferred venue. Retaining a still-fresh preferred cursor prevents every
 * long poll from oscillating between exchanges during that warm-up sequence.
 */
export function isChangedAfterHoursPollItem(
  item: SyntheticLatestClose,
  cursor: WatchlistAfterHoursPollCursor | undefined,
  exchanges: readonly string[],
): boolean {
  if (item.close === null || item.updatedAt === null) return false;
  const itemUpdatedAt = Date.parse(item.updatedAt);
  if (!Number.isFinite(itemUpdatedAt)) return false;
  if (!cursor) return true;
  const cursorUpdatedAt = Date.parse(cursor.updatedAt);
  if (!Number.isFinite(cursorUpdatedAt) || itemUpdatedAt < cursorUpdatedAt) return false;

  const itemExchange = sourceExchange(item.sourceSymbol, item.symbol);
  const cursorExchange = sourceExchange(cursor.sourceSymbol, cursor.symbol);
  const itemPriority = itemExchange ? exchanges.indexOf(itemExchange) : -1;
  const cursorPriority = cursorExchange ? exchanges.indexOf(cursorExchange) : -1;
  if (itemPriority < 0 || cursorPriority < 0) return false;
  if (
    itemPriority > cursorPriority
    && itemUpdatedAt - cursorUpdatedAt < SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS
  ) return false;

  return item.sourceSymbol !== cursor.sourceSymbol
    || item.close !== cursor.close
    || item.updatedAt !== cursor.updatedAt;
}

function pollResponse(
  items: readonly SyntheticLatestClose[],
  timedOut: boolean,
  requestId: string,
  now: () => Date,
) {
  const payload: WatchlistAfterHoursPollResponse = {
    schemaVersion: WATCHLIST_AFTER_HOURS_POLL_SCHEMA_VERSION,
    items,
    timedOut,
    asOf: now().toISOString(),
  };
  return Response.json(payload, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}

/**
 * Hold one ordinary HTTP request until the Worker-side TradingView websocket
 * yields a changed canonical price. Unlike SSE/WebSocket browser relays, the
 * Sites frontend only has to deliver one completed JSON response.
 */
export async function handleWatchlistAfterHoursLongPoll(
  request: Request,
  dependencies: WatchlistAfterHoursLongPollDependencies = {},
): Promise<Response> {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128)
    || crypto.randomUUID();
  if (!isSameOriginWatchlistStreamRequest(request)) {
    return watchlistAfterHoursErrorResponse(
      403,
      "forbidden",
      "この接続元からは利用できません。",
      requestId,
    );
  }
  try {
    requestOwnerId(request);
  } catch (error) {
    return requestOwnerErrorResponse(error, requestId)
      ?? watchlistAfterHoursErrorResponse(
        500,
        "internal_error",
        "認証情報を確認できませんでした。",
        requestId,
      );
  }

  const parsed = await parsePollRequest(request);
  if (!parsed) {
    return watchlistAfterHoursErrorResponse(
      400,
      "invalid_request",
      "銘柄一覧または更新カーソルを確認してください。",
      requestId,
    );
  }

  const now = dependencies.now ?? (() => new Date());
  const environment = dependencies.environment ?? providerEnvironment();
  let exchanges: readonly string[];
  try {
    exchanges = tradingViewSyntheticExchanges(environment);
  } catch {
    return watchlistAfterHoursErrorResponse(
      503,
      "provider_unavailable",
      "時間外データProviderが設定されていません。",
      requestId,
    );
  }
  if (!validCursorSources(parsed.cursors, exchanges)) {
    return watchlistAfterHoursErrorResponse(
      400,
      "invalid_request",
      "更新カーソルの取得元を確認してください。",
      requestId,
    );
  }

  const sidecarConfigured = Boolean(
    environment.TRADER_TRADINGVIEW_SIDECAR_URL?.trim(),
  );
  if (
    !dependencies.createStream
    && !sidecarConfigured
    && !tradingViewWorkerLatestCloseStreamSupported()
  ) {
    return watchlistAfterHoursErrorResponse(
      503,
      "provider_unavailable",
      "時間外データProviderが設定されていません。",
      requestId,
    );
  }

  const pollController = new AbortController();
  const abortFromRequest = () => pollController.abort(request.signal.reason);
  if (request.signal.aborted) abortFromRequest();
  else request.signal.addEventListener("abort", abortFromRequest, { once: true });
  let didTimeOut = false;
  let wakeTimeout: (() => void) | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    wakeTimeout = () => resolve("timeout");
  });
  const timeout = setTimeout(() => {
    didTimeOut = true;
    pollController.abort("long poll timed out");
    wakeTimeout?.();
  }, boundedWaitTimeout(dependencies.waitTimeoutMs));
  let reader: ReadableStreamDefaultReader<SyntheticLatestClose> | undefined;

  try {
    const context = { requestId, signal: pollController.signal };
    const source = dependencies.createStream
      ? await dependencies.createStream(environment, parsed.symbols, context)
      : sidecarConfigured
        ? await createTradingViewSidecarProvider(environment)
          .syntheticMarket.getLatestCloseStream(parsed.symbols, context)
        : await createTradingViewWorkerLatestCloseStream(
          environment,
          parsed.symbols,
          context,
        );
    reader = source.getReader();
    while (!pollController.signal.aborted) {
      const result = await Promise.race([reader.read(), timeoutPromise]);
      if (result === "timeout") {
        return pollResponse([], true, requestId, now);
      }
      if (result.done) {
        throw new TradingViewSidecarError(
          "upstream_error",
          "TradingView realtime stream ended before a changed value arrived.",
        );
      }
      const item = result.value;
      if (
        parsed.symbols.includes(item.symbol)
        && isChangedAfterHoursPollItem(
          item,
          parsed.cursors.get(item.symbol),
          exchanges,
        )
      ) {
        return pollResponse([item], false, requestId, now);
      }
    }
    if (didTimeOut) return pollResponse([], true, requestId, now);
    throw new DOMException("Request aborted", "AbortError");
  } catch (error) {
    if (didTimeOut) return pollResponse([], true, requestId, now);
    if (error instanceof TradingViewSidecarError) {
      if (error.code === "configuration") {
        return watchlistAfterHoursErrorResponse(
          503,
          "provider_unavailable",
          "時間外データProviderが設定されていません。",
          requestId,
        );
      }
      if (error.code === "request_timeout") {
        return watchlistAfterHoursErrorResponse(
          504,
          "upstream_timeout",
          "時間外データの接続がタイムアウトしました。",
          requestId,
        );
      }
    }
    return watchlistAfterHoursErrorResponse(
      502,
      "upstream_error",
      "リアルタイム時間外データへ接続できませんでした。",
      requestId,
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromRequest);
    pollController.abort("long poll completed");
    if (reader) {
      await reader.cancel("long poll completed").catch(() => undefined);
      reader.releaseLock();
    }
  }
}
