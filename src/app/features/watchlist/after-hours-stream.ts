import {
  WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
  type MarketSessionState,
  type SyntheticLatestClose,
  type WatchlistAfterHoursStreamMessage,
} from "../../platform/provider-contracts";

/**
 * Enable the derived after-hours reference only after a current quote has
 * established that the shared U.S. regular session is not open. One regular
 * listing is enough to disable the column for the whole U.S. watchlist.
 */
export function shouldUseAfterHoursPrices(
  marketStates: readonly (MarketSessionState | undefined)[],
  observedAt?: Date,
): boolean {
  if (observedAt && Number.isFinite(observedAt.getTime())) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(observedAt);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekday = values.weekday;
    if (weekday === "Sat" || weekday === "Sun") return true;
    const minutes = Number(values.hour) * 60 + Number(values.minute);
    // During the nominal U.S. regular window, hiding the derived reference is
    // deliberately conservative for holidays and early closes. Outside that
    // window, the clock also prevents a stale `regular` quote from blocking the
    // after-hours stream after 16:00.
    return minutes < 9 * 60 + 30 || minutes >= 16 * 60;
  }
  const knownStates = marketStates.filter(
    (state): state is MarketSessionState => state !== undefined,
  );
  return knownStates.length > 0 && !knownStates.includes("regular");
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
  if (
    root?.schemaVersion !== WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION
    || root.type !== "quote"
    || !item
    || typeof item.symbol !== "string"
    || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(item.symbol)
    || typeof item.sourceSymbol !== "string"
    || !/^[A-Z][A-Z0-9._-]{0,14}:[A-Z][A-Z0-9.-]{0,9}USDT\.P$/.test(item.sourceSymbol)
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
