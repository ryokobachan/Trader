import {
  PROVIDER_SCHEMA_VERSION,
  type EarningsEvent,
  type Instrument,
  type ProviderAdapter,
  type ProviderEnvironment,
  type ProviderRegistration,
  type ProviderRequestContext,
} from "@/app/platform/provider-contracts";

const RPC_ID = "wKsYyb";
const RPC_URL = "https://www.google.com/finance/beta/_/FinHubUi/data/batchexecute?rpcids=wKsYyb&hl=en";
const MAX_EVENTS = 100;
const MAX_CACHE_ENTRIES = 200;
const MAX_IN_FLIGHT = 32;
type CachedEarnings = { expiresAt: number; events: readonly EarningsEvent[] };
type CacheState = {
  cache: Map<string, CachedEarnings>;
  inFlight: Map<string, Promise<readonly EarningsEvent[]>>;
};
const sharedStates = new WeakMap<typeof globalThis.fetch, CacheState>();

type GoogleEarningsFetch = typeof globalThis.fetch;
type ErrorCode = "invalid_request" | "invalid_response" | "upstream" | "timeout" | "aborted" | "capacity";

/** Deliberately excludes upstream response bodies and original network errors. */
export class GoogleFinanceEarningsError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "GoogleFinanceEarningsError";
  }
}

export type GoogleFinanceEarningsProviderOptions = Readonly<{
  fetch?: GoogleEarningsFetch;
  now?: () => Date;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxResponseBytes?: number;
}>;

const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "google-finance-earnings",
  version: "1.0.0",
  displayName: "Google Finance Earnings",
  capabilities: ["fundamentals.earnings"],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: [],
} as const;

function invalidResponse(message = "Google Finance earnings response has an unexpected format."): never {
  throw new GoogleFinanceEarningsError("invalid_response", message);
}

function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
}

function envMilliseconds(value: string | undefined) {
  return value?.trim() ? Number(value) * 1_000 : undefined;
}

function listing(instrument: Instrument) {
  const symbol = instrument.symbol.normalize("NFKC").trim().toUpperCase();
  const exchanges: Readonly<Record<string, string>> = {
    XNAS: "NASDAQ", XNYS: "NYSE", XASE: "NYSEAMERICAN",
  };
  const exchange = exchanges[instrument.exchangeMic.toUpperCase()];
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || !exchange
    || instrument.currency !== "USD" || instrument.listingCountry !== "US") {
    throw new GoogleFinanceEarningsError("invalid_request", "A supported US stock listing is required.");
  }
  return { symbol: symbol.replaceAll("-", "."), exchange };
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) invalidResponse();
  return value;
}

function fiscalDate(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3
    || !value.every((part) => typeof part === "number" && Number.isInteger(part))) invalidResponse();
  const [year, month, day] = value as number[];
  if (year! < 1900 || year! > 2200) invalidResponse();
  const result = new Date(Date.UTC(year!, month! - 1, day!));
  if (result.getUTCFullYear() !== year || result.getUTCMonth() + 1 !== month || result.getUTCDate() !== day) {
    invalidResponse();
  }
  return result.toISOString().slice(0, 10);
}

/** Decode only the observed earnings RPC. Never evaluate page JavaScript. */
function earningsRows(body: string): readonly unknown[] {
  let records: readonly unknown[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    // The XSSI prefix and length framing are not JSON packets.
    if (!trimmed.startsWith("[")) continue;
    let packet: unknown;
    try { packet = JSON.parse(trimmed); } catch { invalidResponse(); }
    if (!Array.isArray(packet)) continue;
    for (const envelope of packet) {
      if (!Array.isArray(envelope) || envelope[0] !== "wrb.fr" || envelope[1] !== RPC_ID) continue;
      if (records !== undefined || typeof envelope[2] !== "string") invalidResponse();
      let decoded: unknown;
      try { decoded = JSON.parse(envelope[2]); } catch { invalidResponse(); }
      if (!Array.isArray(decoded) || !Array.isArray(decoded[0]) || !Array.isArray(decoded[0][0])) {
        invalidResponse();
      }
      records = decoded[0][0];
    }
  }
  if (records === undefined || records.length > MAX_EVENTS) invalidResponse();
  return records;
}

