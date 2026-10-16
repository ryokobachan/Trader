import type { OptionContractQuote, OptionsChainSnapshot } from "../../src/app/platform/options-contracts";

type JsonRecord = Record<string, unknown>;
type OptionsRequest = Readonly<{ symbol: string; expiration?: string; range?: "near" | "all" }>;
type ClientOptions = Readonly<{ fetch?: typeof fetch; now?: () => Date; timeoutMs?: number; cacheTtlMs?: number }>;
const MAX_ROWS = 500;
const MAX_PAGES = 4;
const MAX_CHAIN_ROWS = MAX_ROWS * MAX_PAGES;
const MAX_BYTES = 2_000_000;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export class OptionsDataError extends Error {
  constructor(readonly code: "invalid_request" | "unavailable" | "invalid_response" | "timeout" | "capacity") {
    super(`Options data ${code.replaceAll("_", " ")}.`);
    this.name = "OptionsDataError";
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function numeric(value: unknown, signed = false, integer = false): number | undefined {
  const cleaned = typeof value === "string" ? value.trim().replaceAll(",", "").replace(/^\$/, "") : value;
  if (typeof cleaned !== "number" && (typeof cleaned !== "string" || !/^[+-]?\d+(?:\.\d+)?$/.test(cleaned))) return undefined;
  const result = Number(cleaned);
  return Number.isFinite(result) && (signed || result >= 0) && (!integer || Number.isSafeInteger(result)) ? result : undefined;
}

export function validOptionsDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function sourceDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^([a-z]{3})[a-z]* (\d{1,2}), (\d{4})$/i);
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1].toUpperCase()) + 1;
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return validOptionsDate(date) ? date : undefined;
}

function contractIdentity(value: unknown, expectedSymbol: string) {
  // Nasdaq encodes a six-character option root with hyphen padding (MU----,
  // NBIS--). The padding is part of that field, not a fixed "--" separator.
  const root = expectedSymbol.toLowerCase().padEnd(6, "-");
  const prefix = `/market-activity/stocks/${expectedSymbol.toLowerCase()}/option-chain/call-put-options/${root}`;
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  const match = value.slice(prefix.length).match(/^(\d{2})(\d{2})(\d{2})([cp])(\d{8})$/i);
  if (!match) return undefined;
  const expiration = `20${match[1]}-${match[2]}-${match[3]}`;
  if (!validOptionsDate(expiration)) return undefined;
  return { expiration, side: match[4].toLowerCase() as "c" | "p", strike: Number(match[5]) / 1_000, root: `${expectedSymbol}${match[1]}${match[2]}${match[3]}`, strikeCode: match[5] };
}

function dataTable(payload: unknown, maxRows = MAX_ROWS + 100) {
  const root = record(payload);
  const status = record(root?.status);
  const data = record(root?.data);
  const table = record(data?.table);
  if (!root || (status?.rCode !== undefined && status.rCode !== 200)) throw new OptionsDataError("unavailable");
  if (!data || !table || !Array.isArray(table.rows) || table.rows.length > maxRows) throw new OptionsDataError("invalid_response");
  return { data, table, rows: table.rows as unknown[] };
}

function greekContracts(payload: unknown, symbol: string) {
  const { data, rows } = dataTable(payload);
  const values = new Map<string, Partial<OptionContractQuote>>();
  const expirations = Array.isArray(data.filters) ? data.filters.flatMap(raw => {
    const value = record(raw)?.value;
    return typeof value === "string" && validOptionsDate(value) ? [value] : [];
  }).slice(0, 64) : [];
  for (const raw of rows) {
    const row = record(raw);
    const id = contractIdentity(row?.url, symbol);
    // Nasdaq's put-only rows duplicate put data under c-prefixed fields.
    // Only the paired call row has unambiguous call/put column assignments.
    if (!row || !id || id.side !== "c" || numeric(row.strike) !== id.strike) continue;
    for (const side of ["c", "p"] as const) {
      if (["Delta", "Gamma", "Theta", "Vega", "Rho"].every(field => numeric(row[`${side}${field}`], true) === 0)) continue;
      const delta = numeric(row[`${side}Delta`], true);
      if (delta === undefined || (side === "c" ? delta < 0 || delta > 1 : delta < -1 || delta > 0)) continue;
      values.set(`${id.root}${side.toUpperCase()}${id.strikeCode}`, {
        delta, gamma: numeric(row[`${side}Gamma`]), theta: numeric(row[`${side}Theta`], true),
        vega: numeric(row[`${side}Vega`]), rho: numeric(row[`${side}Rho`], true),
      });
    }
  }
  return { values, expirations };
}

