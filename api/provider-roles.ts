export const PROVIDER_ROLES = Object.freeze([
  "instrument",
  "market",
  "bars",
  "profile",
  "fundamentals",
  "earnings",
  "research",
  "analyst",
  "news",
] as const);

export type ProviderRole = (typeof PROVIDER_ROLES)[number];

/** Public role allow-list shared by JSON validation and the provider registry. */
export const PROVIDER_IDS_BY_ROLE = Object.freeze({
  instrument: Object.freeze(["mock", "yahoo"]),
  market: Object.freeze(["mock", "yahoo", "tradingview-websocket"]),
  bars: Object.freeze(["mock", "yahoo", "tradingview-websocket"]),
  profile: Object.freeze(["yahoo", "tradingview"]),
  fundamentals: Object.freeze(["yahoo", "tradingview"]),
  earnings: Object.freeze(["yahoo", "tradingview", "google-finance-earnings"]),
  research: Object.freeze(["yahoo", "tradingview"]),
  analyst: Object.freeze([
    "benzinga",
    "google-finance",
    "google-finance-benzinga",
    "tipranks",
  ]),
  news: Object.freeze(["yahoo"]),
} as const satisfies Readonly<Record<ProviderRole, readonly string[]>>);
