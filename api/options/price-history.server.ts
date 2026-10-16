type JsonRecord = Record<string, unknown>;
export type OptionPriceHistoryRequest = Readonly<{ symbol: string; contractId: string }>;
export type OptionPriceHistoryBar = Readonly<{
  /** Session date as labelled by the provider, never shifted to match another feed. */
  date: string;
  /** Original provider Unix timestamp, if supplied. A date-only source leaves it absent. */
  time?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  openInterest?: number;
}>;
export type OptionsPriceHistory = Readonly<{
  symbol: string;
  contractId: string;
  expiration: string;
  side: "call" | "put";
  strike: number;
  /** Identity only: option prices must never be labelled as the stock price. */
  underlying: Readonly<{ symbol: string }>;
  source: "ChartExchange" | "Yahoo Finance";
  sourceUrl: string;
  fetchedAt: string;
  /** Actual source quote time, when supplied; never inferred from a daily row. */
  sourceAsOf: string | null;
  latestOptionPrice?: number;
  currency: "USD";
  timezone: string;
  interval: "1d";
  requestedRange: "available" | "1y";
  /** ChartExchange's row date is not a verified publication or clearing timestamp. */
  openInterestDateBasis?: "source_session_date_unverified";
  /** OHLC as supplied; source adjustments are not independently verified. */
  priceAdjustment: "source_ohlc";
  adjustedCloseUsed: false;
  items: readonly OptionPriceHistoryBar[];
  /** Original provider coverage before any HTTP from/to filtering. */
  coverage: Readonly<{
    from: string;
    to: string;
    firstDate: string | null;
    lastDate: string | null;
    missingBars: number;
    sourceRows: number;
    returnedBars: number;
    observedBars: number;
  }>;
  /** Optional inclusive bounds on the provider's original session-date labels. */
  requestWindow?: Readonly<{ from?: string; to?: string }>;
  /** Statistics for the returned items only; absent when no date filter was requested. */
  filteredCoverage?: Readonly<{
    firstDate: string | null;
    lastDate: string | null;
    returnedBars: number;
    observedBars: number;
    /** Returned source rows with all OHLC, volume and OI fields absent, not missing calendar days. */
    missingBars: number;
  }>;
}>;
type ErrorCode = "invalid_request" | "unavailable" | "not_found" | "invalid_response" | "timeout" | "capacity";
export class OptionPriceHistoryError extends Error {
  constructor(readonly code: ErrorCode, readonly retryable = false) {
    super(`Option price history ${code.replaceAll("_", " ")}.`);
    this.name = "OptionPriceHistoryError";
  }
}

const MAX_BYTES = 2_000_000;
const MAX_BARS = 400;
const MAX_CACHE_KEYS = 64;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;
const FIELDS = ["open", "high", "low", "close", "volume"] as const;
const record = (value: unknown): JsonRecord | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

export function optionPriceHistoryIdentity(request: OptionPriceHistoryRequest) {
  const symbol = request.symbol.normalize("NFKC").trim().toUpperCase();
  const contractId = request.contractId.normalize("NFKC").trim().toUpperCase();
  if (!SYMBOL.test(symbol) || !contractId.startsWith(symbol)) throw new OptionPriceHistoryError("invalid_request");
  const match = contractId.slice(symbol.length).match(/^(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) throw new OptionPriceHistoryError("invalid_request");
  const expiration = `20${match[1]}-${match[2]}-${match[3]}`;
  const strike = Number(match[5]) / 1_000;
  if (!validDate(expiration) || strike <= 0) throw new OptionPriceHistoryError("invalid_request");
  return { symbol, contractId, expiration, side: match[4] === "C" ? "call" as const : "put" as const, strike };
}

function sessionFormatter(timezone: unknown) {
  if (typeof timezone !== "string" || timezone.length > 100 || !/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(timezone)) throw new OptionPriceHistoryError("invalid_response");
  try {
    return { timezone, formatter: new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }) };
  } catch { throw new OptionPriceHistoryError("invalid_response"); }
}

function sessionDate(time: number, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(new Date(time * 1_000));
  const part = (name: string) => parts.find(item => item.type === name)?.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  if (!validDate(date)) throw new OptionPriceHistoryError("invalid_response");
  return date;
}