export function parseNasdaqOptions(payload: unknown, request: OptionsRequest, fetchedAt: string, greeksPayload?: unknown): OptionsChainSnapshot {
  const symbol = request.symbol;
  const { data, table, rows } = dataTable(payload, MAX_CHAIN_ROWS);
  const contracts: OptionContractQuote[] = [];
  const seen = new Set<string>();
  let groupDate: string | undefined;
  let greekValues = new Map<string, Partial<OptionContractQuote>>();
  let greekExpirations: string[] = [];
  if (greeksPayload) {
    try { const parsed = greekContracts(greeksPayload, symbol); greekValues = parsed.values; greekExpirations = parsed.expirations; } catch { /* Prices remain useful when the independent Greek source is unavailable. */ }
  }
  for (const raw of rows) {
    const row = record(raw);
    if (!row) throw new OptionsDataError("invalid_response");
    if (row.expirygroup) {
      groupDate = sourceDate(row.expirygroup);
      if (!groupDate || (request.expiration && groupDate !== request.expiration)) throw new OptionsDataError("invalid_response");
      continue;
    }
    const strike = numeric(row.strike);
    const id = contractIdentity(row.drillDownURL, symbol);
    if (strike === undefined || !id || strike !== id.strike || (groupDate && id.expiration !== groupDate)) throw new OptionsDataError("invalid_response");
    if (request.expiration && id.expiration !== request.expiration) throw new OptionsDataError("invalid_response");
    for (const side of ["c", "p"] as const) {
      const contractId = `${id.root}${side.toUpperCase()}${id.strikeCode}`;
      if (seen.has(contractId)) throw new OptionsDataError("invalid_response");
      seen.add(contractId);
      contracts.push({
        contractId, side: side === "c" ? "call" : "put", expiration: id.expiration, strike,
        last: numeric(row[`${side}_Last`]), bid: numeric(row[`${side}_Bid`]), ask: numeric(row[`${side}_Ask`]),
        change: numeric(row[`${side}_Change`], true), volume: numeric(row[`${side}_Volume`], false, true),
        openInterest: numeric(row[`${side}_Openinterest`], false, true), ...greekValues.get(contractId),
      });
    }
  }
  const availableExpirations = [...new Set([...contracts.map(item => item.expiration), ...greekExpirations])].sort().slice(0, 64);
  const expiration = request.expiration ?? contracts.map(item => item.expiration).sort()[0] ?? null;
  const lastTrade = typeof data.lastTrade === "string" ? data.lastTrade : "";
  const priceMatch = lastTrade.match(/LAST TRADE:\s*\$([\d,.]+)/i);
  const dateMatch = lastTrade.match(/AS OF ([^)]+)/i);
  const selected = contracts.filter(item => item.expiration === expiration).sort((a, b) => a.strike - b.strike || a.side.localeCompare(b.side));
  const quoteAsOf = typeof table.asOf === "string" && table.asOf.length <= 150 ? table.asOf : undefined;
  const totalRows = numeric(data.totalRecord, false, true);
  if (totalRows !== undefined && totalRows < rows.length) throw new OptionsDataError("invalid_response");
  const sourceComplete = totalRows !== undefined && totalRows === rows.length;
  const selectedRows = rows.filter(raw => {
    const row = record(raw);
    return row?.expirygroup ? sourceDate(row.expirygroup) === expiration : contractIdentity(row?.drillDownURL, symbol)?.expiration === expiration;
  }).length;
  // With an unfiltered source, a subsequent expiration heading closes the
  // selected group. Unretrieved later expirations do not truncate this one.
  const headings = rows.flatMap(raw => { const date = sourceDate(record(raw)?.expirygroup); return date ? [date] : []; });
  const selectedHeading = expiration ? headings.indexOf(expiration) : -1;
  const groupComplete = selectedHeading >= 0 && selectedHeading < headings.length - 1;
  const complete = sourceComplete || (!request.expiration && groupComplete);
  const sourceTotalRows = request.expiration ? totalRows : complete ? selectedRows : undefined;
  const strikes = [...new Set(selected.map(item => item.strike))];
  return {
    symbol, currency: "USD", expiration, expirations: availableExpirations, range: request.range ?? "near", contracts: selected,
    source: "Nasdaq", sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/option-chain`,
    greeksSourceUrl: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/option-chain/greeks`,
    fetchedAt, ...(quoteAsOf ? { optionQuoteAsOf: quoteAsOf } : {}),
    underlyingPrice: numeric(priceMatch?.[1]), underlyingAsOf: sourceDate(dateMatch?.[1]),
    truncated: !complete,
    coverage: { strikeMin: strikes[0], strikeMax: strikes.at(-1), strikeCount: strikes.length, contractCount: selected.length,
      fetchedRows: selectedRows, ...(sourceTotalRows !== undefined ? { sourceTotalRows } : {}), complete },
    greeksAvailable: selected.some(item => item.delta !== undefined), impliedVolatilityAvailable: false,
  };
}

