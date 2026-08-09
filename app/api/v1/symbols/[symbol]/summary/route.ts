import {
  SYMBOL_SUMMARY_SCHEMA_VERSION,
  type SymbolSummary,
} from "../../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";
import { ProviderRegistryError } from "../../../../../platform/provider-registry";
import { isUsableCurrentQuote } from "../../../../../platform/watchlist-quotes.server";
import { createProviderRuntime } from "../../../../../plugins/providers/index.server";

type RouteContext = {
  params: Promise<{ symbol: string }>;
};

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return Response.json(
    { error: { code, message }, requestId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
  const { symbol: rawSymbol } = await context.params;
  const symbol = rawSymbol.normalize("NFKC").trim().toUpperCase();

  if (!SYMBOL_PATTERN.test(symbol)) {
    return errorResponse(400, "invalid_symbol", "米国株の銘柄コードを指定してください。", requestId);
  }

  try {
    const runtime = createProviderRuntime(providerEnvironment());
    const providerContext = { requestId } as const;
    const instrument = await runtime.instrument.getUSStockBySymbol(symbol, providerContext);
    if (!instrument) {
      return errorResponse(404, "symbol_not_found", "対象の米国株が見つかりません。", requestId);
    }

    const quote = await runtime.market.getQuote(instrument, providerContext);
    if (!isUsableCurrentQuote(quote)) {
      return errorResponse(404, "quote_not_available", "この銘柄の価格情報を取得できません。", requestId);
    }

    const summary: SymbolSummary = {
      schemaVersion: SYMBOL_SUMMARY_SCHEMA_VERSION,
      instrument,
      quote,
      selectedProviders: runtime.selectedProviderIds,
      asOf: quote.provenance.asOf,
    };

    return Response.json(summary, {
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
    return errorResponse(500, "internal_error", "銘柄情報を取得できませんでした。", requestId);
  }
}
