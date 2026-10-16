export const WATCHLISTS_SCHEMA_VERSION = "trader.watchlists.v1" as const;
export const DEFAULT_LOCAL_OWNER_ID = "local-workspace" as const;
export const DEFAULT_WATCHLIST_NAME = "Main Watchlist" as const;

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const INSTRUMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const US_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

export type WatchlistItem = {
  id: string;
  watchlistId: string;
  instrumentId: string;
  symbol: string;
  displayName?: string;
  exchange?: string;
  logoUrl?: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type Watchlist = {
  id: string;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: WatchlistItem[];
};

export type WatchlistsResponse = {
  schemaVersion: typeof WATCHLISTS_SCHEMA_VERSION;
  ownerId: string;
  watchlists: Watchlist[];
};

export type WatchlistMutationResponse = {
  schemaVersion: typeof WATCHLISTS_SCHEMA_VERSION;
  watchlist: Watchlist;
};

export type WatchlistDeletionResponse = {
  schemaVersion: typeof WATCHLISTS_SCHEMA_VERSION;
  deletedId: string;
  nextWatchlistId: string;
};

export type WatchlistItemMutationResponse = {
  schemaVersion: typeof WATCHLISTS_SCHEMA_VERSION;
  item: WatchlistItem;
};

export type AddWatchlistItemInput = {
  instrumentId: string;
  symbol: string;
  displayName?: string;
  exchange?: string;
  logoUrl?: string;
};

export const DEFAULT_WATCHLIST_ITEMS = [
  {
    instrumentId: "us_xnas_aapl",
    symbol: "AAPL",
    displayName: "Apple Inc.",
    exchange: "NASDAQ",
    logoUrl: "/api/v1/symbols/AAPL/logo",
  },
  {
    instrumentId: "us_xnas_nvda",
    symbol: "NVDA",
    displayName: "NVIDIA Corporation",
    exchange: "NASDAQ",
    logoUrl: "/api/v1/symbols/NVDA/logo",
  },
  {
    instrumentId: "us_xnas_msft",
    symbol: "MSFT",
    displayName: "Microsoft Corporation",
    exchange: "NASDAQ",
    logoUrl: "/api/v1/symbols/MSFT/logo",
  },
  {
    instrumentId: "us_xnas_tsla",
    symbol: "TSLA",
    displayName: "Tesla, Inc.",
    exchange: "NASDAQ",
    logoUrl: "/api/v1/symbols/TSLA/logo",
  },
] as const satisfies readonly AddWatchlistItemInput[];

export class WatchlistInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchlistInputError";
  }
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new WatchlistInputError(`${field} must be a string`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTERS.test(normalized)) {
    throw new WatchlistInputError(`${field} is invalid`);
  }
  return normalized;
}

export function normalizeWatchlistName(value: unknown): string {
  if (typeof value !== "string") {
    throw new WatchlistInputError("name is required");
  }
  const name = value.normalize("NFKC").trim();
  if (!name || name.length > 60 || CONTROL_CHARACTERS.test(name)) {
    throw new WatchlistInputError("name must be between 1 and 60 characters");
  }
  return name;
}

export function normalizeWatchlistItemInput(value: unknown): AddWatchlistItemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WatchlistInputError("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const instrumentId = optionalText(input.instrumentId, "instrumentId", 128);
  if (!instrumentId || !INSTRUMENT_ID_PATTERN.test(instrumentId)) {
    throw new WatchlistInputError("instrumentId is invalid");
  }
  if (typeof input.symbol !== "string") {
    throw new WatchlistInputError("symbol is required");
  }
  const symbol = input.symbol.normalize("NFKC").trim().toUpperCase();
  if (!US_SYMBOL_PATTERN.test(symbol)) {
    throw new WatchlistInputError("symbol must be a valid US stock ticker");
  }

  const logoUrl = optionalText(input.logoUrl, "logoUrl", 2048);
  if (logoUrl && !logoUrl.startsWith("https://") && !logoUrl.startsWith("/")) {
    throw new WatchlistInputError("logoUrl must be an HTTPS URL or an absolute path");
  }

  return {
    instrumentId,
    symbol,
    displayName: optionalText(input.displayName, "displayName", 120),
    exchange: optionalText(input.exchange, "exchange", 40),
    logoUrl,
  };
}

export function normalizeReorderItemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new WatchlistInputError("itemIds must be an array of at most 500 ids");
  }
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(entry)) {
      throw new WatchlistInputError("itemIds contains an invalid id");
    }
    return entry;
  });
  if (new Set(ids).size !== ids.length) {
    throw new WatchlistInputError("itemIds must not contain duplicates");
  }
  return ids;
}

export function normalizeWatchlistEntityId(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(value)) {
    throw new WatchlistInputError(`${field} is invalid`);
  }
  return value;
}
