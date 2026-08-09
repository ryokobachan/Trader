import {
  WATCHLIST_QUOTES_MAX_SYMBOLS,
  WATCHLIST_QUOTES_SCHEMA_VERSION,
  type WatchlistQuotesResponse,
} from "../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../platform/provider-environment.server";
import { ProviderRegistryError } from "../../../../platform/provider-registry";
import { loadWatchlistQuotes } from "../../../../platform/watchlist-quotes.server";
import {
  requestOwnerErrorResponse,
  requestOwnerId,
} from "../../../../platform/request-owner.server";
import { createProviderRuntime } from "@api/index.server";

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
  if (!Array.isArray(rawSymbols) || rawSymbols.length < 1 || rawSymbols.length > WATCHLIST_QUOTES_MAX_SYMBOLS) {
    return errorResponse(
      400,
      "invalid_request",
      `銘柄は1〜${WATCHLIST_QUOTES_MAX_SYMBOLS}件で指定してください。`,
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
    const runtime = createProviderRuntime(providerEnvironment());
    const items = await loadWatchlistQuotes(symbols, runtime, { requestId });
    const response: WatchlistQuotesResponse = {
      schemaVersion: WATCHLIST_QUOTES_SCHEMA_VERSION,
      items,
      selectedProviders: {
        instrument: runtime.selectedProviderIds.instrument,
        market: runtime.selectedProviderIds.market,
      },
      asOf: new Date().toISOString(),
    };
    return Response.json(response, {
      headers: {
        "Cache-Control": "private, no-store",
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
    return errorResponse(502, "upstream_error", "現在値の取得元に接続できませんでした。", requestId);
  }
}
