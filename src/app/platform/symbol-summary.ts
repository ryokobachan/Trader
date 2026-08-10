import type { UiModuleDensity } from "./ui-module-registry";
import type { SyntheticLatestClose } from "./provider-contracts";

export type SymbolSummaryStock = Readonly<{
  ticker: string;
  name: string;
  logoPath?: string;
  logoFallback: string;
  market: string;
  sector: string;
  currency: string;
  currencyCode?: string;
  assetTypeLabel?: string;
  price: number;
  change: number;
  changeValue: number;
  high: number;
  low: number;
  volume: string;
  marketCap: string;
  target: number;
  targetLow: number;
  targetHigh: number;
  analysts: number;
  buy: number;
  neutral: number;
  sell: number;
  revenue: string;
  revenueGrowth: string;
  eps: string;
  epsGrowth: string;
  pe: string;
  dividend: string;
}>;

export type SymbolSummaryIntelligence = Readonly<{
  country: string;
  industry: string;
  website: string;
  employees: string;
  nextEarnings: string;
  earningsSession: string;
  earningsEstimate: string;
  revenueEstimate: string;
  exDividend: string;
  description: string;
  averageVolume30d: string;
  dayRangePosition: number;
  yearRangePosition: number;
  yearLow: string;
  yearHigh: string;
  beta: string;
  dataFreshness: string;
  marketStatus?: string;
  performance: Readonly<{
    week: string;
    month: string;
    threeMonths: string;
    yearToDate: string;
    year: string;
  }>;
  technical: Readonly<{
    overall: string;
    movingAverages: string;
    oscillators: string;
    rsi: string;
  }>;
}>;

export type SymbolSummaryModuleProps = Readonly<{
  stock: SymbolSummaryStock;
  intelligence: SymbolSummaryIntelligence;
  /**
   * Optional deployment-owned reference quote for the selected instrument.
   * Core and custom modules receive the same canonical value, so a deployment
   * can replace or extend the presentation without changing the host.
   */
  afterHours?: SyntheticLatestClose;
  watched: boolean;
  onToggleWatched: () => void;
  density: UiModuleDensity;
}>;

export type SymbolSummaryPriceTone = "positive" | "negative-text" | "neutral";

export function validSummaryAfterHoursClose(
  stock: Pick<SymbolSummaryStock, "ticker">,
  afterHours?: SyntheticLatestClose,
) {
  if (afterHours?.symbol.trim().toUpperCase() !== stock.ticker.trim().toUpperCase()) return null;
  const close = afterHours.close;
  return close !== null && Number.isFinite(close) && close > 0 ? close : null;
}

export function compareSummaryPrices(currentPrice: number, referencePrice: number | null): SymbolSummaryPriceTone {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0 || referencePrice === null) return "neutral";
  if (referencePrice > currentPrice) return "positive";
  if (referencePrice < currentPrice) return "negative-text";
  return "neutral";
}

export function formatSummaryAfterHoursPrice(value: number | null) {
  if (value === null) return "-";
  return value.toLocaleString("ja-JP", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatSummaryCurrentPrice(stock: SymbolSummaryStock) {
  if (!Number.isFinite(stock.price) || stock.price <= 0) return "-";
  const usesFractionalPrice = stock.currency === "$";
  return stock.price.toLocaleString("ja-JP", {
    minimumFractionDigits: usesFractionalPrice ? 2 : 0,
    maximumFractionDigits: usesFractionalPrice ? 2 : 0,
  });
}

export function formatSymbolPrice(stock: SymbolSummaryStock, value = stock.price) {
  const usesFractionalPrice = stock.currency === "$";
  return `${stock.currency}${value.toLocaleString("ja-JP", {
    minimumFractionDigits: usesFractionalPrice ? 2 : 0,
    maximumFractionDigits: usesFractionalPrice ? 2 : 0,
  })}`;
}

export function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
