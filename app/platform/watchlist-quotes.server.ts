import type {
  ProviderRequestContext,
  Quote,
  WatchlistQuoteItem,
} from "./provider-contracts";
import type { ProviderRuntime } from "../plugins/providers/index.server";

const DEFAULT_CONCURRENCY = 6;

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
  runtime: Pick<ProviderRuntime, "instrument" | "market">,
  context: ProviderRequestContext,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<readonly WatchlistQuoteItem[]> {
  const items = new Array<WatchlistQuoteItem>(symbols.length);
  let nextIndex = 0;
  const workerCount = Math.min(
    symbols.length,
    Math.max(1, Math.trunc(Number.isFinite(concurrency) ? concurrency : DEFAULT_CONCURRENCY)),
  );

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < symbols.length) {
      const index = nextIndex;
      nextIndex += 1;
      const symbol = symbols[index]!;
      try {
        const instrument = await runtime.instrument.getUSStockBySymbol(symbol, context);
        if (!instrument) {
          items[index] = Object.freeze({ symbol, instrument: null, quote: null });
          continue;
        }
        const candidate = await runtime.market.getQuote(instrument, context);
        const quote = isUsableCurrentQuote(candidate)
          && candidate.instrumentId === instrument.instrumentId
          ? candidate
          : null;
        items[index] = Object.freeze({ symbol, instrument, quote });
      } catch {
        // One missing or temporarily unavailable ticker must not blank the
        // entire watchlist. Keep absence explicit and let a later poll retry.
        items[index] = Object.freeze({ symbol, instrument: null, quote: null });
      }
    }
  }));

  return Object.freeze(items);
}
