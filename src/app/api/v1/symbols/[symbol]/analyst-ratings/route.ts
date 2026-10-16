import {
  ANALYST_RATING_HISTORY_SCHEMA_VERSION,
  type AnalystRatingHistoryResponse,
} from "../../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../../platform/provider-environment.server";
import { ProviderRegistryError } from "../../../../../platform/provider-registry";
import { providerDataMode } from "../../../../../platform/watchlist-quotes.server";
import { createProviderRuntime } from "@api/index.server";

type RouteContext = { params: Promise<{ symbol: string }> };

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_LOOKBACK_DAYS = 900;
const MAX_LOOKBACK_DAYS = 3_650;
const NEW_YORK_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function newYorkCalendarDate(date: Date) {
  const parts: Record<string, string> = {};
  for (const part of NEW_YORK_DATE_FORMATTER.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return Response.json(
    { error: { code, message }, requestId },
    { status, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
  );
}

function parseDate(value: string | null): Date | null {
  if (!value || !DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? parsed
    : null;
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function queryValue(url: URL, canonical: string, midas: string): string | null {
  return url.searchParams.get(canonical) ?? url.searchParams.get(midas);
}

function parsePageSize(value: string | null): number | null {
  if (value === null) return DEFAULT_PAGE_SIZE;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_SIZE
    ? parsed
    : null;
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
  const { symbol: rawSymbol } = await context.params;
  const symbol = rawSymbol.normalize("NFKC").trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) {
    return errorResponse(400, "invalid_symbol", "米国株の銘柄コードを指定してください。", requestId);
  }

  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh");
  if (fresh !== null && fresh !== "1") {
    return errorResponse(400, "invalid_fresh", "fresh must be 1 when provided.", requestId);
  }
  const today = new Date();
  const defaultDateTo = newYorkCalendarDate(today);
  const defaultStart = new Date(`${defaultDateTo}T00:00:00.000Z`);
  defaultStart.setUTCDate(defaultStart.getUTCDate() - DEFAULT_LOOKBACK_DAYS);
  const dateFrom = queryValue(url, "date_from", "parameters[date_from]")
    || dateString(defaultStart);
  const dateTo = queryValue(url, "date_to", "parameters[date_to]")
    || defaultDateTo;
  const from = parseDate(dateFrom);
  const to = parseDate(dateTo);
  const pageSize = parsePageSize(
    url.searchParams.get("pagesize") ?? url.searchParams.get("pageSize"),
  );
  const requestedTicker = url.searchParams.get("parameters[tickers]")
    ?.normalize("NFKC").trim().toUpperCase();

  if (!from || !to || from > to
    || to.getTime() - from.getTime() > MAX_LOOKBACK_DAYS * 86_400_000) {
    return errorResponse(
      400,
      "invalid_date_range",
      "date_fromとdate_toは最大10年のYYYY-MM-DD形式で指定してください。",
      requestId,
    );
  }
  if (pageSize === null) {
    return errorResponse(400, "invalid_pagesize", "pagesizeは1〜1000の整数で指定してください。", requestId);
  }
  if (requestedTicker && requestedTicker !== symbol) {
    return errorResponse(400, "ticker_mismatch", "URLの銘柄コードとtickersを一致させてください。", requestId);
  }

  try {
    const runtime = createProviderRuntime(providerEnvironment());
    const providerContext = {
      requestId,
      signal: request.signal,
      ...(fresh === "1" ? { fresh: true } : {}),
    } as const;
    const instrument = await runtime.instrument.getUSStockBySymbol(symbol, providerContext);
    if (!instrument) {
      return errorResponse(404, "symbol_not_found", "対象の米国株が見つかりません。", requestId);
    }
    const analystProviderId = runtime.selectedProviderIds.analyst;
    if (!runtime.analyst?.getRatingHistory || !analystProviderId) {
      return errorResponse(
        501,
        "analyst_history_not_supported",
        "選択中のProviderはアナリスト評価履歴に対応していません。",
        requestId,
      );
    }
    const history = await runtime.analyst.getRatingHistory(
      instrument,
      { dateFrom, dateTo, pageSize },
      providerContext,
    );
    const response: AnalystRatingHistoryResponse = {
      schemaVersion: ANALYST_RATING_HISTORY_SCHEMA_VERSION,
      instrument,
      history,
      selectedProviders: {
        instrument: runtime.selectedProviderIds.instrument,
        analyst: analystProviderId,
      },
      dataMode: providerDataMode(
        runtime.selectedProviderIds.instrument,
        analystProviderId,
      ),
      asOf: history.provenance.asOf,
    };
    return Response.json(response, {
      headers: {
        "Cache-Control": fresh === "1" ? "private, no-store" : "private, max-age=300",
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
    return errorResponse(
      502,
      "upstream_error",
      "アナリスト評価履歴の取得元に接続できませんでした。",
      requestId,
    );
  }
}
