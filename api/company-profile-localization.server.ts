import type { CompanyProfile, Instrument, ProviderRequestContext } from "@/app/platform/provider-contracts";
import {
  extractTradingViewJapaneseProfile, japaneseText, record, tradingViewProfileListing,
  type JapaneseCompanyProfileText,
} from "./tradingview/japanese-profile.server";

type ProfileFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type JapaneseCompanyProfileOptions = Readonly<{
  fetch?: ProfileFetch;
  now?: () => Date;
  /** Combined deadline for all optional localization sources. */
  timeoutMs?: number;
  cacheTtlMs?: number;
}>;
type CacheEntry = { value: JapaneseCompanyProfileText | null; expiresAt: number; generation: number };
function cacheState() {
  return { cache: new Map<string, CacheEntry>(), inFlight: new Map<string, Promise<JapaneseCompanyProfileText | null>>(), generation: 0 };
}
const productionState = cacheState();
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_IN_FLIGHT = 16;

/** Read a JSON object literal as data without evaluating the surrounding script. */
function assignedJson(html: string, assignment: string): unknown {
  const start = html.indexOf(assignment);
  if (start < 0) return null;
  const tail = html.slice(start + assignment.length);
  const opening = tail.search(/\S/);
  if (tail[opening] !== "{") return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = opening; index < tail.length; index += 1) {
    const char = tail[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try { return JSON.parse(tail.slice(opening, index + 1)); } catch { return null; }
    }
  }
  return null;
}

export function extractYahooJapanCompanyDescription(
  html: string, instrument: Instrument, observedAt: string,
): JapaneseCompanyProfileText | null {
  const url = `https://finance.yahoo.co.jp/quote/${instrument.symbol}/profile`;
  const state = assignedJson(html, "window.__PRELOADED_STATE__ = ");
  if (!record(state) || !record(state.pageInfo) || state.pageInfo.code !== instrument.symbol
    || state.pageInfo.currentPageLink !== url || !record(state.mainUsStocksPriceBoard)
    || state.mainUsStocksPriceBoard.code !== instrument.symbol || !record(state.mainUsStocksProfile)
    || !record(state.mainUsStocksProfile.section)) return null;
  const exchange = ({ XNAS: "NASDAQ", XNYS: "NYSE", XASE: "NYSE American", ARCX: "NYSE Arca", BATS: "CBOE" } as Record<string, string>)[instrument.exchangeMic];
  if (!exchange || state.mainUsStocksPriceBoard.label !== exchange) return null;
  const section = state.mainUsStocksProfile.section;
  if (section.title !== "特色" || !Array.isArray(section.items) || section.items.length > 10) return null;
  const parts = section.items.map(item => record(item) ? japaneseText(item.text) : undefined);
  if (!parts.length || parts.some(item => !item)) return null;
  const description = japaneseText(parts.join(" "));
  if (!description) return null;
  const provenance = {
    providerId: "yahoo-japan", sourceId: `yahoo-japan:company-profile:${instrument.symbol}:ja`,
    sourceUrl: url, asOf: observedAt, ingestedAt: observedAt,
  };
  return { description, provenance, descriptionProvenance: provenance };
}

async function limitedHtml(response: Response): Promise<string> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/html")) throw new Error("Unavailable profile page");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return html + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Profile page exceeds size limit");
      html += decoder.decode(next.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(value, maximum)) : fallback;
}

/** Optional Japanese text augments the configured profile without replacing its numbers or English original. */
export function createJapaneseCompanyProfileEnricher(options: JapaneseCompanyProfileOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  const timeoutMs = bounded(options.timeoutMs, 4_000, 5_000);
  const cacheTtlMs = bounded(options.cacheTtlMs, 24 * 3_600_000, 24 * 3_600_000);
  const state = Object.keys(options).length ? cacheState() : productionState;

  async function load(instrument: Instrument, listing: { symbol: string; url: string }) {
    const controller = new AbortController();
    let tradingView: JapaneseCompanyProfileText | null = null;
    let yahooJapan: JapaneseCompanyProfileText | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    });
    async function page(url: string) {
      // Fixed public hosts only; a redirect must not change listing or destination.
      const response = await fetcher(url, { headers: { Accept: "text/html", "Accept-Language": "ja" }, signal: controller.signal, redirect: "manual" });
      if (response.url && response.url !== url) throw new Error("Unexpected profile listing");
      return limitedHtml(response);
    }
    // Start both independent sources so a slow Market data provider page cannot prevent
    // Japanese descriptions available from Yahoo Japan from being displayed.
    const task = Promise.allSettled([
      page(listing.url).then(html => { tradingView = extractTradingViewJapaneseProfile(html, listing, now().toISOString()); }),
      page(`https://finance.yahoo.co.jp/quote/${instrument.symbol}/profile`).then(html => {
        yahooJapan = extractYahooJapanCompanyDescription(html, instrument, now().toISOString());
      }),
    ]);
    try {
      await Promise.race([task, deadline]);
      const primary = tradingView as JapaneseCompanyProfileText | null;
      const fallback = yahooJapan as JapaneseCompanyProfileText | null;
      if (primary?.description || !fallback?.description) return primary;
      return { ...primary, ...fallback, provenance: primary?.provenance ?? fallback.provenance };
    }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  return async (profile: CompanyProfile | null, instrument: Instrument, context: ProviderRequestContext): Promise<CompanyProfile | null> => {
    if (!profile || context.signal?.aborted) return profile;
    const listing = tradingViewProfileListing(instrument);
    if (!listing) return profile;
    const cached = state.cache.get(listing.symbol);
    let japanese = !context.fresh && cached && cached.expiresAt > now().getTime() ? cached.value : undefined;
    if (japanese === undefined) {
      const key = `${listing.symbol}:${context.fresh ? "fresh" : "normal"}`;
      let pending = state.inFlight.get(`${listing.symbol}:fresh`) ?? state.inFlight.get(key);
      if (!pending) {
        if (state.inFlight.size >= MAX_IN_FLIGHT) return profile;
        const generation = ++state.generation;
        pending = load(instrument, listing).then(value => {
          if (generation >= (state.cache.get(listing.symbol)?.generation ?? 0)) {
            state.cache.delete(listing.symbol);
            while (state.cache.size >= MAX_CACHE_ENTRIES) state.cache.delete(state.cache.keys().next().value!);
            state.cache.set(listing.symbol, { value, generation, expiresAt: now().getTime() + (value?.description ? cacheTtlMs : Math.min(cacheTtlMs, 60_000)) });
          }
          return value;
        }).finally(() => state.inFlight.delete(key));
        state.inFlight.set(key, pending);
      }
      japanese = await pending;
    }
    return japanese && !context.signal?.aborted ? { ...profile, localized: { ...profile.localized, ja: japanese } } : profile;
  };
}
