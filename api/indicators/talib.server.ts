import type { ProviderEnvironment } from "../../src/app/platform/provider-contracts";
import type { TalibCalculation, TalibCatalog } from "../../src/app/platform/talib-contracts";

export const MAX_TALIB_REQUEST_BYTES = 3_000_000;
const MAX_RESPONSE_BYTES = 16_000_000;
type ErrorCode = "invalid_request" | "configuration_required" | "unavailable" | "capacity";
export class TalibError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}

export async function boundedJson(message: Request | Response, maximum: number): Promise<unknown> {
  if (!message.body || Number(message.headers.get("content-length")) > maximum) throw new TalibError("invalid_request");
  const reader = message.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new TalibError("invalid_request"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new TalibError("invalid_request"); }
  finally { reader.releaseLock(); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validBase(value: unknown): value is Record<string, unknown> {
  return record(value) && value.schemaVersion === "trader.talib.v1" && value.engine === "TA-Lib" && typeof value.version === "string";
}
function numericMap(value: unknown) {
  return record(value) && Object.values(value).every(item => typeof item === "number" && Number.isFinite(item));
}
function validDefinition(value: unknown) {
  return record(value) && typeof value.id === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(value.id)
    && typeof value.name === "string" && typeof value.group === "string"
    && numericMap(value.parameters) && record(value.inputs)
    && Object.values(value.inputs).every(input => typeof input === "string" || Array.isArray(input) && input.every(item => typeof item === "string"))
    && Number.isSafeInteger(value.lookback) && Number(value.lookback) >= 0;
}
export function validateTalibCatalog(value: unknown): TalibCatalog {
  if (!validBase(value) || !Array.isArray(value.indicators) || !value.indicators.length || value.indicators.length > 200
    || !value.indicators.every(item => validDefinition(item) && record(item) && Array.isArray(item.outputs) && item.outputs.every(name => typeof name === "string"))
    || !record(value.limits) || value.limits.maxBars !== 10000 || value.limits.maxIndicators !== 8) throw new TalibError("unavailable");
  return value as unknown as TalibCatalog;
}
export function validateTalibCalculation(value: unknown): TalibCalculation {
  if (!validBase(value) || !Array.isArray(value.times) || !value.times.length || value.times.length > 10000
    || !value.times.every(time => typeof time === "string" && Number.isFinite(Date.parse(time))) || value.barCount !== value.times.length
    || !Array.isArray(value.results) || !value.results.length || value.results.length > 8) throw new TalibError("unavailable");
  const count = value.times.length;
  if (!value.results.every(item => validDefinition(item) && record(item) && Array.isArray(item.series) && item.series.length > 0 && item.series.length <= 4
    && item.series.every(series => record(series) && typeof series.name === "string" && Array.isArray(series.values) && series.values.length === count
      && series.values.every(number => number === null || typeof number === "number" && Number.isFinite(number))))) throw new TalibError("unavailable");
  return value as unknown as TalibCalculation;
}

export function createTalibClient(env: ProviderEnvironment, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
  async function call(path: string, signal?: AbortSignal, payload?: unknown): Promise<unknown> {
    const token = env.TRADER_TRADINGVIEW_SIDECAR_TOKEN?.trim();
    let base: URL;
    try { base = new URL(env.TRADER_TRADINGVIEW_SIDECAR_URL ?? ""); }
    catch { throw new TalibError("configuration_required"); }
    if (!token || base.username || base.password || base.search || base.hash
      || !(base.protocol === "https:" || base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new TalibError("configuration_required");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 20_000);
    try {
      const response = await fetcher(new URL(path, base), {
        method: payload === undefined ? "GET" : "POST", redirect: "manual",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TalibError(response.status === 400 ? "invalid_request" : response.status === 429 ? "capacity" : "unavailable");
      }
      return await boundedJson(response, MAX_RESPONSE_BYTES).catch(() => { throw new TalibError("unavailable"); });
    } catch (error) {
      if (error instanceof TalibError) throw error;
      throw new TalibError("unavailable");
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  }
  return {
    async catalog(signal?: AbortSignal) { return validateTalibCatalog(await call("/v1/indicators", signal)); },
    async calculate(payload: unknown, signal?: AbortSignal) {
      const result = validateTalibCalculation(await call("/v1/indicators/calculate", signal, payload));
      if (!record(payload) || !Array.isArray(payload.bars) || !Array.isArray(payload.indicators)
        || payload.bars.length !== result.times.length || payload.indicators.length !== result.results.length
        || payload.bars.some((bar, index) => !record(bar) || bar.time !== result.times[index])
        || payload.indicators.some((spec, index) => !record(spec) || spec.id !== result.results[index].id
          || record(spec.parameters) && Object.entries(spec.parameters).some(([key, value]) => result.results[index].parameters[key] !== value))) throw new TalibError("unavailable");
      return result;
    },
  };
}

export function talibErrorResponse(error: unknown) {
  const code = error instanceof TalibError ? error.code : "unavailable";
  const status = code === "invalid_request" ? 400 : code === "configuration_required" ? 503 : code === "capacity" ? 429 : 502;
  const message = code === "invalid_request" ? "OHLCV・指標名・パラメータを確認してください。"
    : code === "configuration_required" ? "TraderのTA-Lib計算サービスを設定してください。"
      : "TA-Libで指標を計算できませんでした。";
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}
