import {
  MAX_MARKET_BAR_COUNT,
  MARKET_BARS_SCHEMA_VERSION,
  MIN_MARKET_BAR_COUNT,
  type MarketBarInterval,
  type MarketBarRange,
  type MarketBars,
  type MarketBarsResponse,
} from "../../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";
import { ProviderRegistryError } from "../../../../../platform/provider-registry";
import { createProviderRuntime } from "@api/index.server";

type RouteContext = { params: Promise<{ symbol: string }> };
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
const RANGES = new Set<MarketBarRange>(["1d", "5d", "1mo", "3mo", "6mo", "1y", "5y"]);
const INTERVALS = new Set<MarketBarInterval>([
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1wk",
  "1mo",
]);

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return Response.json({ error: { code, message }, requestId }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
  const { symbol: rawSymbol } = await context.params;
  const symbol = rawSymbol.normalize("NFKC").trim().toUpperCase();
  const url = new URL(request.url);
  const range = (url.searchParams.get("range") || "1y") as MarketBarRange;
  const interval = (url.searchParams.get("interval") || "1d") as MarketBarInterval;
  if (!SYMBOL_PATTERN.test(symbol) || !RANGES.has(range) || !INTERVALS.has(interval)) {
    return errorResponse(400, "invalid_request", "銘柄・期間・時間足の指定を確認してください。", requestId);
  }
  const rawCount = url.searchParams.get("count");
  let count: number | undefined;
  if (rawCount !== null) {
    const parsedCount = Number(rawCount);
    if (
      !Number.isSafeInteger(parsedCount)
      || parsedCount < MIN_MARKET_BAR_COUNT
      || parsedCount > MAX_MARKET_BAR_COUNT
    ) {
      return errorResponse(
        400,
        "invalid_count",
        `countは${MIN_MARKET_BAR_COUNT}〜${MAX_MARKET_BAR_COUNT.toLocaleString("en-US")}の整数で指定してください。`,
        requestId,
      );
    }
    count = parsedCount;
  }

  try {
    const runtime = createProviderRuntime(providerEnvironment());
    const providerContext = { requestId } as const;
    const instrument = await runtime.instrument.getUSStockBySymbol(symbol, providerContext);
    if (!instrument) return errorResponse(404, "symbol_not_found", "対象の米国株が見つかりません。", requestId);
    if (!runtime.market.getBars) return errorResponse(501, "bars_not_supported", "選択中のProviderは価格履歴に対応していません。", requestId);
    const providerBars = await runtime.market.getBars(
      instrument,
      { range, interval, ...(count === undefined ? {} : { count }) },
      providerContext,
    );
    if (!providerBars || providerBars.items.length === 0) return errorResponse(404, "bars_not_available", "価格履歴を取得できません。", requestId);

    // Enforce the canonical boundary even for adapters that cannot push a
    // requested count down to their upstream API. Keep the newest bars.
    const responseLimit = count ?? MAX_MARKET_BAR_COUNT;
    const items = providerBars.items.length > responseLimit
      ? Object.freeze(providerBars.items.slice(-responseLimit))
      : providerBars.items;
    const bars: MarketBars = Object.freeze({
      ...providerBars,
      items,
      returnedCount: items.length,
    });

    const response: MarketBarsResponse = {
      schemaVersion: MARKET_BARS_SCHEMA_VERSION,
      instrument,
      bars,
      requestedCount: count ?? providerBars.requestedCount ?? null,
      returnedCount: items.length,
      selectedProviders: { instrument: runtime.selectedProviderIds.instrument, market: runtime.selectedProviderIds.bars },
      dataMode: runtime.selectedProviderIds.bars === "mock" ? "fixture" : "provider",
      asOf: bars.provenance.asOf,
    };
    return Response.json(response, {
      headers: {
        "Cache-Control": ["1d", "1wk", "1mo"].includes(interval)
          ? "private, max-age=300"
          : "private, max-age=20",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      return errorResponse(500, "provider_configuration_error", "データProviderの設定を確認してください。", requestId);
    }
    return errorResponse(502, "upstream_error", "価格履歴の取得元に接続できませんでした。", requestId);
  }
}
