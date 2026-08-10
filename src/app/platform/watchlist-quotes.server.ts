import type {
  Instrument,
  ProviderRequestContext,
  Quote,
  WatchlistQuoteItem,
} from "./provider-contracts";
import type { ProviderRuntime } from "@api/index.server";

const DEFAULT_CONCURRENCY = 6;
const IDENTITY_CACHE_TTL_MS = 6 * 60 * 60_000;
const MISSING_IDENTITY_CACHE_TTL_MS = 5 * 60_000;
const IDENTITY_CACHE_MAX_ENTRIES = 1_000;
const QUOTE_BATCH_CACHE_TTL_MS = 10_000;
const QUOTE_BATCH_CACHE_MAX_ENTRIES = 200;

type WatchlistQuoteRuntime = Pick<ProviderRuntime, "instrument" | "market">
  & Partial<Pick<ProviderRuntime, "selectedProviderIds">>;
type WatchlistIdentityRuntime = Pick<ProviderRuntime, "instrument">
  & Partial<Pick<ProviderRuntime, "selectedProviderIds">>;

type IdentityCacheEntry = Readonly<{
  expiresAt: number;
  value: Instrument | null;
}>;

const identityCache = new Map<string, IdentityCacheEntry>();
const identityRequests = new Map<string, Promise<Instrument | null>>();
const quoteBatchCache = new Map<string, Readonly<{
  expiresAt: number;
  values: readonly Quote[];
}>>();
const quoteBatchRequests = new Map<string, Promise<readonly Quote[]>>();

function pruneIdentityCache(now: number) {
  for (const [key, entry] of identityCache) {
    if (entry.expiresAt <= now) identityCache.delete(key);
  }
  while (identityCache.size > IDENTITY_CACHE_MAX_ENTRIES) {
    const oldestKey = identityCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    identityCache.delete(oldestKey);
  }
}

async function loadInstrument(
  symbol: string,
  runtime: WatchlistIdentityRuntime,
  context: ProviderRequestContext,
): Promise<Instrument | null> {
  const providerId = runtime.selectedProviderIds?.instrument;
  if (!providerId) return runtime.instrument.getUSStockBySymbol(symbol, context);

  const key = `${providerId}:${symbol}`;
  const now = Date.now();
  const cached = identityCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  identityCache.delete(key);

  const pending = identityRequests.get(key);
  if (pending) return pending;

  const request = runtime.instrument.getUSStockBySymbol(symbol, context)
    .then((value) => {
      pruneIdentityCache(Date.now());
      identityCache.set(key, Object.freeze({
        value,
        expiresAt: Date.now() + (value ? IDENTITY_CACHE_TTL_MS : MISSING_IDENTITY_CACHE_TTL_MS),
      }));
      return value;
    })
    .finally(() => identityRequests.delete(key));
  identityRequests.set(key, request);
  return request;
}

export async function loadWatchlistInstruments(
  symbols: readonly string[],
  runtime: WatchlistIdentityRuntime,
  context: ProviderRequestContext,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<readonly (Instrument | null)[]> {
  const instruments = new Array<Instrument | null>(symbols.length).fill(null);
  let nextIndex = 0;
  const workerCount = Math.min(
    symbols.length,
    Math.max(1, Math.trunc(Number.isFinite(concurrency) ? concurrency : DEFAULT_CONCURRENCY)),
  );

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < symbols.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        instruments[index] = await loadInstrument(symbols[index]!, runtime, context);
      } catch {
        instruments[index] = null;
      }
    }
  }));

  return Object.freeze(instruments);
}

