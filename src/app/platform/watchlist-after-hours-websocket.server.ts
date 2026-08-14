import {
  WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
  type ProviderEnvironment,
  type SyntheticLatestClose,
  type WatchlistAfterHoursStreamMessage,
} from "./provider-contracts";
import { providerEnvironment } from "./provider-environment.server";
import {
  requestOwnerErrorResponse,
  requestOwnerId,
} from "./request-owner.server";
import {
  isSameOriginWatchlistStreamRequest,
  requestedWatchlistAfterHoursSymbols,
  watchlistAfterHoursErrorResponse,
} from "./watchlist-after-hours-request.server";
import {
  createTradingViewWorkerLatestCloseStream,
  TradingViewSidecarError,
  tradingViewWorkerLatestCloseStreamSupported,
} from "@api/tradingview-websocket/index.server";

export const WATCHLIST_AFTER_HOURS_STREAM_PATH = "/api/v1/watchlists/after-hours/stream";
const MAX_BROWSER_WEBSOCKET_BUFFER_BYTES = 1_048_576;

export interface WatchlistAfterHoursRelayWebSocket extends EventTarget {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  accept(options?: Readonly<{ allowHalfOpen?: boolean }>): void;
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

type WatchlistAfterHoursStreamFactory = (
  environment: ProviderEnvironment,
  symbols: readonly string[],
  context: Readonly<{ requestId: string; signal?: AbortSignal }>,
) => Promise<ReadableStream<SyntheticLatestClose>>;

export type WatchlistAfterHoursWebSocketDependencies = Readonly<{
  environment?: ProviderEnvironment;
  createStream?: WatchlistAfterHoursStreamFactory;
  createPair?: () => Readonly<{
    client: WatchlistAfterHoursRelayWebSocket;
    server: WatchlistAfterHoursRelayWebSocket;
  }>;
  createUpgradeResponse?: (
    client: WatchlistAfterHoursRelayWebSocket,
    requestId: string,
  ) => Response;
}>;

function nativeWebSocketPair() {
  const pair = new WebSocketPair();
  return Object.freeze({ client: pair[0], server: pair[1] });
}

function nativeUpgradeResponse(
  client: WatchlistAfterHoursRelayWebSocket,
  requestId: string,
) {
  return new Response(null, {
    status: 101,
    headers: { "X-Request-Id": requestId },
    webSocket: client as WebSocket,
  });
}

function browserSocketBufferedAmount(socket: WatchlistAfterHoursRelayWebSocket) {
  try {
    const value = Reflect.get(socket, "bufferedAmount");
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function websocketOriginMatches(request: Request) {
  if (!isSameOriginWatchlistStreamRequest(request)) return false;
  return request.headers.get("origin") === new URL(request.url).origin;
}

/**
 * Upgrade the same authenticated stream URL before it reaches Vinext. Sites'
 * HTTP response layer can buffer SSE chunks, while a Worker WebSocketPair
 * preserves each already-normalized TradingView tick as a distinct message.
 */
export async function handleWatchlistAfterHoursWebSocketUpgrade(
  request: Request,
  dependencies: WatchlistAfterHoursWebSocketDependencies = {},
): Promise<Response> {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128)
    || crypto.randomUUID();
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return watchlistAfterHoursErrorResponse(
      426,
      "upgrade_required",
      "WebSocket接続が必要です。",
      requestId,
    );
  }
  if (!websocketOriginMatches(request)) {
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

  const symbols = requestedWatchlistAfterHoursSymbols(request);
  if (!symbols) {
    return watchlistAfterHoursErrorResponse(
      400,
      "invalid_request",
      "銘柄一覧を確認してください。",
      requestId,
    );
  }
  if (!dependencies.createStream && !tradingViewWorkerLatestCloseStreamSupported()) {
    return watchlistAfterHoursErrorResponse(
      503,
      "provider_unavailable",
      "時間外データProviderが設定されていません。",
      requestId,
    );
  }

  const relayController = new AbortController();
  let requestAbortAttached = false;
  const abortFromRequest = () => relayController.abort(request.signal.reason);
  if (request.signal.aborted) abortFromRequest();
  else {
    request.signal.addEventListener("abort", abortFromRequest, { once: true });
    requestAbortAttached = true;
  }
  const detachRequestAbort = () => {
    if (!requestAbortAttached) return;
    requestAbortAttached = false;
    request.signal.removeEventListener("abort", abortFromRequest);
  };

  let source: ReadableStream<SyntheticLatestClose>;
  try {
    const environment = dependencies.environment ?? providerEnvironment();
    source = await (dependencies.createStream ?? createTradingViewWorkerLatestCloseStream)(
      environment,
      symbols,
      { requestId, signal: relayController.signal },
    );
  } catch (error) {
    detachRequestAbort();
    if (error instanceof TradingViewSidecarError) {
      if (error.code === "request_timeout") {
        return watchlistAfterHoursErrorResponse(
          504,
          "upstream_timeout",
          "時間外データの接続がタイムアウトしました。",
          requestId,
        );
      }
      if (error.code === "configuration") {
        return watchlistAfterHoursErrorResponse(
          503,
          "provider_unavailable",
          "時間外データProviderが設定されていません。",
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
  }

  let reader: ReadableStreamDefaultReader<SyntheticLatestClose> | undefined;
  let pair: Readonly<{
    client: WatchlistAfterHoursRelayWebSocket;
    server: WatchlistAfterHoursRelayWebSocket;
  }>;
  try {
    reader = source.getReader();
    pair = (dependencies.createPair ?? nativeWebSocketPair)();
  } catch {
    detachRequestAbort();
    relayController.abort("websocket setup failed");
    if (reader) {
      await reader.cancel("websocket setup failed").catch(() => undefined);
      reader.releaseLock();
    } else {
      await source.cancel("websocket setup failed").catch(() => undefined);
    }
    return watchlistAfterHoursErrorResponse(
      500,
      "internal_error",
      "WebSocket接続を開始できませんでした。",
      requestId,
    );
  }
  const { client, server } = pair;
  let finished = false;
  let cleanupPromise: Promise<void> | undefined;

  const removeRelayListeners = () => {
    server.removeEventListener("close", onBrowserClose);
    server.removeEventListener("error", onBrowserError);
    detachRequestAbort();
  };
  const cleanup = (
    closeBrowser: boolean,
    code = 1000,
    reason = "stream ended",
  ) => {
    if (cleanupPromise) return cleanupPromise;
    finished = true;
    removeRelayListeners();
    relayController.abort(reason);
    cleanupPromise = reader.cancel(reason)
      .catch(() => undefined)
      .then(() => {
        reader.releaseLock();
        if (closeBrowser && server.readyState < 2) {
          try {
            server.close(code, reason);
          } catch {
            // The browser can close while upstream cancellation is pending.
          }
        }
      });
    return cleanupPromise;
  };
  function onBrowserClose() {
    void cleanup(false, 1000, "browser closed");
  }
  function onBrowserError() {
    void cleanup(true, 1011, "browser websocket failed");
  }

  try {
    server.accept();
    server.addEventListener("close", onBrowserClose);
    server.addEventListener("error", onBrowserError);
  } catch {
    await cleanup(true, 1011, "websocket setup failed");
    return watchlistAfterHoursErrorResponse(
      500,
      "internal_error",
      "WebSocket接続を開始できませんでした。",
      requestId,
    );
  }

  let upgradeResponse: Response;
  try {
    upgradeResponse = (dependencies.createUpgradeResponse ?? nativeUpgradeResponse)(
      client,
      requestId,
    );
    // Once the protocol switch has succeeded, the browser socket owns the
    // relay lifecycle. Some HTTP frontends signal the original request as
    // canceled while keeping the upgraded socket alive, so retaining this
    // listener can tear down an otherwise healthy Safari connection.
    detachRequestAbort();
  } catch (error) {
    await cleanup(true, 1011, "websocket upgrade failed");
    throw error;
  }

  void (async () => {
    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        const bufferedAmount = browserSocketBufferedAmount(server);
        if (
          bufferedAmount !== null
          && bufferedAmount > MAX_BROWSER_WEBSOCKET_BUFFER_BYTES
        ) {
          await cleanup(true, 1013, "browser is too slow");
          return;
        }
        const message: WatchlistAfterHoursStreamMessage = {
          schemaVersion: WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
          type: "quote",
          item: value,
        };
        server.send(JSON.stringify(message));
      }
      await cleanup(true);
    } catch {
      await cleanup(true, 1011, "after-hours stream failed");
    }
  })();
  return upgradeResponse;
}
