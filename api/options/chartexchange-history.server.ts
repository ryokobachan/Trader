import {
  OptionPriceHistoryError,
  optionPriceHistoryIdentity,
  type OptionPriceHistoryBar,
  type OptionPriceHistoryRequest,
  type OptionsPriceHistory,
} from "./price-history.server";

const MAX_BYTES = 2_000_000;
const MAX_ROWS = 5_000;
const MAX_KEYS = 64;
const FIELDS = ["open", "high", "low", "close", "volume", "openInterest"] as const;
const HEADER = ["Open", "High", "Low", "Close", "Change", "Volume", "Open Interest", "Change Since"];
const invalid = () => new OptionPriceHistoryError("invalid_response");
const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

function newYorkDate(time: number) {
  const parts = formatter.formatToParts(new Date(time));
  const part = (name: string) => parts.find(item => item.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function sourceUrl(request: OptionPriceHistoryRequest) {
  const identity = optionPriceHistoryIdentity(request);
  // Keep punctuation in the root. Removing '.' or '-' could select a different
  // underlying. Decimal strikes in the public contract URLs use a literal '.'.
  const mills = Number(identity.contractId.slice(-8));
  const fraction = String(mills % 1_000).padStart(3, "0").replace(/0+$/, "");
  const strike = `${Math.floor(mills / 1_000)}${fraction ? `.${fraction}` : ""}`;
  const slug = `${identity.symbol.toLowerCase()}${identity.expiration.replaceAll("-", "")}${identity.side === "call" ? "c" : "p"}${strike}`;
  return `https://chartexchange.com/symbol/opra-${encodeURIComponent(slug)}/historical/`;
}

function decodeEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", minus: "−" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole: string, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw invalid();
    return String.fromCodePoint(code);
  });
}

function plainText(html: string) {
  return decodeEntities(html.replace(/<br\b[^>]*>|<\/(?:div|p)\s*>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ").trim();
}

function attributes(tag: string) {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    const name = match[1].toLowerCase();
    if (name in result) throw invalid();
    result[name] = decodeEntities(match[3]);
  }
  return result;
}

function numeric(text: string, integer: boolean) {
  if (["", "-", "–", "—", "N/A"].includes(text)) return undefined;
  // No coercion of suffixes, broken comma groupings, signs, or arbitrary text.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) throw invalid();
  const value = Number(text.replaceAll(",", ""));
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw invalid();
  return value;
}

/** Parse only the anonymous historical table, never a chart's hidden payload. */
export function parseChartExchangeOptionHistory(html: string, request: OptionPriceHistoryRequest, fetchedAt: string): OptionsPriceHistory {
  const identity = optionPriceHistoryIdentity(request);
  const fetchedTime = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedTime)) throw new OptionPriceHistoryError("invalid_request");
  if (typeof html !== "string" || html.length > MAX_BYTES || new TextEncoder().encode(html).byteLength > MAX_BYTES) throw invalid();
  const visible = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const expectedUrl = sourceUrl(identity);
  const canonical = [...visible.matchAll(/<link\b[^>]*>/gi)].map(match => attributes(match[0])).filter(link => link.rel?.toLowerCase().split(/\s+/).includes("canonical"));
  if (canonical.length !== 1 || canonical[0].href !== expectedUrl) throw invalid();
  const headings = [...visible.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)];
  if (headings.length !== 1) throw invalid();
  const heading = plainText(headings[0][1]);
  const contracts = [...heading.matchAll(/\(([^()]+)\)/g)].map(match => match[1]);
  if (contracts.length !== 1 || contracts[0] !== identity.contractId || !/\boption\s+OPRA\b/.test(heading)) throw invalid();

  const tables = [...visible.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)];
  const candidates: string[][][] = [];
  for (const table of tables) {
    if (/<table\b/i.test(table[1])) throw invalid();
    const rowMatches = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
    if ((table[1].match(/<tr\b/gi)?.length ?? 0) !== rowMatches.length || (table[1].match(/<\/tr\s*>/gi)?.length ?? 0) !== rowMatches.length) throw invalid();
    const rows = rowMatches.map(row => {
      const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)];
      if ((row[1].match(/<t[dh]\b/gi)?.length ?? 0) !== cells.length || (row[1].match(/<\/t[dh]\s*>/gi)?.length ?? 0) !== cells.length || /<t[dh]\b[^>]*\b(?:rowspan|colspan)\s*=/i.test(row[1])) throw invalid();
      return cells.map(cell => plainText(cell[1]));
    });
    const header = rows[0];
    if (header?.length === 9 && /^Date \((?:EDT|EST)\)$/.test(header[0]) && HEADER.every((label, index) => header[index + 1] === label)) candidates.push(rows.slice(1));
  }
  if (candidates.length !== 1) throw invalid();
  const rows = candidates[0];
  if (rows.length > MAX_ROWS) throw invalid();
  if (rows.length === 0) throw new OptionPriceHistoryError("not_found");
  const to = newYorkDate(fetchedTime);
  let previousDate: string | undefined;
  let missingBars = 0;
  const items: OptionPriceHistoryBar[] = rows.map(cells => {
    if (cells.length !== 9) throw invalid();
    const date = cells[0];
    if (!validDate(date) || date > to || date > identity.expiration || (previousDate !== undefined && date >= previousDate)) throw invalid();
    previousDate = date;
    const bar: { date: string } & Partial<Record<typeof FIELDS[number], number>> = { date };
    for (const [index, field] of FIELDS.entries()) {
      const value = numeric(cells[index < 4 ? index + 1 : index + 2], index >= 4);
      if (value !== undefined) bar[field] = value;
    }
    if ((bar.high !== undefined && bar.low !== undefined && bar.high < bar.low)
      || [bar.open, bar.close].some(value => value !== undefined && ((bar.high !== undefined && value > bar.high) || (bar.low !== undefined && value < bar.low)))) throw invalid();
    if (FIELDS.every(field => bar[field] === undefined)) missingBars++;
    return bar;
  }).reverse();
  return {
    ...identity, underlying: { symbol: identity.symbol }, source: "ChartExchange", sourceUrl: expectedUrl,
    fetchedAt, sourceAsOf: null, currency: "USD", timezone: "America/New_York", interval: "1d", requestedRange: "available",
    priceAdjustment: "source_ohlc", adjustedCloseUsed: false, openInterestDateBasis: "source_session_date_unverified",
    items, coverage: { from: items[0].date, to, firstDate: items[0].date, lastDate: items.at(-1)!.date, missingBars, sourceRows: rows.length, returnedBars: items.length, observedBars: items.length - missingBars },
  };
}

