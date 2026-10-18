import { serverEventStream } from "../../../../../platform/server-events";
import {
  WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
  type WatchlistAfterHoursStreamMessage,
} from "../../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";
import {
  requestOwnerErrorResponse,
  requestOwnerId,
} from "../../../../../platform/request-owner.server";
import {
  isSameOriginWatchlistStreamRequest,
  requestedWatchlistAfterHoursSymbols,
  watchlistAfterHoursErrorResponse,
} from "../../../../../platform/watchlist-after-hours-request.server";
import {
  createTradingViewSidecarProvider,
  createTradingViewWorkerLatestCloseStream,
  TradingViewSidecarError,
  tradingViewWorkerLatestCloseStreamSupported,
} from "@api/tradingview-websocket/index.server";


export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
  if (!isSameOriginWatchlistStreamRequest(request)) {
    return watchlistAfterHoursErrorResponse(403, "forbidden", "この接続元からは利用できません。", requestId);
  }
  try {
    requestOwnerId(request);
  } catch (error) {
    return requestOwnerErrorResponse(error, requestId)
      ?? watchlistAfterHoursErrorResponse(500, "internal_error", "認証情報を確認できませんでした。", requestId);
  }

  const symbols = requestedWatchlistAfterHoursSymbols(request);
  if (!symbols) {
    return watchlistAfterHoursErrorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
  }

  try {
    const environment = providerEnvironment();
    const sidecarConfigured = Boolean(
      environment.TRADER_TRADINGVIEW_SIDECAR_URL?.trim(),
    );
    if (!sidecarConfigured && !tradingViewWorkerLatestCloseStreamSupported()) {
      throw new TradingViewSidecarError(
        "configuration",
        "Market data provider realtime websocket is unavailable in this runtime.",
      );
    }
    const context = { requestId, signal: request.signal };
    const source = sidecarConfigured
      ? await createTradingViewSidecarProvider(environment)
        .syntheticMarket.getLatestCloseStream(symbols, context)
      : await createTradingViewWorkerLatestCloseStream(
        environment,
        symbols,
        context,
      );
    const body = serverEventStream(source, (value): WatchlistAfterHoursStreamMessage => ({
      schemaVersion: WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
      type: "quote",
      item: value,
    }));

    return new Response(body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    if (error instanceof TradingViewSidecarError) {
      if (error.code === "configuration") {
        return watchlistAfterHoursErrorResponse(503, "provider_unavailable", "時間外データProviderが設定されていません。", requestId);
      }
      if (error.code === "request_timeout") {
        return watchlistAfterHoursErrorResponse(504, "upstream_timeout", "時間外データの接続がタイムアウトしました。", requestId);
      }
    }
    return watchlistAfterHoursErrorResponse(502, "upstream_error", "リアルタイム時間外データへ接続できませんでした。", requestId);
  }
}
