import {
  WATCHLIST_QUOTES_MAX_SYMBOLS,
  WATCHLIST_QUOTES_SCHEMA_VERSION,
  type Instrument,
  type WatchlistQuotesResponse,
} from "../../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";
import { ProviderRegistryError } from "../../../../../platform/provider-registry";
import {
  loadWatchlistInstruments,
  watchlistQuoteDataMode,
} from "../../../../../platform/watchlist-quotes.server";
import {
  requestOwnerErrorResponse,
  requestOwnerId,
} from "../../../../../platform/request-owner.server";
import { createInstrumentProviderRuntime } from "@api/index.server";
import {
  loadTradingViewWorkerQuoteLongPoll,
  TradingViewSidecarError,
  tradingViewWebsocketProviderRegistration,
  type TradingViewWorkerQuoteCursor,
  type TradingViewWorkerQuoteLongPollResult,
} from "@api/tradingview-websocket/index.server";

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
const MAX_BODY_BYTES = 32_768;

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

function isSameOriginBrowserRequest(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return (!origin || origin === requestOrigin)
    && (!fetchSite || fetchSite === "same-origin");
}

function parseSymbols(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > WATCHLIST_QUOTES_MAX_SYMBOLS
  ) return null;
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") return null;
    const symbol = candidate.normalize("NFKC").trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol) || seen.has(symbol)) return null;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return Object.freeze(symbols);
}

function parseCursors(
  value: unknown,
  symbols: readonly string[],
): ReadonlyMap<string, TradingViewWorkerQuoteCursor> | null {
  if (value === undefined) return new Map();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const expectedSymbols = new Set(symbols);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > symbols.length) return null;
  const cursors = new Map<string, TradingViewWorkerQuoteCursor>();
  for (const [symbol, candidate] of entries) {
    if (
      !expectedSymbols.has(symbol)
      || candidate === null
      || typeof candidate !== "object"
      || Array.isArray(candidate)
    ) return null;
    const cursor = candidate as Record<string, unknown>;
    if (
      Object.keys(cursor).length !== 2
      || !("asOf" in cursor)
      || !("price" in cursor)
      || typeof cursor.asOf !== "string"
      || typeof cursor.price !== "number"
      || !Number.isFinite(cursor.price)
      || cursor.price <= 0
    ) return null;
    const parsedAsOf = Date.parse(cursor.asOf);
    if (!Number.isFinite(parsedAsOf)) return null;
    cursors.set(symbol, Object.freeze({
      asOf: new Date(parsedAsOf).toISOString(),
      price: cursor.price,
    }));
  }
  return cursors;
}

export async function POST(request: Request) {
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
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
  }
  const root = payload as Record<string, unknown>;
  if (
    Object.keys(root).some((key) => key !== "symbols" && key !== "cursors")
    || !("symbols" in root)
  ) {
    return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
  }
  const symbols = parseSymbols(root.symbols);
  const cursors = symbols ? parseCursors(root.cursors, symbols) : null;
  if (!symbols || !cursors) {
    return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
  }

  try {
    const environment = providerEnvironment();
    const identityRuntime = createInstrumentProviderRuntime(environment);
    const resolved = await loadWatchlistInstruments(
      symbols,
      {
        instrument: identityRuntime.instrument,
        selectedProviderIds: {
          instrument: identityRuntime.selectedProviderId,
          market: tradingViewWebsocketProviderRegistration.manifest.id,
          bars: tradingViewWebsocketProviderRegistration.manifest.id,
        },
      },
      { requestId, signal: request.signal },
    );
    const instruments = resolved.filter((value): value is Instrument => value !== null);
    const resolvedSymbols = new Set(instruments.map((instrument) => instrument.symbol));
    const resolvedCursors = new Map(
      [...cursors].filter(([symbol]) => resolvedSymbols.has(symbol)),
    );
    const result: TradingViewWorkerQuoteLongPollResult = instruments.length > 0
      ? await loadTradingViewWorkerQuoteLongPoll(
        instruments,
        resolvedCursors,
        { requestId, signal: request.signal },
      )
      : Object.freeze({ quotes: Object.freeze([]), reason: "initial" });
    const quoteByInstrumentId = new Map(
      result.quotes.map((quote) => [quote.instrumentId, quote]),
    );
    const items = Object.freeze(symbols.map((symbol, index) => {
      const instrument = resolved[index] ?? null;
      return Object.freeze({
        symbol,
        instrument,
        quote: instrument ? quoteByInstrumentId.get(instrument.instrumentId) ?? null : null,
      });
    }));
    const response: WatchlistQuotesResponse = {
      schemaVersion: WATCHLIST_QUOTES_SCHEMA_VERSION,
      items,
      selectedProviders: {
        instrument: identityRuntime.selectedProviderId,
        market: tradingViewWebsocketProviderRegistration.manifest.id,
      },
      dataMode: watchlistQuoteDataMode(
        identityRuntime.selectedProviderId,
        tradingViewWebsocketProviderRegistration.manifest.id,
      ),
      streamSupported: false,
      longPollSupported: true,
      asOf: new Date().toISOString(),
    };
    return Response.json(response, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Long-Poll-Result": result.reason,
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
    if (error instanceof TradingViewSidecarError) {
      if (error.code === "invalid_request") {
        return errorResponse(400, "invalid_request", "銘柄一覧を確認してください。", requestId);
      }
      if (error.code === "configuration") {
        return errorResponse(503, "provider_unavailable", "株価Providerが設定されていません。", requestId);
      }
      if (error.code === "request_timeout") {
        return errorResponse(504, "upstream_timeout", "株価の取得がタイムアウトしました。", requestId);
      }
    }
    return errorResponse(502, "upstream_error", "株価の取得元に接続できませんでした。", requestId);
  }
}
