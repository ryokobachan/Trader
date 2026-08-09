import {
  INSTRUMENT_SEARCH_SCHEMA_VERSION,
  type InstrumentSearchResponse,
} from "../../../../platform/provider-contracts";
import { providerEnvironment } from "../../../../platform/provider-environment.server";
import { ProviderRegistryError } from "../../../../platform/provider-registry";
import { createProviderRuntime } from "../../../../plugins/providers/index.server";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 80;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

function errorResponse(status: number, code: string, message: string, requestId: string) {
  return Response.json(
    { error: { code, message }, requestId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function parseLimit(rawLimit: string | null): number | null {
  if (rawLimit === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(rawLimit)) return null;
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
  return limit;
}

export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").normalize("NFKC").trim();
  const limit = parseLimit(url.searchParams.get("limit"));

  if (query.length > MAX_QUERY_LENGTH || CONTROL_CHARACTER_PATTERN.test(query)) {
    return errorResponse(400, "invalid_query", "検索語は80文字以内で指定してください。", requestId);
  }
  if (limit === null) {
    return errorResponse(400, "invalid_limit", "limitは1〜50の整数で指定してください。", requestId);
  }

  try {
    const runtime = createProviderRuntime(providerEnvironment());
    const instruments = await runtime.instrument.searchUSStocks(
      { query, limit },
      { requestId },
    );
    const items = instruments
      .filter((instrument) => (
        instrument.active
        && instrument.listingCountry === "US"
        && (instrument.assetType === "common_stock" || instrument.assetType === "adr")
      ))
      .slice(0, limit);

    const response: InstrumentSearchResponse = {
      schemaVersion: INSTRUMENT_SEARCH_SCHEMA_VERSION,
      query,
      items,
      selectedProvider: runtime.selectedProviderIds.instrument,
      dataMode: runtime.selectedProviderIds.instrument === "mock" ? "fixture" : "provider",
      scope: {
        market: "US",
        activeOnly: true,
        assetTypes: ["common_stock", "adr"],
      },
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
    return errorResponse(500, "internal_error", "銘柄を検索できませんでした。", requestId);
  }
}
