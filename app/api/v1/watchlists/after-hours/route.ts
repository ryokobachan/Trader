import {
  WATCHLIST_AFTER_HOURS_MAX_SYMBOLS,
  WATCHLIST_AFTER_HOURS_SCHEMA_VERSION,
  type WatchlistAfterHoursResponse,
} from "../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../platform/provider-environment.server";
import {
  requestOwnerErrorResponse,
  requestOwnerId,
} from "../../../../platform/request-owner.server";
import {
  createTradingViewSidecarProvider,
  TradingViewSidecarError,
  tradingViewSyntheticExchanges,
} from "../../../../plugins/providers/tradingview-websocket.server";

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
const MAX_BODY_BYTES = 8_192;

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return Response.json(
    { error: { code, message }, requestId },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    },
  );
}

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
  try {
    requestOwnerId(request);
  } catch (error) {
    return requestOwnerErrorResponse(error, requestId)
      ?? errorResponse(500, "internal_error", "認証情報を確認できませんでした。", requestId);
  }
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
  }
  if (!bodyText || new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
  }
  const rawSymbols = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).symbols
    : null;
  if (!Array.isArray(rawSymbols) || rawSymbols.length < 1 || rawSymbols.length > WATCHLIST_AFTER_HOURS_MAX_SYMBOLS) {
    return errorResponse(
      400,
      "invalid_request",
      `銘柄は1〜${WATCHLIST_AFTER_HOURS_MAX_SYMBOLS}件で指定してください。`,
      requestId,
    );
  }

  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const value of rawSymbols) {
    if (typeof value !== "string") {
      return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
    }
    const symbol = value.normalize("NFKC").trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol)) {
      return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
    }
    if (!seen.has(symbol)) {
      seen.add(symbol);
      symbols.push(symbol);
    }
  }

  try {
    const environment = providerEnvironment();
    const adapter = createTradingViewSidecarProvider(environment);
    const exchanges = tradingViewSyntheticExchanges(environment);
    const items = await adapter.syntheticMarket.getLatestCloses(symbols, { requestId });
    const response: WatchlistAfterHoursResponse = {
      schemaVersion: WATCHLIST_AFTER_HOURS_SCHEMA_VERSION,
      exchange: exchanges[0]!,
      exchanges,
      items,
      selectedProvider: adapter.manifest.id,
      asOf: new Date().toISOString(),
    };
    return Response.json(response, {
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    if (error instanceof TradingViewSidecarError) {
      if (error.code === "invalid_request") {
        return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
      }
      if (error.code === "configuration") {
        return errorResponse(503, "provider_unavailable", "時間外データProviderが設定されていません。", requestId);
      }
      if (error.code === "request_timeout") {
        return errorResponse(504, "upstream_timeout", "時間外データの取得がタイムアウトしました。", requestId);
      }
    }
    return errorResponse(502, "upstream_error", "時間外データの取得元に接続できませんでした。", requestId);
  }
}