function oneYearBefore(date: string) {
  const year = Number(date.slice(0, 4)) - 1;
  const previous = `${year}${date.slice(4)}`;
  return validDate(previous) ? previous : `${year}-02-28`;
}

function sourceTimestamp(value: unknown, fetchedTime: number) {
  return finite(value) && Number.isSafeInteger(value) && value > 0 && value <= fetchedTime / 1_000 + 300 ? value : undefined;
}

export function parseYahooOptionPriceHistory(payload: unknown, request: OptionPriceHistoryRequest, fetchedAt: string): OptionsPriceHistory {
  const identity = optionPriceHistoryIdentity(request);
  const fetchedTime = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedTime)) throw new OptionPriceHistoryError("invalid_request");
  const chart = record(record(payload)?.chart);
  if (!chart) throw new OptionPriceHistoryError("invalid_response");
  if (chart.error) throw new OptionPriceHistoryError(record(chart.error)?.code === "Not Found" ? "not_found" : "unavailable");
  if (!Array.isArray(chart.result) || chart.result.length !== 1) throw new OptionPriceHistoryError("invalid_response");
  const result = record(chart.result[0]);
  const meta = record(result?.meta);
  if (!result || !meta || meta.symbol !== identity.contractId || meta.instrumentType !== "OPTION" || meta.currency !== "USD" || meta.dataGranularity !== "1d") throw new OptionPriceHistoryError("invalid_response");
  const { timezone, formatter } = sessionFormatter(meta.exchangeTimezoneName);
  const to = sessionDate(fetchedTime / 1_000, formatter);
  const from = oneYearBefore(to);
  const timestamps = result.timestamp;
  if (!Array.isArray(timestamps) || timestamps.length > MAX_BARS) throw new OptionPriceHistoryError("invalid_response");
  const quotes = record(result.indicators)?.quote;
  if (!Array.isArray(quotes) || quotes.length !== 1 || !record(quotes[0])) throw new OptionPriceHistoryError("invalid_response");
  const quote = record(quotes[0])!;
  for (const field of FIELDS) {
    if (quote[field] !== undefined && (!Array.isArray(quote[field]) || quote[field].length !== timestamps.length)) throw new OptionPriceHistoryError("invalid_response");
  }
  const items: OptionPriceHistoryBar[] = [];
  let previousTime = -1;
  let previousDate = "";
  let missingBars = 0;
  for (let index = 0; index < timestamps.length; index++) {
    const time = sourceTimestamp(timestamps[index], fetchedTime);
    if (time === undefined || time <= previousTime) throw new OptionPriceHistoryError("invalid_response");
    const date = sessionDate(time, formatter);
    if (date <= previousDate || date > to || date > identity.expiration) throw new OptionPriceHistoryError("invalid_response");
    previousTime = time;
    previousDate = date;
    const bar: { date: string; time: number } & Partial<Record<typeof FIELDS[number], number>> = { date, time };
    for (const field of FIELDS) {
      const raw = Array.isArray(quote[field]) ? quote[field][index] : undefined;
      if (raw === null || raw === undefined) continue;
      if (!finite(raw) || raw < 0 || (field === "volume" && !Number.isSafeInteger(raw))) throw new OptionPriceHistoryError("invalid_response");
      bar[field] = raw;
    }
    if ((bar.high !== undefined && bar.low !== undefined && bar.high < bar.low)
      || [bar.open, bar.close].some(value => value !== undefined && ((bar.high !== undefined && value > bar.high) || (bar.low !== undefined && value < bar.low)))) throw new OptionPriceHistoryError("invalid_response");
    if (date < from) continue;
    // Retain source-supplied empty dates so charts can show a gap. No date or
    // numeric value is fabricated, and missing volume is distinct from zero.
    if (FIELDS.every(field => bar[field] === undefined)) missingBars++;
    items.push(bar);
  }
  const sourceTime = sourceTimestamp(meta.regularMarketTime, fetchedTime);
  return {
    ...identity, underlying: { symbol: identity.symbol }, source: "Yahoo Finance",
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(identity.contractId)}/history/`,
    fetchedAt, sourceAsOf: sourceTime === undefined ? null : new Date(sourceTime * 1_000).toISOString(),
    ...(finite(meta.regularMarketPrice) && meta.regularMarketPrice >= 0 ? { latestOptionPrice: meta.regularMarketPrice } : {}),
    currency: "USD", timezone, interval: "1d", requestedRange: "1y", priceAdjustment: "source_ohlc", adjustedCloseUsed: false,
    items, coverage: { from, to, firstDate: items[0]?.date ?? null, lastDate: items.at(-1)?.date ?? null, missingBars, sourceRows: timestamps.length, returnedBars: items.length, observedBars: items.length - missingBars },
  };
}

type ClientOptions = Readonly<{ fetch?: typeof fetch; now?: () => Date; timeoutMs?: number; cacheTtlMs?: number }>;

export function createOptionPriceHistoryClient(options: ClientOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 10_000, 10_000));
  const ttl = Math.max(1, Math.min(options.cacheTtlMs ?? 300_000, 300_000));
  const cache = new Map<string, { result: OptionsPriceHistory; savedAt: number }>();
  const inFlight = new Map<string, Promise<OptionsPriceHistory>>();
  const failures = new Map<string, { until: number; error: OptionPriceHistoryError }>();

  async function fetchJson(url: URL, signal: AbortSignal) {
    let response: Response;
    try {
      if (signal.aborted) throw new OptionPriceHistoryError("timeout");
      response = await fetcher(url, { signal, headers: { Accept: "application/json", "User-Agent": "Trader/0.1 local research" } });
    } catch (error) {
      if (error instanceof OptionPriceHistoryError) throw error;
      throw new OptionPriceHistoryError(signal.aborted ? "timeout" : "unavailable", !signal.aborted);
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Authorization and rate-limit responses are not retried via another host.
      throw new OptionPriceHistoryError(response.status === 404 ? "not_found" : "unavailable", response.status >= 500);
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw new OptionPriceHistoryError("invalid_response");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new OptionPriceHistoryError("invalid_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new OptionPriceHistoryError("invalid_response"); }
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof OptionPriceHistoryError) throw error;
      throw new OptionPriceHistoryError(signal.aborted ? "timeout" : "unavailable", !signal.aborted);
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { throw new OptionPriceHistoryError("invalid_response"); }
  }

  async function load(request: OptionPriceHistoryRequest) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
        const url = new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(request.contractId)}`);
        url.search = new URLSearchParams({ range: "1y", interval: "1d", includePrePost: "false" }).toString();
        try { return parseYahooOptionPriceHistory(await fetchJson(url, controller.signal), request, now().toISOString()); }
        catch (error) {
          if (host === "query1.finance.yahoo.com" && error instanceof OptionPriceHistoryError && error.retryable && !controller.signal.aborted) continue;
          throw error;
        }
      }
      throw new OptionPriceHistoryError("unavailable");
    } finally { clearTimeout(timer); controller.abort(); }
  }

  return { getHistory: async (request: OptionPriceHistoryRequest): Promise<OptionsPriceHistory> => {
    const normalized = optionPriceHistoryIdentity(request);
    const key = normalized.contractId;
    const current = now().getTime();
    const saved = cache.get(key);
    if (saved && current - saved.savedAt < ttl) return saved.result;
    const failure = failures.get(key);
    if (failure && failure.until > current) throw failure.error;
    const pending = inFlight.get(key);
    if (pending) return pending;
    if (inFlight.size >= 8) throw new OptionPriceHistoryError("capacity");
    const work = load(normalized).then(result => {
      cache.delete(key);
      if (cache.size >= MAX_CACHE_KEYS) cache.delete(cache.keys().next().value!);
      cache.set(key, { result, savedAt: now().getTime() });
      failures.delete(key);
      return result;
    }).catch(error => {
      const sanitized = error instanceof OptionPriceHistoryError ? error : new OptionPriceHistoryError("unavailable");
      for (const [entry, failed] of failures) if (failed.until <= current) failures.delete(entry);
      if (failures.size >= MAX_CACHE_KEYS) failures.delete(failures.keys().next().value!);
      failures.set(key, { until: now().getTime() + 30_000, error: sanitized });
      throw sanitized;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return work;
  } };
}
