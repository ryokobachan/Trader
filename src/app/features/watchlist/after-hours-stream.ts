import {
  WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
  type SyntheticLatestClose,
  type WatchlistAfterHoursStreamMessage,
} from "../../platform/provider-contracts";

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
