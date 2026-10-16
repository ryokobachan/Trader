import type { DirectSourceDataset, DirectSourceId, DirectSourceQuery } from "../../src/app/platform/direct-source-contracts";
import { DIRECT_SOURCES } from "./catalog";
import { DirectSourceError, type DirectSourceClientOptions } from "./client.server";
import { getMacroDataset, validSourceDate } from "./macro.server";
import { getSecDataset } from "./sec.server";
import { getAlternativeDataset } from "./alternative.server";

type RouteOptions = DirectSourceClientOptions & {
  load?: (sourceId: DirectSourceId, query: DirectSourceQuery, options: DirectSourceClientOptions) => Promise<DirectSourceDataset>;
};

const HEADERS = { "Cache-Control": "private, no-store" };
const ERROR_MESSAGES = {
  invalid_request: "The data source query is invalid.",
  configuration_required: "This source needs a server-side credential or contact setting.",
  unavailable: "The data source is currently unavailable. Try again later.",
  invalid_response: "The data source response could not be verified.",
  timeout: "The data source did not respond in time.",
  capacity: "Too many research requests are running. Try again shortly.",
} as const;

function parseQuery(sourceId: DirectSourceId, params: URLSearchParams): DirectSourceQuery {
  const definition = DIRECT_SOURCES.find(source => source.id === sourceId)!;
  const allowed = new Set<string>(definition.inputs);
  if (sourceId.startsWith("sec-")) allowed.add("cik");
  const values: Record<string, string> = {};
  for (const [key, raw] of params) {
    if (!allowed.has(key) || key in values) throw new DirectSourceError("invalid_request");
    const value = raw.normalize("NFKC").trim();
    if (!value || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new DirectSourceError("invalid_request");
    values[key] = value;
  }
  if (values.symbol) {
    values.symbol = values.symbol.toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(values.symbol)) throw new DirectSourceError("invalid_request");
  }
  if (values.cik && !/^\d{1,10}$/.test(values.cik)) throw new DirectSourceError("invalid_request");
  if (values.date && !validSourceDate(values.date)) throw new DirectSourceError("invalid_request");
  if (values.series && !/^[A-Z0-9]{1,30}$/.test(values.series)) throw new DirectSourceError("invalid_request");
  if (sourceId.startsWith("sec-") && !values.symbol && !values.cik) throw new DirectSourceError("invalid_request");
  if (sourceId === "finra-short-volume" && (!values.symbol || !values.date)) throw new DirectSourceError("invalid_request");
  if (sourceId === "usaspending" && !values.recipient) throw new DirectSourceError("invalid_request");
  return values;
}

async function loadDataset(id: DirectSourceId, query: DirectSourceQuery, options: DirectSourceClientOptions) {
  if (id === "fred" || id === "cnn-fear-greed") return getMacroDataset(id, query, options);
  if (id === "finra-short-volume" || id === "usaspending") return getAlternativeDataset(id, query, options);
  return getSecDataset(id, query, options);
}

export async function directSourceResponse(request: Request, sourceId: string, options: RouteOptions = {}): Promise<Response> {
  if (!DIRECT_SOURCES.some(source => source.id === sourceId)) return Response.json({ error: { code: "not_found", message: "Unknown data source." } }, { status: 404, headers: HEADERS });
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = parseQuery(sourceId as DirectSourceId, new URL(request.url).searchParams);
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new DirectSourceError("timeout")); }, 45_000);
    });
    const data = await Promise.race([
      (options.load ?? loadDataset)(sourceId as DirectSourceId, query, { ...options, signal: controller.signal }), deadline,
    ]);
    return Response.json(data, { headers: HEADERS });
  } catch (error) {
    const code = error instanceof DirectSourceError ? error.code : "unavailable";
    return Response.json({ error: { code, message: ERROR_MESSAGES[code] } }, { status: code === "invalid_request" ? 400 : code === "timeout" ? 504 : 503, headers: HEADERS });
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
    request.signal.removeEventListener("abort", abort);
  }
}
