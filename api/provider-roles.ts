export const PROVIDER_ROLES = Object.freeze([
  "instrument",
  "market",
  "bars",
  "profile",
  "fundamentals",
  "earnings",
  "analyst",
  "news",
] as const);

export type ProviderRole = (typeof PROVIDER_ROLES)[number];

/** Public role allow-list shared by JSON validation and the provider registry. */
export const PROVIDER_IDS_BY_ROLE = Object.freeze({
  instrument: Object.freeze(["mock", "yahoo", "fmp"]),
  market: Object.freeze(["mock", "yahoo", "fmp", "tradingview-websocket"]),
  bars: Object.freeze(["mock", "yahoo", "fmp", "tradingview-websocket"]),
  profile: Object.freeze(["yahoo", "fmp"]),
  fundamentals: Object.freeze(["yahoo", "fmp"]),
  earnings: Object.freeze(["yahoo", "fmp"]),
  analyst: Object.freeze(["benzinga", "fmp"]),
  news: Object.freeze(["yahoo", "fmp"]),
} as const satisfies Readonly<Record<ProviderRole, readonly string[]>>);
