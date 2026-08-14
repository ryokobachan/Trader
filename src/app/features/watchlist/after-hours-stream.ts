import {
  isFreshSyntheticLatestClose,
  SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS,
  WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
  type MarketSessionState,
  type SyntheticLatestClose,
  type WatchlistAfterHoursStreamMessage,
} from "../../platform/provider-contracts";

export {
  isFreshSyntheticLatestClose,
  SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS,
};

export const MARKET_SESSION_OBSERVATION_MAX_AGE_MS = 45_000;
export const MARKET_SESSION_OBSERVATION_COMMIT_MS = 30_000;

export type MarketSessionObservation = Readonly<{
  state: MarketSessionState;
  /** Provider ingestion time. The last-trade timestamp can predate a holiday. */
  observedAt: number;
}>;

type NewYorkTimeParts = Readonly<{
  year: number;
  month: number;
  day: number;
  weekday: string;
  minutes: number;
}>;

const NEW_YORK_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function newYorkTimeParts(value: Date): NewYorkTimeParts | null {
  if (!Number.isFinite(value.getTime())) return null;
  const values = Object.fromEntries(
    NEW_YORK_TIME_FORMAT.formatToParts(value).map((part) => [part.type, part.value]),
  );
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || !Number.isInteger(hour)
    || !Number.isInteger(minute)
    || typeof values.weekday !== "string"
  ) return null;
  return Object.freeze({
    year,
    month,
    day,
    weekday: values.weekday,
    minutes: hour * 60 + minute,
  });
}

export function isNominalUsRegularSession(observedAt: Date): boolean {
  const parts = newYorkTimeParts(observedAt);
  if (!parts || parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  return parts.minutes >= 9 * 60 + 30 && parts.minutes < 16 * 60;
}

export function shouldReplaceMarketSessionObservation(
  current: MarketSessionObservation | undefined,
  next: MarketSessionObservation,
): boolean {
  if (!Number.isFinite(next.observedAt)) return false;
  if (!current) return true;
  if (!Number.isFinite(current.observedAt) || next.observedAt <= current.observedAt) return false;
  if (current.state !== next.state) return true;
  const crossedNominalBoundary = isNominalUsRegularSession(new Date(current.observedAt))
    !== isNominalUsRegularSession(new Date(next.observedAt));
  return crossedNominalBoundary
    || next.observedAt - current.observedAt >= MARKET_SESSION_OBSERVATION_COMMIT_MS;
}

function newYorkLocalTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = targetAsUtc;
  // Fixed-point conversion avoids hard-coding EST/EDT and therefore remains
  // correct across both daylight-saving transitions.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = newYorkTimeParts(new Date(candidate));
    if (!rendered) return Number.NaN;
    const renderedAsUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      Math.floor(rendered.minutes / 60),
      rendered.minutes % 60,
    );
    candidate += targetAsUtc - renderedAsUtc;
  }
  return candidate;
}

/** Milliseconds until the next nominal 09:30 or 16:00 New York boundary. */
export function millisecondsUntilNextUsSessionBoundary(observedAt: Date): number {
  const observedAtMs = observedAt.getTime();
  const current = newYorkTimeParts(observedAt);
  if (!Number.isFinite(observedAtMs) || !current) return 60_000;

  const localDate = new Date(Date.UTC(current.year, current.month - 1, current.day));
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const candidateDate = new Date(localDate.getTime());
    candidateDate.setUTCDate(candidateDate.getUTCDate() + dayOffset);
    const weekday = candidateDate.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const minutes of [9 * 60 + 30, 16 * 60]) {
      const candidate = newYorkLocalTimeToEpoch(
        candidateDate.getUTCFullYear(),
        candidateDate.getUTCMonth() + 1,
        candidateDate.getUTCDate(),
        Math.floor(minutes / 60),
        minutes % 60,
      );
      if (Number.isFinite(candidate) && candidate > observedAtMs) {
        return Math.max(1, candidate - observedAtMs);
      }
    }
  }
  return 60_000;
}

/**
 * The visible after-hours reference follows the exact nominal New York clock.
 * Provider session labels can arrive late on the hosted deployment, so they
 * must never re-enable an after-hours value after 09:30 or delay it after
 * 16:00. The observations stay in the signature because other live-data
 * refresh decisions still consume the same canonical session observations.
 */
export function shouldUseAfterHoursPrices(
  _observations: readonly MarketSessionObservation[],
  observedAt?: Date,
): boolean {
  if (!observedAt || !Number.isFinite(observedAt.getTime())) return false;
  return !isNominalUsRegularSession(observedAt);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseWatchlistAfterHoursStreamMessage(
  payload: string,
): WatchlistAfterHoursStreamMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  const root = record(value);
  const item = record(root?.item);
  const sourceSymbolMatch = typeof item?.sourceSymbol === "string"
    ? item.sourceSymbol.match(
      /^([A-Z][A-Z0-9._-]{0,14}):([A-Z][A-Z0-9.-]{0,9})USDT\.P$/,
    )
    : null;
  if (
    root?.schemaVersion !== WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION
    || root.type !== "quote"
    || !item
    || typeof item.symbol !== "string"
    || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(item.symbol)
    || !sourceSymbolMatch
    || sourceSymbolMatch[2] !== item.symbol
    || item.currency !== "USDT"
    || item.source !== "tradingview-websocket"
  ) return null;

  const close = item.close;
  const updatedAt = item.updatedAt;
  const isMissing = close === null && updatedAt === null;
  const isPresent = typeof close === "number"
    && Number.isFinite(close)
    && close > 0
    && typeof updatedAt === "string"
    && Number.isFinite(Date.parse(updatedAt));
  if (!(isMissing || isPresent)) return null;

  return value as WatchlistAfterHoursStreamMessage;
}

export function isNewerAfterHoursClose(
  item: SyntheticLatestClose,
  previousUpdatedAt: string | null | undefined,
): boolean {
  if (item.close === null || item.updatedAt === null) return false;
  const nextTime = Date.parse(item.updatedAt);
  const previousTime = previousUpdatedAt ? Date.parse(previousUpdatedAt) : -Infinity;
  return Number.isFinite(nextTime)
    && (!Number.isFinite(previousTime) || nextTime >= previousTime);
}

/** Drop display values once their continuous-market freshness window closes. */
export function pruneStaleAfterHoursCloses(
  current: Readonly<Record<string, SyntheticLatestClose>>,
  observedAtMilliseconds = Date.now(),
): Readonly<Record<string, SyntheticLatestClose>> {
  const entries = Object.entries(current).filter(([, item]) => (
    isFreshSyntheticLatestClose(item, observedAtMilliseconds)
  ));
  return entries.length === Object.keys(current).length
    ? current
    : Object.freeze(Object.fromEntries(entries));
}
