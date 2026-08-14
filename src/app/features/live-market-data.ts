import type {
  MarketBarInterval,
  Quote,
  SymbolWorkspace,
} from "../platform/provider-contracts";
import {
  MARKET_SESSION_OBSERVATION_MAX_AGE_MS,
  isNominalUsRegularSession,
  type MarketSessionObservation,
} from "./watchlist/after-hours-stream";

export const LIVE_INTRADAY_BARS_REFRESH_MS = 15_000;
export const LIVE_HOURLY_BARS_REFRESH_MS = 30_000;
export const LIVE_DAILY_BARS_REFRESH_MS = 60_000;
export const IDLE_MARKET_BARS_REFRESH_MS = 5 * 60_000;

/**
 * Keep every visible watchlist row ahead of a selected symbol that is no
 * longer in the list. The quote endpoint has a hard symbol limit, so putting
 * the detached selection first can otherwise evict the final visible row.
 */
export function prioritizedWatchlistQuoteSymbols(
  watchedSymbols: readonly string[],
  selectedSymbol: string,
  limit: number,
) {
  const normalizedLimit = Math.max(0, Math.trunc(Number.isFinite(limit) ? limit : 0));
  return Array.from(new Set([...watchedSymbols, selectedSymbol]))
    .slice(0, normalizedLimit);
}

/**
 * Request generations are advanced both when work starts and when a forced
 * refresh invalidates in-flight work. This keeps the race policy independent
 * from React state and easy to apply to both chart and daily series.
 */
export function advanceMarketDataRequestGeneration(current: number) {
  return current + 1;
}

export function isCurrentMarketDataRequestGeneration(
  requestGeneration: number,
  latestGeneration: number,
) {
  return requestGeneration === latestGeneration;
}

export function didMarketDataRequestStayInNominalSession(
  startedAt: Date,
  completedAt: Date,
) {
  if (
    !Number.isFinite(startedAt.getTime())
    || !Number.isFinite(completedAt.getTime())
  ) return false;
  return isNominalUsRegularSession(startedAt)
    === isNominalUsRegularSession(completedAt);
}

function hasFreshSessionObservation(
  observation: MarketSessionObservation | undefined,
  observedAt: Date,
) {
  if (!observation || !Number.isFinite(observedAt.getTime())) return false;
  const age = observedAt.getTime() - observation.observedAt;
  return age >= 0 && age <= MARKET_SESSION_OBSERVATION_MAX_AGE_MS;
}

/**
 * Poll the currently visible series at a cadence proportional to how quickly
 * its active candle can change. A fresh provider session prevents holidays and
 * early closes from being treated as an open market; the New York clock is the
 * bounded fallback when no fresh quote is available.
 */
export function marketBarsRefreshDelay(
  interval: MarketBarInterval,
  observation: MarketSessionObservation | undefined,
  observedAt = new Date(),
) {
  const nominalRegular = isNominalUsRegularSession(observedAt);
  const providerRegular = hasFreshSessionObservation(observation, observedAt)
    ? observation?.state === "regular"
    : nominalRegular;
  if (!nominalRegular || !providerRegular) return IDLE_MARKET_BARS_REFRESH_MS;
  if (interval === "1m" || interval === "5m" || interval === "15m") {
    return LIVE_INTRADAY_BARS_REFRESH_MS;
  }
  if (interval === "1h" || interval === "4h") return LIVE_HOURLY_BARS_REFRESH_MS;
  return LIVE_DAILY_BARS_REFRESH_MS;
}

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function isQuoteNewerThan(incoming: Quote, current: Quote) {
  const incomingAsOf = timestamp(incoming.provenance.asOf);
  const currentAsOf = timestamp(current.provenance.asOf);
  if (incomingAsOf !== currentAsOf) return incomingAsOf > currentAsOf;
  return timestamp(incoming.provenance.ingestedAt)
    >= timestamp(current.provenance.ingestedAt);
}

/** Preserve the full workspace snapshot while replacing only its live quote. */
export function mergeLiveQuoteIntoWorkspace(
  workspace: SymbolWorkspace,
  quote: Quote,
): SymbolWorkspace {
  if (
    workspace.instrument.instrumentId !== quote.instrumentId
    || !isQuoteNewerThan(quote, workspace.quote)
  ) return workspace;
  return Object.freeze({
    ...workspace,
    quote,
    asOf: quote.provenance.asOf,
  });
}
