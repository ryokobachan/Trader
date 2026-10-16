/** Native JSON is preserved: check coverage, source, publication dates and missing values. */
export class TraderDataError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = "TraderDataError"; this.code = code; this.status = status; }
}
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
export class TraderDataClient {
  constructor({ baseUrl = "http://localhost:3001", timeoutMs = 60000, headers = {}, fetch: fetcher = globalThis.fetch.bind(globalThis) } = {}) {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new TypeError("baseUrl must be an HTTP(S) origin without credentials");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError("timeoutMs must be 1–120000");
    Object.assign(this, { baseUrl: url.origin, timeoutMs, headers, fetcher });
  }
  async request(path, parameters = {}, { signal } = {}) {
    const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value != null && value !== false).map(([key, value]) => [key, value === true ? "1" : String(value)]));
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}${query.size ? `?${query}` : ""}`, { headers: { Accept: "application/json", ...this.headers }, signal: controller.signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new TraderDataError("redirect_rejected", "API redirects are not followed", response.status); }
      const reader = response.body?.getReader();
      if (!reader) throw new TraderDataError("invalid_response", "Response has no JSON body", response.status);
      let length = 0; const parts = [];
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.length;
          if (length > 20 * 1024 * 1024) throw new TraderDataError("response_too_large", "Response exceeds 20 MiB");
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      let payload;
      try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new TraderDataError("invalid_response", "Trader did not return valid JSON", response.status); }
      if (!response.ok || isRecord(payload?.error)) throw new TraderDataError(payload?.error?.code ?? "http_error", payload?.error?.message ?? "Trader request failed", response.status);
      if (!isRecord(payload)) throw new TraderDataError("invalid_response", "Expected a JSON object", response.status);
      return payload;
    } catch (error) {
      if (error instanceof TraderDataError) throw error;
      throw new TraderDataError(controller.signal.aborted ? "timeout" : "network_error", "Trader request failed or timed out");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  dataset(id) { if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new TypeError("Invalid dataset ID"); return id; }
  sources(filters = {}, options) { return this.request("/api/v1/data", filters, options); }
  describe(dataset, options) { return this.request(`/api/v1/data/${this.dataset(dataset)}/describe`, {}, options); }
  get(dataset, parameters = {}, options) { return this.request(`/api/v1/data/${this.dataset(dataset)}`, parameters, options); }
  async *pages(dataset, parameters = {}, { maxPages = 10, signal } = {}) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new TypeError("maxPages must be an integer from 1 to 1000");
    const query = { ...parameters }; const seen = new Set();
    for (let index = 0; index < maxPages; index++) {
      const page = await this.get(dataset, query, { signal }); yield page;
      const cursor = page.pagination?.nextCursor;
      if (cursor == null) return;
      if (typeof cursor !== "string" || !cursor || seen.has(cursor)) throw new TraderDataError("invalid_cursor", "Cursor is empty or repeated");
      seen.add(cursor); query.cursor = cursor;
    }
    throw new TraderDataError("page_limit", "Pagination limit reached; resume explicitly with the last nextCursor");
  }
}
