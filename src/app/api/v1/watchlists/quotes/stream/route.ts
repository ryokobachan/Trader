import { serverEventStream } from "../../../../../platform/server-events";
import { createProviderRuntime } from "@api/index.server";
import {
  WATCHLIST_QUOTES_MAX_SYMBOLS,
  WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION,
  type Instrument,
  type WatchlistQuoteStreamMessage,
} from "../../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";
import { ProviderRegistryError } from "../../../../../platform/provider-registry";
import {
  isUsableCurrentQuote,
  loadWatchlistInstruments,
  watchlistQuoteDataMode,
} from "../../../../../platform/watchlist-quotes.server";
import {
  requestOwnerErrorResponse,
  requestOwnerId,
} from "../../../../../platform/request-owner.server";

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

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
  const symbols = values[0].split(",").map((value) => value.normalize("NFKC").trim().toUpperCase());
  if (
    symbols.length < 1
    || symbols.length > WATCHLIST_QUOTES_MAX_SYMBOLS
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
    const runtime = createProviderRuntime(providerEnvironment());
    if (
      watchlistQuoteDataMode(
        runtime.selectedProviderIds.instrument,
        runtime.selectedProviderIds.market,
      ) !== "provider"
      || !runtime.market.getQuoteStream
    ) {
      return errorResponse(
        409,
        "stream_not_configured",
        "リアルタイム価格Providerが設定されていません。",
        requestId,
      );
    }

    const resolved = await loadWatchlistInstruments(symbols, runtime, { requestId });
    const instruments = resolved.filter((value): value is Instrument => value !== null);
    if (instruments.length === 0) {
      return errorResponse(404, "instruments_not_found", "対象銘柄を確認できませんでした。", requestId);
    }
    const symbolByInstrumentId = new Map(
      instruments.map((instrument) => [instrument.instrumentId, instrument.symbol]),
    );
    const source = await runtime.market.getQuoteStream(instruments, {
      requestId,
      signal: request.signal,
    });
    const body = serverEventStream(source, (value): WatchlistQuoteStreamMessage | null => {
      const symbol = symbolByInstrumentId.get(value.instrumentId);
      if (!symbol || !isUsableCurrentQuote(value)) return null;
      return { schemaVersion: WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION, type: "quote", symbol, quote: value };
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
    if (error instanceof ProviderRegistryError) {
      return errorResponse(
        500,
        "provider_configuration_error",
        "データProviderの設定を確認してください。",
        requestId,
      );
    }
    return errorResponse(502, "upstream_error", "リアルタイム価格へ接続できませんでした。", requestId);
  }
}
