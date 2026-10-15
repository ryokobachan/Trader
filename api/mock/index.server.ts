import {
  PROVIDER_SCHEMA_VERSION,
  type Instrument,
  type MarketBar,
  type ProviderRegistration,
  type Quote,
} from "@/app/platform/provider-contracts";
import { companyLogoPathForUSStock } from "@/app/platform/company-logo";

const FIXTURE_AS_OF = "2026-08-08T13:32:00.000Z";
const FIXTURE_INGESTED_AT = "2026-08-08T13:32:05.000Z";

const instrumentFixtures: readonly Instrument[] = [
  {
    instrumentId: "us:XNAS:AAPL",
    symbol: "AAPL",
    name: "Apple Inc.",
    assetType: "common_stock",
    active: true,
    listingCountry: "US",
    exchange: "NASDAQ",
    exchangeMic: "XNAS",
    currency: "USD",
    sector: "Technology",
    industry: "Consumer Electronics",
    logoPath: companyLogoPathForUSStock("AAPL"),
    provenance: {
      providerId: "mock",
      sourceId: "fixture:instrument:AAPL",
      asOf: FIXTURE_AS_OF,
      ingestedAt: FIXTURE_INGESTED_AT,
    },
  },
  {
    instrumentId: "us:XNAS:NVDA",
    symbol: "NVDA",
    name: "NVIDIA Corporation",
    assetType: "common_stock",
    active: true,
    listingCountry: "US",
    exchange: "NASDAQ",
    exchangeMic: "XNAS",
    currency: "USD",
    sector: "Technology",
    industry: "Semiconductors",
    logoPath: companyLogoPathForUSStock("NVDA"),
    provenance: {
      providerId: "mock",
      sourceId: "fixture:instrument:NVDA",
      asOf: FIXTURE_AS_OF,
      ingestedAt: FIXTURE_INGESTED_AT,
    },
  },
  {
    instrumentId: "us:XNAS:MSFT",
    symbol: "MSFT",
    name: "Microsoft Corporation",
    assetType: "common_stock",
    active: true,
    listingCountry: "US",
    exchange: "NASDAQ",
    exchangeMic: "XNAS",
    currency: "USD",
    sector: "Technology",
    industry: "Software—Infrastructure",
    logoPath: companyLogoPathForUSStock("MSFT"),
    provenance: {
      providerId: "mock",
      sourceId: "fixture:instrument:MSFT",
      asOf: FIXTURE_AS_OF,
      ingestedAt: FIXTURE_INGESTED_AT,
    },
  },
  {
    instrumentId: "us:XNAS:TSLA",
    symbol: "TSLA",
    name: "Tesla, Inc.",
    assetType: "common_stock",
    active: true,
    listingCountry: "US",
    exchange: "NASDAQ",
    exchangeMic: "XNAS",
    currency: "USD",
    sector: "Consumer Cyclical",
    industry: "Auto Manufacturers",
    logoPath: companyLogoPathForUSStock("TSLA"),
    provenance: {
      providerId: "mock",
      sourceId: "fixture:instrument:TSLA",
      asOf: FIXTURE_AS_OF,
      ingestedAt: FIXTURE_INGESTED_AT,
    },
  },
] as const;

