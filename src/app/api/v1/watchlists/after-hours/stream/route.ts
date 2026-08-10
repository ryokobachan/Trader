import {
  WATCHLIST_AFTER_HOURS_MAX_SYMBOLS,
  WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
  type WatchlistAfterHoursStreamMessage,
} from "../../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";
import {
  requestOwnerErrorResponse,
  requestOwnerId,
} from "../../../../../platform/request-owner.server";
import {
  createTradingViewSidecarProvider,
  TradingViewSidecarError,
} from "@api/tradingview-websocket/index.server";

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
const HEARTBEAT_MS = 15_000;

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

function requestedSymbols(request: Request): readonly string[] | null {
  const values = new URL(request.url).searchParams.getAll("symbols");
  if (values.length !== 1 || !values[0]) return null;
  const symbols = values[0].split(",").map(
    (value) => value.normalize("NFKC").trim().toUpperCase(),
  );
  if (
    symbols.length < 1
    || symbols.length > WATCHLIST_AFTER_HOURS_MAX_SYMBOLS
    || symbols.some((symbol) => !SYMBOL_PATTERN.test(symbol))
    || new Set(symbols).size !== symbols.length
  ) return null;
  return Object.freeze(symbols);
}

function isSameOriginBrowserRequest(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return (!origin || origin === requestOrigin)
    && (!fetchSite || fetchSite === "same-origin");
}

export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
  if (!isSameOriginBrowserRequest(request)) {
    return errorResponse(403, "forbidden", "この接続元からは利用できません。", requestId);
  }
  try {
    requestOwnerId(request);
  } catch (error) {
    return requestOwnerErrorResponse(error, requestId)
      ?? errorResponse(500, "internal_error", "認証情報を確認できませんでした。", requestId);
  }

  const symbols = requestedSymbols(request);
  if (!symbols) {
    return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
  }

  try {
    const adapter = createTradingViewSidecarProvider(providerEnvironment());
    const source = await adapter.syntheticMarket.getLatestCloseStream(symbols, {
      requestId,
      signal: request.signal,
    });
    const reader = source.getReader();
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }, HEARTBEAT_MS);

        void (async () => {
          try {
            while (!closed) {
              const { done, value } = await reader.read();
              if (done) break;
              const message: WatchlistAfterHoursStreamMessage = {
                schemaVersion: WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
                type: "quote",
                item: value,
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
            }
            if (!closed) controller.close();
          } catch {
            if (!closed) controller.error(new Error("After-hours stream unavailable."));
          } finally {
            closed = true;
            if (heartbeat) clearInterval(heartbeat);
            reader.releaseLock();
          }
        })();
      },
      async cancel(reason) {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        await reader.cancel(reason).catch(() => undefined);
      },
    });

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
        return errorResponse(503, "provider_unavailable", "時間外データProviderが設定されていません。", requestId);
      }
      if (error.code === "request_timeout") {
        return errorResponse(504, "upstream_timeout", "時間外データの接続がタイムアウトしました。", requestId);
      }
    }
    return errorResponse(502, "upstream_error", "リアルタイム時間外データへ接続できませんでした。", requestId);
  }
}