/** Positional fields are from the public earnings page's observed RPC schema. */
export function extractGoogleFinanceEarnings(
  body: string,
  instrument: Instrument,
  ingestedAt: string,
): readonly EarningsEvent[] {
  const { symbol, exchange } = listing(instrument);
  const sourceUrl = `https://www.google.com/finance/beta/quote/${encodeURIComponent(symbol)}:${exchange}?tab=earnings&hl=en`;
  const events: EarningsEvent[] = [];
  const identities = new Set<string>();
  for (const raw of earningsRows(body)) {
    if (!Array.isArray(raw) || raw.length < 12 || !Array.isArray(raw[1])
      || raw[1].length !== 2 || raw[1][0] !== symbol || raw[1][1] !== exchange
      || !Number.isInteger(raw[3]) || raw[3] < 1900 || raw[3] > 2200
      || !Number.isInteger(raw[4]) || raw[4] < 1 || raw[4] > 4
      || !Array.isArray(raw[9]) || raw[9].length < 18) invalidResponse();
    const values: unknown[] = raw[9];
    // The current canonical monetary contract is USD. Never mislabel ADR reports.
    if (values[16] !== "USD") continue;
    const timestamp = Array.isArray(raw[11]) ? optionalNumber(raw[11][0]) : undefined;
    // A fiscal period alone does not establish a real announcement date.
    if (timestamp === undefined || !Number.isInteger(timestamp) || timestamp <= 0 || timestamp > 7_258_118_400) continue;
    const reportTime = new Date(timestamp * 1_000).toISOString();
    const reportDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(reportTime));
    const fiscalDateEnding = fiscalDate(values[17]);
    const fiscalPeriod = `${raw[3]}-Q${raw[4]}`;
    const identity = `${fiscalPeriod}:${reportTime}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    const revenueActual = optionalNumber(values[0]);
    const revenueEstimate = optionalNumber(values[8]);
    // Statement EPS can differ materially from the earnings-display/consensus basis.
    const statementEPS = optionalNumber(values[2]);
    const epsActual = optionalNumber(values[9]);
    const epsEstimate = optionalNumber(values[10]);
    if ([revenueActual, revenueEstimate, statementEPS, epsActual, epsEstimate].every((value) => value === undefined)) continue;
    events.push(Object.freeze({
      reportDate,
      ...(fiscalDateEnding ? { fiscalDateEnding } : {}),
      fiscalPeriod,
      epsBasis: "earnings_display" as const,
      ...(statementEPS === undefined ? {} : { statementEPS }),
      ...(epsActual === undefined ? {} : { epsActual }),
      ...(epsEstimate === undefined ? {} : { epsEstimate }),
      ...(revenueActual === undefined ? {} : { revenueActual }),
      ...(revenueEstimate === undefined ? {} : { revenueEstimate }),
      provenance: Object.freeze({
        providerId: manifest.id,
        sourceId: `${manifest.id}:${exchange}:${symbol}:${identity}`,
        asOf: reportTime,
        ingestedAt,
        sourceUrl,
      }),
    }));
  }
  return Object.freeze(events.sort((a, b) => b.provenance.asOf.localeCompare(a.provenance.asOf)));
}

async function limitedText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit) invalidResponse("Google Finance earnings response was too large.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => undefined);
        invalidResponse("Google Finance earnings response was too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function withCallerSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new GoogleFinanceEarningsError("aborted", "Google Finance earnings request was aborted."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createGoogleFinanceEarningsProvider(
  env: ProviderEnvironment,
  options: GoogleFinanceEarningsProviderOptions = {},
): ProviderAdapter {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  const timeoutMs = bounded(options.timeoutMs ?? envMilliseconds(env.GOOGLE_FINANCE_EARNINGS_TIMEOUT_SECONDS ?? env.GOOGLE_FINANCE_TIMEOUT_SECONDS), 12_000, 1, 60_000);
  const cacheTtlMs = bounded(options.cacheTtlMs ?? envMilliseconds(env.GOOGLE_FINANCE_EARNINGS_CACHE_TTL_SECONDS ?? env.GOOGLE_FINANCE_CACHE_TTL_SECONDS), 3_600_000, 1, 86_400_000);
  const maxBytes = bounded(options.maxResponseBytes, 2_000_000, 1_000, 5_000_000);
  // Production runtimes are recreated per HTTP request. Keep their cache across adapters,
  // while injected clocks/transports stay isolated for tests and alternate consumers.
  const isolated = options.fetch !== undefined || options.now !== undefined;
  let state = isolated ? undefined : sharedStates.get(globalThis.fetch);
  if (!state) {
    state = { cache: new Map(), inFlight: new Map() };
    if (!isolated) sharedStates.set(globalThis.fetch, state);
  }
  const { cache, inFlight } = state;

  async function load(instrument: Instrument): Promise<readonly EarningsEvent[]> {
    const { symbol, exchange } = listing(instrument);
    const argument = JSON.stringify([[null, [symbol, exchange]]]);
    const body = new URLSearchParams({ "f.req": JSON.stringify([[[RPC_ID, argument, null, "generic"]]]) });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new GoogleFinanceEarningsError("timeout", "Google Finance earnings request timed out."));
        controller.abort();
      }, timeoutMs);
    });
    const operation = async () => {
      const response = await fetchImplementation(RPC_URL, {
        // Workerd supports manual/follow only. Reject non-2xx responses below,
        // including redirects, instead of following a different upstream URL.
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
      });
      if (!response.ok) throw new GoogleFinanceEarningsError("upstream", "Google Finance earnings request failed.", response.status);
      return extractGoogleFinanceEarnings(await limitedText(response, maxBytes), instrument, now().toISOString());
    };
    try { return await Promise.race([operation(), timeout]); }
    catch (error) {
      if (error instanceof GoogleFinanceEarningsError) throw error;
      throw new GoogleFinanceEarningsError("upstream", "Google Finance earnings request failed.");
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  const getEarnings = async (instrument: Instrument, context: ProviderRequestContext) => {
    if (context.signal?.aborted) throw new GoogleFinanceEarningsError("aborted", "Google Finance earnings request was aborted.");
    const { symbol, exchange } = listing(instrument);
    const key = `${timeoutMs}:${cacheTtlMs}:${maxBytes}:${exchange}:${symbol}`;
    const current = now().getTime();
    if (!Number.isFinite(current)) throw new GoogleFinanceEarningsError("invalid_request", "Google Finance earnings clock is invalid.");
    const cached = cache.get(key);
    if (!context.fresh && cached && cached.expiresAt > current) return cached.events;
    let work = inFlight.get(key);
    if (!work) {
      if (inFlight.size >= MAX_IN_FLIGHT) throw new GoogleFinanceEarningsError("capacity", "Google Finance earnings request capacity was reached.");
      work = load(instrument).then((events) => {
        for (const [entryKey, value] of cache) if (value.expiresAt <= current) cache.delete(entryKey);
        cache.delete(key);
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
        cache.set(key, { events, expiresAt: now().getTime() + cacheTtlMs });
        return events;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, work);
    }
    return withCallerSignal(work, context.signal);
  };
  return Object.freeze({
    manifest,
    fundamentals: {
      getProfile: async () => null,
      getFundamentals: async () => null,
      getEarnings,
    },
  });
}

export const googleFinanceEarningsProviderRegistration = {
  manifest,
  create: (env) => createGoogleFinanceEarningsProvider(env),
} as const satisfies ProviderRegistration;