type ClientOptions = Readonly<{ fetch?: typeof fetch; now?: () => Date; timeoutMs?: number; cacheTtlMs?: number }>;

export function createChartExchangeOptionHistoryClient(options: ClientOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const boundedMs = (value: number | undefined, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(value, max)) : max;
  const timeout = boundedMs(options.timeoutMs, 10_000);
  const ttl = boundedMs(options.cacheTtlMs, 300_000);
  const cache = new Map<string, { result: OptionsPriceHistory; savedAt: number }>();
  const inFlight = new Map<string, Promise<OptionsPriceHistory>>();
  const failures = new Map<string, { until: number; error: OptionPriceHistoryError }>();

  async function fetchHtml(url: string, signal: AbortSignal) {
    // Cloudflare's fetch does not support redirect: "error". Manual mode keeps
    // redirects (including login pages) visible so they can be rejected below.
    const response = await fetcher(url, { signal, redirect: "manual", headers: { Accept: "text/html", "User-Agent": "Trader/0.1 local research" } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OptionPriceHistoryError(response.status === 404 ? "not_found" : "unavailable");
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES || !/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      throw invalid();
    }
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    const abortReader = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abortReader, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (signal.aborted) throw new OptionPriceHistoryError("timeout");
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw invalid(); }
        chunks.push(next.value);
      }
    } finally { signal.removeEventListener("abort", abortReader); reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw invalid(); }
  }

  async function load(request: OptionPriceHistoryRequest) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new OptionPriceHistoryError("timeout")); }, timeout);
    });
    try {
      // One ordinary page request; never rotate hosts or retry access restrictions.
      return await Promise.race([
        fetchHtml(sourceUrl(request), controller.signal).then(html => {
          if (controller.signal.aborted) throw new OptionPriceHistoryError("timeout");
          return parseChartExchangeOptionHistory(html, request, now().toISOString());
        }),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof OptionPriceHistoryError) throw error;
      throw new OptionPriceHistoryError(controller.signal.aborted ? "timeout" : "unavailable");
    } finally { clearTimeout(timer); controller.abort(); }
  }

  return { getHistory: async (request: OptionPriceHistoryRequest): Promise<OptionsPriceHistory> => {
    const normalized = optionPriceHistoryIdentity(request);
    const key = normalized.contractId;
    const current = now().getTime();
    const saved = cache.get(key);
    if (saved && current - saved.savedAt >= 0 && current - saved.savedAt < ttl) return saved.result;
    const failure = failures.get(key);
    if (failure && failure.until > current) throw failure.error;
    const pending = inFlight.get(key);
    if (pending) return pending;
    if (inFlight.size >= 8) throw new OptionPriceHistoryError("capacity");
    const work = load(normalized).then(result => {
      cache.delete(key);
      if (cache.size >= MAX_KEYS) cache.delete(cache.keys().next().value!);
      cache.set(key, { result, savedAt: now().getTime() });
      failures.delete(key);
      return result;
    }).catch(error => {
      const sanitized = error instanceof OptionPriceHistoryError ? error : new OptionPriceHistoryError("unavailable");
      for (const [entry, failed] of failures) if (failed.until <= current) failures.delete(entry);
      if (failures.size >= MAX_KEYS) failures.delete(failures.keys().next().value!);
      failures.set(key, { until: now().getTime() + 30_000, error: sanitized });
      throw sanitized;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return work;
  } };
}
