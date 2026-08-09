import {
  SYMBOL_WORKSPACE_SCHEMA_VERSION,
  type SymbolWorkspace,
} from "../../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";
import { ProviderRegistryError } from "../../../../../platform/provider-registry";
import { isUsableCurrentQuote } from "../../../../../platform/watchlist-quotes.server";
import { createProviderRuntime } from "../../../../../plugins/providers/index.server";

type RouteContext = { params: Promise<{ symbol: string }> };
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return Response.json({ error: { code, message }, requestId }, { status, headers: { "Cache-Control": "no-store" } });
}

async function optionalSection<T>(
  label: string,
  request: (() => Promise<T>) | undefined,
  fallback: T,
  warnings: string[],
): Promise<T> {
  if (!request) {
    warnings.push(`${label}: provider_not_configured`);
    return fallback;
  }
  try {
    return await request();
  } catch {
    warnings.push(`${label}: upstream_unavailable`);
    return fallback;
  }
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
    if (!instrument) return errorResponse(404, "symbol_not_found", "対象の米国株が見つかりません。", requestId);
    const quote = await runtime.market.getQuote(instrument, providerContext);
    if (!isUsableCurrentQuote(quote)) return errorResponse(404, "quote_not_available", "価格情報を取得できません。", requestId);

    const warnings: string[] = [];
    const [profile, fundamentals, earnings, analyst, news] = await Promise.all([
      optionalSection("profile", runtime.fundamentals ? () => runtime.fundamentals!.getProfile(instrument, providerContext) : undefined, null, warnings),
      optionalSection("fundamentals", runtime.fundamentals ? () => runtime.fundamentals!.getFundamentals(instrument, providerContext) : undefined, null, warnings),
      optionalSection("earnings", runtime.fundamentals ? () => runtime.fundamentals!.getEarnings(instrument, providerContext) : undefined, [], warnings),
      optionalSection("analyst", runtime.analyst ? () => runtime.analyst!.getConsensus(instrument, providerContext) : undefined, null, warnings),
      optionalSection("news", runtime.news ? () => runtime.news!.getCompanyNews(instrument, providerContext) : undefined, [], warnings),
    ]);

    const response: SymbolWorkspace = {
      schemaVersion: SYMBOL_WORKSPACE_SCHEMA_VERSION,
      instrument,
      quote,
      profile,
      fundamentals,
      earnings,
      analyst,
      news,
      selectedProviders: runtime.selectedProviderIds,
      dataMode: runtime.selectedProviderIds.market === "mock" ? "fixture" : "provider",
      status: warnings.length === 0 ? "complete" : "partial",
      warnings,
      asOf: quote.provenance.asOf,
    };
    return Response.json(response, {
      headers: { "Cache-Control": "private, max-age=20", "X-Request-Id": requestId },
    });
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      return errorResponse(500, "provider_configuration_error", "データProviderの設定を確認してください。", requestId);
    }
    return errorResponse(502, "upstream_error", "銘柄データの取得元に接続できませんでした。", requestId);
  }
}