async function loadQuoteBatch(
  instruments: readonly Instrument[],
  runtime: WatchlistQuoteRuntime,
  context: ProviderRequestContext,
): Promise<readonly Quote[]> {
  if (!runtime.market.getQuotes) return [];
  const providerId = runtime.selectedProviderIds?.market;
  if (!providerId) return runtime.market.getQuotes(instruments, context);

  const key = `${providerId}:${instruments
    .map((instrument) => instrument.instrumentId)
    .sort()
    .join("\u0000")}`;
  const now = Date.now();
  const cached = quoteBatchCache.get(key);
  if (cached && cached.expiresAt > now) return cached.values;
  quoteBatchCache.delete(key);

  const pending = quoteBatchRequests.get(key);
  if (pending) return pending;

  const request = runtime.market.getQuotes(instruments, context)
    .then((values) => {
      for (const [cacheKey, entry] of quoteBatchCache) {
        if (entry.expiresAt <= Date.now()) quoteBatchCache.delete(cacheKey);
      }
      while (quoteBatchCache.size >= QUOTE_BATCH_CACHE_MAX_ENTRIES) {
        const oldestKey = quoteBatchCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        quoteBatchCache.delete(oldestKey);
      }
      const frozenValues = Object.freeze([...values]);
      quoteBatchCache.set(key, Object.freeze({
        expiresAt: Date.now() + QUOTE_BATCH_CACHE_TTL_MS,
        values: frozenValues,
      }));
      return frozenValues;
    })
    .finally(() => quoteBatchRequests.delete(key));
  quoteBatchRequests.set(key, request);
  return request;
}

/**
 * A missing current quote must stay missing at the Core/UI boundary. In
 * particular, zero is never a placeholder for a U.S. equity price.
 */
export function isUsableCurrentQuote(quote: Quote | null): quote is Quote {
  return quote !== null
    && Number.isFinite(quote.price)
    && quote.price > 0;
}

export async function loadWatchlistQuotes(
  symbols: readonly string[],
  runtime: WatchlistQuoteRuntime,
  context: ProviderRequestContext,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<readonly WatchlistQuoteItem[]> {
  const items = new Array<WatchlistQuoteItem>(symbols.length);
  const instruments = await loadWatchlistInstruments(symbols, runtime, context, concurrency);
  const workerCount = Math.min(
    symbols.length,
    Math.max(1, Math.trunc(Number.isFinite(concurrency) ? concurrency : DEFAULT_CONCURRENCY)),
  );
  for (let index = 0; index < symbols.length; index += 1) {
    if (!instruments[index]) {
      items[index] = Object.freeze({ symbol: symbols[index]!, instrument: null, quote: null });
    }
  }

  const resolvedInstruments = instruments.filter((value): value is Instrument => value !== null);
  if (runtime.market.getQuotes && resolvedInstruments.length > 0) {
    let quotesByInstrument = new Map<string, Quote>();
    try {
      const quotes = await loadQuoteBatch(resolvedInstruments, runtime, context);
      quotesByInstrument = new Map(
        quotes
          .filter(isUsableCurrentQuote)
          .map((value) => [value.instrumentId, value]),
      );
    } catch {
      // Keep all resolved identities visible and retry the batch on the next poll.
    }
    for (let index = 0; index < symbols.length; index += 1) {
      const instrument = instruments[index];
      if (!instrument) continue;
      const quote = quotesByInstrument.get(instrument.instrumentId) ?? null;
      items[index] = Object.freeze({ symbol: symbols[index]!, instrument, quote });
    }
    return Object.freeze(items);
  }

  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < symbols.length) {
      const index = nextIndex;
      nextIndex += 1;
      const instrument = instruments[index];
      if (!instrument) continue;
      try {
        const candidate = await runtime.market.getQuote(instrument, context);
        const quote = isUsableCurrentQuote(candidate)
          && candidate.instrumentId === instrument.instrumentId
          ? candidate
          : null;
        items[index] = Object.freeze({ symbol: symbols[index]!, instrument, quote });
      } catch {
        items[index] = Object.freeze({ symbol: symbols[index]!, instrument, quote: null });
      }
    }
  }));

  return Object.freeze(items);
}