const quoteFixtures: Readonly<Record<string, Quote>> = {
  "us:XNAS:AAPL": {
    instrumentId: "us:XNAS:AAPL",
    price: 227.16,
    change: 3.12,
    changePercent: 1.39,
    previousClose: 224.04,
    open: 224.82,
    high: 228.34,
    low: 223.71,
    volume: 48_320_000,
    marketCap: 3_410_000_000_000,
    currency: "USD",
    marketState: "regular",
    delaySeconds: 900,
    provenance: {
      providerId: "mock",
      sourceId: "fixture:quote:AAPL",
      asOf: FIXTURE_AS_OF,
      ingestedAt: FIXTURE_INGESTED_AT,
    },
  },
  "us:XNAS:NVDA": {
    instrumentId: "us:XNAS:NVDA",
    price: 182.7,
    change: 4.42,
    changePercent: 2.48,
    previousClose: 178.28,
    open: 179.91,
    high: 184.16,
    low: 178.65,
    volume: 187_240_000,
    marketCap: 4_460_000_000_000,
    currency: "USD",
    marketState: "regular",
    delaySeconds: 900,
    provenance: {
      providerId: "mock",
      sourceId: "fixture:quote:NVDA",
      asOf: FIXTURE_AS_OF,
      ingestedAt: FIXTURE_INGESTED_AT,
    },
  },
  "us:XNAS:MSFT": {
    instrumentId: "us:XNAS:MSFT",
    price: 525.76,
    change: -1.81,
    changePercent: -0.34,
    previousClose: 527.57,
    open: 528.21,
    high: 530.18,
    low: 523.62,
    volume: 21_670_000,
    marketCap: 3_910_000_000_000,
    currency: "USD",
    marketState: "regular",
    delaySeconds: 900,
    provenance: {
      providerId: "mock",
      sourceId: "fixture:quote:MSFT",
      asOf: FIXTURE_AS_OF,
      ingestedAt: FIXTURE_INGESTED_AT,
    },
  },
  "us:XNAS:TSLA": {
    instrumentId: "us:XNAS:TSLA",
    price: 348.91,
    change: -5.21,
    changePercent: -1.47,
    previousClose: 354.12,
    open: 353.4,
    high: 356.28,
    low: 345.62,
    volume: 92_840_000,
    marketCap: 1_120_000_000_000,
    currency: "USD",
    marketState: "regular",
    delaySeconds: 900,
    provenance: {
      providerId: "mock",
      sourceId: "fixture:quote:TSLA",
      asOf: FIXTURE_AS_OF,
      ingestedAt: FIXTURE_INGESTED_AT,
    },
  },
};

function fixtureBars(instrument: Instrument): readonly MarketBar[] {
  const quote = quoteFixtures[instrument.instrumentId];
  if (!quote) return [];
  const start = new Date("2025-08-08T00:00:00.000Z");
  const items: MarketBar[] = [];
  let close = quote.price * 0.78;
  let cursor = 0;
  while (items.length < 260) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + cursor);
    cursor += 1;
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const phase = items.length / 15 + instrument.symbol.charCodeAt(0);
    const nextClose = close * (1 + 0.0012 + Math.sin(phase) * 0.006);
    const open = close * (1 + Math.cos(phase * 1.7) * 0.002);
    const high = Math.max(open, nextClose) * 1.004;
    const low = Math.min(open, nextClose) * 0.996;
    items.push({
      time: date.toISOString().slice(0, 10),
      open,
      high,
      low,
      close: nextClose,
      volume: Math.round(20_000_000 + (Math.sin(phase * 2.3) + 1) * 24_000_000),
    });
    close = nextClose;
  }
  const scale = quote.price / items[items.length - 1].close;
  return items.map((item) => ({
    ...item,
    open: item.open * scale,
    high: item.high * scale,
    low: item.low * scale,
    close: item.close * scale,
  }));
}

const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "mock",
  version: "1.0.0",
  displayName: "Trader deterministic fixtures",
  capabilities: ["instrument.search", "instrument.identity", "market.quote", "market.bars"],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: [],
} as const;

export const mockProviderRegistration = {
  manifest,
  create: () => ({
    manifest,
    instrument: {
      searchUSStocks: ({ query, limit = 20 }) => {
        const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase("en-US");
        const normalizedLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
        const matches = instrumentFixtures.filter((instrument) => {
          if (!normalizedQuery) return true;
          return `${instrument.symbol} ${instrument.name}`.toLocaleLowerCase("en-US").includes(normalizedQuery);
        });
        return Promise.resolve(matches.slice(0, normalizedLimit));
      },
      getUSStockBySymbol: (symbol) => {
        const normalizedSymbol = symbol.normalize("NFKC").trim().toUpperCase();
        return Promise.resolve(instrumentFixtures.find((instrument) => instrument.symbol === normalizedSymbol) ?? null);
      },
    },
    market: {
      getQuote: (instrument) => Promise.resolve(quoteFixtures[instrument.instrumentId] ?? null),
      getBars: (instrument, request) => Promise.resolve({
        instrumentId: instrument.instrumentId,
        interval: request.interval,
        range: request.range,
        adjustment: "raw" as const,
        items: fixtureBars(instrument),
        provenance: {
          providerId: "mock",
          sourceId: `fixture:bars:${instrument.symbol}`,
          asOf: FIXTURE_AS_OF,
          ingestedAt: FIXTURE_INGESTED_AT,
        },
      }),
    },
  }),
} as const satisfies ProviderRegistration;
