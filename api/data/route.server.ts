import { SHARED_DATASET_IDS } from "../../src/tooling/data-catalog";
import { dataOpenApi, describeData, discoverData } from "./discovery";
import { DataRequestError, dataDefinition, prepareDataRequest } from "./request";

export type PreparedDataRequest = ReturnType<typeof prepareDataRequest>;
type DataDispatcher = (request: Request, prepared: PreparedDataRequest) => Promise<Response>;
function requestId(request: Request) {
  const value = request.headers.get("x-request-id");
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : crypto.randomUUID();
}
function errorResponse(error: unknown, id: string): Response {
  const invalid = error instanceof DataRequestError;
  return Response.json({ error: { code: invalid ? error.code : "data_unavailable", message: invalid ? error.message : "The requested data could not be read." }, requestId: id }, {
    status: invalid ? error.code === "unknown_dataset" ? 404 : 400 : 502,
    headers: { "Cache-Control": "private, no-store", "X-Request-Id": id },
  });
}

/** Invoke existing read handlers in process; preserve incoming origin and owner/auth context. */
export const dispatchDataRequest: DataDispatcher = async (request, prepared) => {
  const id = prepared.definition.id;
  const symbol = { params: Promise.resolve({ symbol: prepared.parameters.get("symbol")! }) };
  const strategy = { params: Promise.resolve({ strategyId: prepared.parameters.get("strategy")! }) };
  if (SHARED_DATASET_IDS.includes(id)) return (await import("../shared-data/route.server")).getSharedDatasetResponse(request, id);
  if (id === "midas-data-sources") return Response.json(discoverData());
  if (id === "quote") return (await import("../../src/app/api/v1/symbols/[symbol]/summary/route")).GET(request, symbol);
  if (id === "bars") return (await import("../../src/app/api/v1/symbols/[symbol]/bars/route")).GET(request, symbol);
  if (["workspace", "financials", "profile", "fundamentals", "earnings", "analyst", "news", "research", "corporate-actions"].includes(id)) return (await import("../../src/app/api/v1/symbols/[symbol]/workspace/route")).GET(request, symbol);
  if (id === "options-chain") return (await import("../../src/app/api/v1/symbols/[symbol]/options/route")).GET(request, symbol);
  if (id === "options-history") return (await import("../../src/app/api/v1/symbols/[symbol]/options/prices/route")).GET(request, symbol);
  if (id === "analyst-ratings") return (await import("../../src/app/api/v1/symbols/[symbol]/analyst-ratings/route")).GET(request, symbol);
  if (id === "technical-indicators") return (await import("../../src/app/api/v1/indicators/route")).GET(request);
  if (id === "technicals") return (await import("../../src/app/api/v1/symbols/[symbol]/technicals/route")).GET(request, symbol);
  if (id === "source-status") return (await import("../../src/app/api/v1/research/sources/route")).GET();
  if (id === "strategy-list") return (await import("../../src/app/api/v1/strategies/route")).GET(request);
  if (id === "strategy" || id === "strategy-performance") return (await import("../../src/app/api/v1/strategies/[strategyId]/route")).GET(request, strategy);
  if (id === "strategy-transactions") return (await import("../../src/app/api/v1/strategy-portfolios/[strategyId]/transactions/route")).GET(request, strategy);
  if (id === "strategy-equity" || id === "strategy-holdings") return (await import("./strategy-results.server")).strategyResultResponse(request, id, prepared.parameters.get("strategy")!);
  return (await import("../../src/app/api/v1/research/sources/[sourceId]/route")).GET(request, { params: Promise.resolve({ sourceId: id }) });
};

export async function getDataResponse(request: Request, id: string, dispatch: DataDispatcher = dispatchDataRequest): Promise<Response> {
  const traceId = requestId(request);
  try {
    const prepared = prepareDataRequest(dataDefinition(id), new URL(request.url).searchParams);
    const nativeUrl = new URL(prepared.nativePath, request.url);
    const headers = new Headers(request.headers);
    headers.set("x-request-id", traceId);
    const response = await dispatch(new Request(nativeUrl, { method: "GET", headers, signal: request.signal }), prepared);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("X-Trader-Dataset", id);
    responseHeaders.set("X-Trader-Catalog-Version", "trader.data-catalog.v1");
    responseHeaders.set("Link", `</api/v1/data/${id}/describe>; rel="describedby"`);
    responseHeaders.set("X-Request-Id", traceId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch (error) { return errorResponse(error, traceId); }
}

export function dataDiscoveryResponse(request: Request, mode: "catalog" | "describe" | "openapi", id?: string): Response {
  const traceId = requestId(request);
  try {
    const query = new URL(request.url).searchParams;
    if (mode !== "catalog" && query.size) throw new DataRequestError("invalid_arguments", "This discovery endpoint takes no query parameters.");
    const payload = mode === "catalog" ? discoverData(query) : mode === "describe" ? describeData(id ?? "") : dataOpenApi();
    return Response.json(payload, { headers: { "Cache-Control": "no-store", "X-Request-Id": traceId } });
  } catch (error) { return errorResponse(error, traceId); }
}