export function createNasdaqOptionsClient(options: ClientOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 10_000, 20_000));
  const ttl = Math.max(1, Math.min(options.cacheTtlMs ?? 300_000, 900_000));
  const cache = new Map<string, { result: OptionsChainSnapshot; savedAt: number }>();
  const failedUntil = new Map<string, number>();
  const inFlight = new Map<string, Promise<OptionsChainSnapshot>>();

  async function fetchJson(url: URL, signal: AbortSignal) {
    try {
      if (signal.aborted) throw new OptionsDataError("timeout");
      const response = await fetcher(url, { signal, headers: { Accept: "application/json", "User-Agent": "Trader/0.1 local research" } });
      if (!response.ok) throw new OptionsDataError("unavailable");
      if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new OptionsDataError("invalid_response");
      const reader = response.body?.getReader();
      if (!reader) throw new OptionsDataError("invalid_response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BYTES) { await reader.cancel(); throw new OptionsDataError("invalid_response"); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
      if (error instanceof OptionsDataError) throw error;
      throw new OptionsDataError(signal.aborted ? "timeout" : "unavailable");
    }
  }

  function chainUrl(request: OptionsRequest, limit = MAX_ROWS, offset = 0) {
    const url = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(request.symbol)}/option-chain`);
    url.search = new URLSearchParams({ assetclass: "stocks", limit: String(limit), money: request.range === "all" ? "all" : "at",
      ...(request.expiration ? { fromdate: request.expiration, todate: request.expiration } : {}), ...(offset ? { offset: String(offset) } : {}) }).toString();
    return url;
  }

  async function loadChain(request: OptionsRequest): Promise<OptionsChainSnapshot> {
    // Discovery, all price pages and the independent Greeks request share one
    // deadline. Pagination cannot multiply the configured request timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let selected = request;
      if (!selected.expiration) {
        // Nasdaq defaults to an entire month. Discover the first expiration
        // cheaply, then fetch that date alone so its count and coverage agree.
        const discovery = await fetchJson(chainUrl(request, 2), controller.signal);
        const first = parseNasdaqOptions(discovery, request, now().toISOString());
        if (!first.expiration) {
          if (numeric(dataTable(discovery).data.totalRecord, false, true) !== 0) throw new OptionsDataError("invalid_response");
          return first;
        }
        selected = { ...request, expiration: first.expiration };
      }
      const greeksUrl = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(selected.symbol)}/option-chain/greeks`);
      greeksUrl.search = new URLSearchParams({ assetclass: "stocks", date: selected.expiration! }).toString();
      // Attach the rejection handler immediately; a price failure still leaves
      // the independent Greek request safe to abort in finally.
      const greekData = fetchJson(greeksUrl, controller.signal).catch(() => undefined);
      const firstPayload = await fetchJson(chainUrl(selected), controller.signal);
      const first = dataTable(firstPayload, MAX_ROWS);
      parseNasdaqOptions(firstPayload, selected, now().toISOString());
      const rows = [...first.rows];
      const sourceTotal = numeric(first.data.totalRecord, false, true);
      for (let page = 1; page < MAX_PAGES && rows.length < (sourceTotal ?? Infinity) && rows.length >= page * MAX_ROWS; page++) {
        let nextPayload: unknown;
        try { nextPayload = await fetchJson(chainUrl(selected, MAX_ROWS, rows.length), controller.signal); }
        catch (error) {
          // Verified earlier pages remain useful during a transient failure;
          // their coverage stays incomplete. Invalid data is never accepted.
          if (error instanceof OptionsDataError && error.code === "invalid_response") throw error;
          break;
        }
        const next = dataTable(nextPayload, MAX_ROWS);
        parseNasdaqOptions(nextPayload, selected, now().toISOString());
        if (numeric(next.data.totalRecord, false, true) !== sourceTotal) throw new OptionsDataError("invalid_response");
        if (!next.rows.length) break;
        rows.push(...next.rows);
      }
      const combined = { ...record(firstPayload), data: { ...first.data, table: { ...first.table, rows } } };
      return parseNasdaqOptions(combined, selected, now().toISOString(), await greekData);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return { getOptions: async (request: OptionsRequest): Promise<OptionsChainSnapshot> => {
    const symbol = request.symbol.normalize("NFKC").trim().toUpperCase();
    if (!SYMBOL.test(symbol) || (request.expiration && !validOptionsDate(request.expiration)) || (request.range && request.range !== "near" && request.range !== "all")) throw new OptionsDataError("invalid_request");
    const normalized = { ...request, symbol, range: request.range ?? "all" as const };
    const key = `${symbol}:${request.expiration ?? "default"}:${normalized.range}`;
    const current = now().getTime();
    const saved = cache.get(key);
    if (saved && current - saved.savedAt < ttl) return saved.result;
    if ((failedUntil.get(key) ?? 0) > current) {
      if (saved && current - saved.savedAt < 86_400_000) return { ...saved.result, isStale: true };
      throw new OptionsDataError("unavailable");
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    if (inFlight.size >= 8) throw new OptionsDataError("capacity");
    const work = (async () => {
      const result = await loadChain(normalized);
      cache.delete(key);
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(key, { result, savedAt: now().getTime() });
      failedUntil.delete(key);
      return result;
    })().catch(error => {
      for (const [entry, until] of failedUntil) if (until <= current) failedUntil.delete(entry);
      if (failedUntil.size >= 64) failedUntil.delete(failedUntil.keys().next().value!);
      failedUntil.set(key, now().getTime() + 30_000);
      if (saved && current - saved.savedAt < 86_400_000) return { ...saved.result, isStale: true };
      throw error;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return work;
  } };
}
