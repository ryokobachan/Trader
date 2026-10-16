export type DirectSourceClientOptions = Readonly<{
  fetch?: typeof fetch;
  now?: () => Date;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export class DirectSourceError extends Error {
  constructor(
    readonly code: "invalid_request" | "configuration_required" | "unavailable" | "invalid_response" | "timeout" | "capacity",
    message?: string,
  ) {
    super(message ?? `Research data ${code.replaceAll("_", " ")}.`);
    this.name = "DirectSourceError";
  }
}

type FetchOptions = DirectSourceClientOptions & Readonly<{
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  maxBytes?: number;
  allowLoopback?: boolean;
}>;

let activeRequests = 0;
const MAX_ACTIVE_REQUESTS = 6;

/** Fixed vendor URLs are constructed only by reviewed adapters. Never log them. */
export async function fetchSourceText(url: string, options: FetchOptions = {}): Promise<string> {
  if (activeRequests >= MAX_ACTIVE_REQUESTS) throw new DirectSourceError("capacity");
  if (options.signal?.aborted) throw new DirectSourceError("unavailable");
  const target = new URL(url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if ((target.protocol !== "https:" && !(options.allowLoopback && target.protocol === "http:" && loopback)) || target.username || target.password) throw new DirectSourceError("invalid_request");
  activeRequests += 1;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(30_000, Math.max(1, options.timeoutMs!)) : 12_000;
  const maxBytes = Math.min(24_000_000, Math.max(1, options.maxBytes ?? 2_000_000));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new DirectSourceError("timeout")); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      // Vinext's development fetch adapter does not support redirect/cache options.
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: options.method ?? "GET", body: options.body,
        headers: { Accept: "application/json,text/plain,*/*", ...options.headers },
        signal: controller.signal,
      });
      if (!response.ok) throw new DirectSourceError("unavailable");
      if (response.url && new URL(response.url).origin !== target.origin) throw new DirectSourceError("invalid_response");
      const declaredLength = response.headers.get("content-length");
      if (declaredLength && Number(declaredLength) > maxBytes) throw new DirectSourceError("invalid_response");
      if (!response.body) throw new DirectSourceError("invalid_response");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let text = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new DirectSourceError("invalid_response");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    })()]);
  } catch (error) {
    // No upstream URL, response body, token, or exception crosses this boundary.
    if (error instanceof DirectSourceError) throw error;
    throw new DirectSourceError("unavailable");
  } finally {
    controller.abort();
    if (timeout) clearTimeout(timeout);
    void reader?.cancel().catch(() => undefined);
    options.signal?.removeEventListener("abort", abort);
    activeRequests -= 1;
  }
}

export async function fetchSourceJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  const text = await fetchSourceText(url, options);
  try { return JSON.parse(text) as unknown; }
  catch { throw new DirectSourceError("invalid_response"); }
}

type CacheEntry = { expires: number; value: unknown; weight: number };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<unknown>>();
let cacheWeight = 0;
let activeLoads = 0;

export async function cachedSource<T>(key: string, ttlMs: number, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DirectSourceError("unavailable");
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  if (hit) { cacheWeight -= hit.weight; cache.delete(key); }
  // A caller-owned abort must never cancel another caller's in-flight load.
  const existing = signal ? undefined : pending.get(key);
  if (existing) return existing as Promise<T>;
  if (activeLoads >= 12) throw new DirectSourceError("capacity");
  activeLoads += 1;
  const promise = Promise.resolve().then(load).then(value => {
    if (signal?.aborted) throw new DirectSourceError("unavailable");
    const weight = JSON.stringify(value)?.length ?? 0;
    if (weight <= 1_000_000 && ttlMs > 0) {
      const previous = cache.get(key);
      if (previous) { cacheWeight -= previous.weight; cache.delete(key); }
      while (cache.size >= 16 || cacheWeight + weight > 4_000_000) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cacheWeight -= cache.get(oldest)!.weight;
        cache.delete(oldest);
      }
      cache.set(key, { value, weight, expires: Date.now() + ttlMs });
      cacheWeight += weight;
    }
    return value;
  }).finally(() => { activeLoads -= 1; if (!signal) pending.delete(key); });
  if (!signal) pending.set(key, promise);
  return promise;
}
