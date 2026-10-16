import type { ProviderEnvironment } from "../../src/app/platform/provider-contracts";
import { isSharedDataId, type SharedDataId, type SharedDataResponse } from "../../src/app/platform/shared-data-contracts";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SAFE_ERRORS = new Set(["invalid_request", "unknown_dataset", "cursor_mismatch", "publication_changed", "unavailable", "query_timeout", "configuration_required", "capacity", "invalid_shared_cursor", "invalid_shared_query", "shared_cursor_revision_changed", "shared_data_unavailable", "shared_dataset_not_found", "shared_publication_invalid", "shared_publication_uncommitted", "shared_query_timeout", "shared_row_too_large", "shared_schema_mismatch"]);
export class SharedDataError extends Error {
  constructor(readonly code: string, readonly status: number = 502) { super(code); }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function readBounded(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new SharedDataError("invalid_response");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new SharedDataError("invalid_response");
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new SharedDataError("invalid_response"); }
  finally { await reader.cancel().catch(() => undefined); }
}

export function validateSharedData(value: unknown, dataset: SharedDataId): SharedDataResponse {
  if (!record(value) || value.schemaVersion !== "trader.shared-data.v1" || value.dataset !== dataset
    || !Array.isArray(value.rows) || value.rows.length > 1000 || !value.rows.every(record)
    || !Array.isArray(value.columns) || value.columns.length > 150
    || !value.columns.every(column => record(column) && typeof column.key === "string" && typeof column.label === "string")
    || !record(value.provenance) || typeof value.provenance.revision !== "string"
    || !/^\d{8}T\d{6}\.\d{6}Z-[0-9a-f]{8}$/.test(value.provenance.revision)
    || typeof value.provenance.readAt !== "string" || !Number.isFinite(Date.parse(value.provenance.readAt))
    || !(value.provenance.publishedAt === null || typeof value.provenance.publishedAt === "string" && Number.isFinite(Date.parse(value.provenance.publishedAt)))
    || !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === "string")
    || !record(value.coverage) || !["partial", "complete", "empty"].includes(String(value.coverage.status)) || value.coverage.returned !== value.rows.length
    || !record(value.pagination) || typeof value.pagination.hasMore !== "boolean"
    || !Number.isSafeInteger(value.pagination.limit) || Number(value.pagination.limit) < 1 || Number(value.pagination.limit) > 1000
    || !(value.pagination.nextCursor === null || typeof value.pagination.nextCursor === "string" && value.pagination.nextCursor.length <= 4096)
    || value.pagination.hasMore !== (value.pagination.nextCursor !== null) || value.rows.length > Number(value.pagination.limit)
    || !record(value.source) || value.source.kind !== "shared-store" || value.source.access !== "read-only-sqlite"
    || value.source.id !== (dataset.startsWith("institutional-") ? "finance-13f" : "x-finance")) throw new SharedDataError("invalid_response");
  return value as SharedDataResponse;
}

export function createSharedDataClient(env: ProviderEnvironment, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
  return {
    async get(dataset: SharedDataId, query: URLSearchParams, signal?: AbortSignal): Promise<SharedDataResponse> {
      if (!isSharedDataId(dataset) || query.toString().length > 8192) throw new SharedDataError("invalid_request", 400);
      const token = env.TRADER_TRADINGVIEW_SIDECAR_TOKEN?.trim();
      let base: URL;
      try { base = new URL(env.TRADER_TRADINGVIEW_SIDECAR_URL ?? ""); }
      catch { throw new SharedDataError("configuration_required", 503); }
      if (!token || base.username || base.password || base.search || base.hash
        || !(base.protocol === "https:" || base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new SharedDataError("configuration_required", 503);
      const url = new URL(`/v1/shared-data/${dataset}`, base);
      url.search = query.toString();
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 20_000);
      try {
        const response = await fetcher(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          redirect: "manual", signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel(); throw new SharedDataError("unavailable");
        }
        const value = await readBounded(response);
        if (!response.ok) {
          const rawCode = record(value) ? (record(value.error) ? value.error.code : value.error) : undefined;
          const code = typeof rawCode === "string" && SAFE_ERRORS.has(rawCode) ? rawCode : "unavailable";
          throw new SharedDataError(code, [400, 404, 409, 429, 503, 504].includes(response.status) ? response.status : 502);
        }
        return validateSharedData(value, dataset);
      } catch (error) {
        if (controller.signal.aborted) throw new SharedDataError("query_timeout", 504);
        if (error instanceof SharedDataError) throw error;
        throw new SharedDataError(controller.signal.aborted ? "query_timeout" : "unavailable", controller.signal.aborted ? 504 : 502);
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    },
  };
}
