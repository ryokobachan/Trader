import {
  WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION,
  type Quote,
  type WatchlistQuoteStreamMessage,
} from "../../platform/provider-contracts";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseWatchlistQuoteStreamMessage(
  payload: string,
): WatchlistQuoteStreamMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  const root = record(value);
  const quote = record(root?.quote);
  const provenance = record(quote?.provenance);
  if (
    root?.schemaVersion !== WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION
    || root.type !== "quote"
    || typeof root.symbol !== "string"
    || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(root.symbol)
    || !quote
    || typeof quote.instrumentId !== "string"
    || !finite(quote.price)
    || quote.price <= 0
    || !finite(quote.change)
    || !finite(quote.changePercent)
    || !finite(quote.previousClose)
    || quote.previousClose <= 0
    || !finite(quote.open)
    || quote.open <= 0
    || !finite(quote.high)
    || quote.high <= 0
    || !finite(quote.low)
    || quote.low <= 0
    || !finite(quote.volume)
    || quote.volume < 0
    || quote.currency !== "USD"
    || !finite(quote.delaySeconds)
    || quote.delaySeconds < 0
    || !["pre_market", "regular", "after_hours", "closed"].includes(String(quote.marketState))
    || !provenance
    || typeof provenance.providerId !== "string"
    || typeof provenance.sourceId !== "string"
    || typeof provenance.asOf !== "string"
    || !Number.isFinite(Date.parse(provenance.asOf))
    || typeof provenance.ingestedAt !== "string"
    || !Number.isFinite(Date.parse(provenance.ingestedAt))
  ) return null;

  return value as WatchlistQuoteStreamMessage;
}

export function isNewerWatchlistQuote(
  quote: Quote,
  previousAsOf: string | undefined,
): boolean {
  const nextTime = Date.parse(quote.provenance.asOf);
  const previousTime = previousAsOf ? Date.parse(previousAsOf) : -Infinity;
  return Number.isFinite(nextTime)
    && (!Number.isFinite(previousTime) || nextTime >= previousTime);
}
