"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineStyle,
  LineSeries,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type LineWidth,
  type Time,
} from "lightweight-charts";
import {
  ArrowsOut,
  Bell,
  Camera,
  CaretDown,
  CaretRight,
  ChartBar,
  ChartLineUp,
  ChartPieSlice,
  Check,
  ClockCounterClockwise,
  Copy,
  DownloadSimple,
  DotsThree,
  Eye,
  Function as FunctionIcon,
  Gear,
  Lightning,
  ListBullets,
  MagnifyingGlass,
  Newspaper,
  PencilLine,
  Plus,
  Rows,
  SidebarSimple,
  Star,
  Trash,
  UploadSimple,
  UserCircle,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { UNICORN_BRAND } from "./platform/brand";
import { unicornConfig } from "./unicorn.config";
import type {
  FundamentalGroupId,
  StockDetailMetricId,
  SymbolDetailTabId,
} from "./platform/unicorn-config";
import { CompanyLogo } from "./components/CompanyLogo";
import { companyLogoPathForUSStock } from "./platform/company-logo";
import type { SymbolSummaryStock } from "./platform/symbol-summary";
import {
  DEFAULT_SYMBOL_SUMMARY_DENSITY,
  DEFAULT_SYMBOL_SUMMARY_MODULES,
} from "@extensions";
import { SymbolSummaryHost } from "./features/symbol-summary/SymbolSummaryHost";
import { useDismissibleLayer } from "./hooks/useDismissibleLayer";
import { translate, useI18n, type Locale } from "./platform/i18n";
import {
  createStrategyTranslator,
  portfolioChartModeLabel,
  portfolioTabLabel,
  portfolioTransactionSideLabel,
  portfolioTransactionTabLabel,
  strategyDurationLabel,
  strategyTechnicalRatingLabel,
} from "@strategies/i18n";
import {
  DEFAULT_SAMPLE_STRATEGY_ID,
  sampleStrategiesForLocale,
  type SampleStrategyRecord as StrategyRecord,
} from "@strategies/catalog";
import { buildStrategySummaryMetricRegistry } from "@strategies/metrics";
import { SAMPLE_PORTFOLIO_HOLDINGS } from "@strategies/sample-portfolio";
import { mergeStrategyPreferenceSnapshots } from "./features/strategy/strategy-preference-state";
import {
  resolveInstrumentSearchView,
  type InstrumentSearchStatus,
} from "./features/instrument-search/search-state";
import {
  buildStockDetailViewModel,
  type StockDetailMetric,
  type StockDetailSource,
  type StockDetailViewModel,
} from "@api/stock-detail/metrics";
import {
  AnalystTargetHistoryChart,
  EarningsActualEstimateChart,
  analystRatingChangeTone,
  analystTargetChangeTone,
} from "./features/stock-detail/StockDetailCharts";
import {
  SubIndicatorPanes,
  type SubIndicatorId,
  type SubIndicatorSpec,
} from "./features/chart-indicators/SubIndicatorPanes";
import {
  computeIndicatorSeries,
  finiteMarketBars,
  latestIndicatorValue,
  latestIndicatorValues,
  type IndicatorCalculationSpec,
} from "./features/chart-indicators/indicator-calculations";
import { chartLocaleTag } from "./features/chart-localization";
import {
  indicatorAppliedCount,
  indicatorResultCount,
  indicatorText,
  localizeIndicator,
  localizeIndicatorAnchor,
  localizeIndicatorSection,
  localizeIndicatorSource,
} from "./features/indicators/indicator-i18n";
import {
  CHART_INTERVAL_OPTIONS,
  chartIntervalLabel,
} from "./features/chart-timeframes/timeframes";
import {
  DEFAULT_CHART_CANDLE_COUNT,
  MAX_CHART_CANDLE_COUNT,
  MIN_CHART_CANDLE_COUNT,
  parseChartCandleCount,
} from "./features/chart-timeframes/candle-count";
import {
  WATCHLIST_AFTER_HOURS_MAX_SYMBOLS,
  WATCHLIST_QUOTES_MAX_SYMBOLS,
} from "./platform/provider-contracts";
import type {
  AnalystRatingHistory,
  AnalystRatingHistoryResponse,
  DataProvenance,
  EarningsEvent,
  Instrument,
  InstrumentSearchResponse,
  MarketBar,
  MarketBarInterval,
  MarketBarRange,
  MarketBarsResponse,
  SyntheticLatestClose,
  SymbolWorkspace,
  WatchlistAfterHoursResponse,
  WatchlistQuoteItem,
  WatchlistQuotesResponse,
} from "./platform/provider-contracts";
import type {
  Watchlist,
  WatchlistDeletionResponse,
  WatchlistItem,
  WatchlistItemMutationResponse,
  WatchlistMutationResponse,
  WatchlistsResponse,
} from "./platform/watchlist-contracts";
import type {
  StrategyPortfolioTransaction,
  StrategyPortfolioTransactionMutationResponse,
  StrategyPortfolioTransactionsResponse,
} from "./platform/strategy-portfolio-contracts";
import type {
  StrategyPreference,
  StrategyPreferenceDeleteResponse,
  StrategyPreferenceMutationResponse,
  StrategyPreferencesResponse,
} from "./platform/strategy-preference-contracts";

type Stock = SymbolSummaryStock & {
  currency: "$" | "¥";
  open: number;
  seed: number;
};

type MarketDataStatus = "loading" | "provider" | "fixture" | "error";
type AnalystHistoryStatus = "idle" | "loading" | "ready" | "error";

type IndicatorId =
  | "sma20"
  | "ema50"
  | "bollinger"
  | "vwap"
  | "rsi14"
  | "macd"
  | "stochastic"
  | "atr14"
  | "adx14"
  | "obv";

type IndicatorDefinition = {
  id: IndicatorId;
  shortName: string;
  name: string;
  category: "トレンド" | "モメンタム" | "ボラティリティ" | "出来高";
  description: string;
  color: string;
  placement: "チャート上" | "サブパネル";
};

type PrimaryView = "chart" | "stock-detail" | "strategy";
type UtilityPanelId = "watchlist" | "indicators" | "news";
type PortfolioTab = "概要" | "保有銘柄" | "取引";
type StrategyDuration = "1M" | "3M" | "6M" | "1Y" | "3Y" | "全期間";
type StrategySortKey = "candidateAt" | "profit" | "maxDrawdown" | "recoveryFactor" | "sharpe" | "winRate";
type AppDialogId = "alert" | "settings" | "snapshot" | "watchlist-create" | "watchlist-rename" | "watchlist-delete" | null;
type ToolbarMenuId = "chart-type" | "templates" | null;
type InstrumentSearchIntent = "select" | "watchlist-add";
type IndicatorSettingsTab = "パラメーター" | "スタイル" | "表示";
type IndicatorLineStyle = "solid" | "dashed" | "dotted";

const CHART_RANGE: MarketBarRange = "5y";
const WATCHLIST_MARKET_REFRESH_MS = 60_000;

const ENGLISH_INTERVAL_LABELS: Readonly<Record<MarketBarInterval, string>> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1D",
  "1wk": "1W",
  "1mo": "1M",
};

function localizedIntervalLabel(interval: MarketBarInterval, locale: Locale) {
  return locale === "ja" ? chartIntervalLabel(interval) : ENGLISH_INTERVAL_LABELS[interval];
}

type IndicatorSettings = {
  length: number;
  source: "終値" | "始値" | "高値" | "安値" | "HL2" | "HLC3";
  offset: number;
  multiplier: number;
  fast: number;
  slow: number;
  signal: number;
  smoothing: number;
  anchor: "セッション" | "週" | "月" | "四半期" | "年";
  color: string;
  lineWidth: LineWidth;
  lineStyle: IndicatorLineStyle;
  visibility: {
    minutes: boolean;
    hours: boolean;
    days: boolean;
    weeks: boolean;
    months: boolean;
  };
};

type PortfolioTransaction = {
  id: string;
  date: string;
  ticker: string;
  side: "買付" | "売却" | "配当";
  shares: number;
  price: number;
  fee: number;
};

const STOCKS: Stock[] = [
  {
    ticker: "AAPL",
    name: "Apple Inc.",
    logoPath: companyLogoPathForUSStock("AAPL"),
    logoFallback: "A",
    market: "NASDAQ",
    sector: "Technology",
    currency: "$",
    price: 231.41,
    change: 1.84,
    changeValue: 4.18,
    open: 227.09,
    high: 232.46,
    low: 226.55,
    volume: "48.2M",
    marketCap: "$3.48T",
    target: 247.8,
    targetLow: 190,
    targetHigh: 300,
    analysts: 34,
    buy: 22,
    neutral: 9,
    sell: 3,
    revenue: "$391.0B",
    revenueGrowth: "+4.2%",
    eps: "$6.62",
    epsGrowth: "+10.3%",
    pe: "34.9x",
    dividend: "0.43%",
    seed: 7,
  },
  {
    ticker: "NVDA",
    name: "NVIDIA Corp.",
    logoPath: companyLogoPathForUSStock("NVDA"),
    logoFallback: "N",
    market: "NASDAQ",
    sector: "Semiconductors",
    currency: "$",
    price: 182.77,
    change: 2.31,
    changeValue: 4.13,
    open: 178.31,
    high: 184.12,
    low: 177.88,
    volume: "156.4M",
    marketCap: "$4.46T",
    target: 201.5,
    targetLow: 145,
    targetHigh: 240,
    analysts: 52,
    buy: 43,
    neutral: 8,
    sell: 1,
    revenue: "$130.5B",
    revenueGrowth: "+72.1%",
    eps: "$4.12",
    epsGrowth: "+79.4%",
    pe: "44.3x",
    dividend: "0.02%",
    seed: 19,
  },
  {
    ticker: "MSFT",
    name: "Microsoft Corp.",
    logoPath: companyLogoPathForUSStock("MSFT"),
    logoFallback: "MS",
    market: "NASDAQ",
    sector: "Software",
    currency: "$",
    price: 498.16,
    change: -0.42,
    changeValue: -2.1,
    open: 501.06,
    high: 503.22,
    low: 496.84,
    volume: "21.7M",
    marketCap: "$3.70T",
    target: 548.2,
    targetLow: 420,
    targetHigh: 625,
    analysts: 46,
    buy: 39,
    neutral: 7,
    sell: 0,
    revenue: "$281.7B",
    revenueGrowth: "+15.0%",
    eps: "$13.64",
    epsGrowth: "+12.8%",
    pe: "36.5x",
    dividend: "0.67%",
    seed: 31,
  },
  {
    ticker: "TSLA",
    name: "Tesla Inc.",
    logoPath: companyLogoPathForUSStock("TSLA"),
    logoFallback: "T",
    market: "NASDAQ",
    sector: "Automotive",
    currency: "$",
    price: 321.56,
    change: 0.73,
    changeValue: 2.33,
    open: 317.22,
    high: 326.05,
    low: 315.19,
    volume: "92.3M",
    marketCap: "$1.04T",
    target: 286.4,
    targetLow: 120,
    targetHigh: 500,
    analysts: 41,
    buy: 17,
    neutral: 14,
    sell: 10,
    revenue: "$97.7B",
    revenueGrowth: "+1.1%",
    eps: "$2.24",
    epsGrowth: "-18.2%",
    pe: "143.6x",
    dividend: "—",
    seed: 43,
  },
];

const STOCK_CONTEXT: Record<string, {
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
}> = {
  AAPL: {
    country: "United States · Cupertino",
    industry: "Consumer electronics",
    website: "apple.com",
    employees: "164,000",
    nextEarnings: "Oct 30 · Estimated",
    earningsSession: "After market close",
    earningsEstimate: "$1.74",
    revenueEstimate: "$101.6B",
    exDividend: "Nov 10 · Estimated",
    description: "A global consumer technology company spanning devices, services, and payments.",
  },
  NVDA: {
    country: "United States · Santa Clara",
    industry: "Semiconductors",
    website: "nvidia.com",
    employees: "36,000",
    nextEarnings: "Nov 19 · Estimated",
    earningsSession: "After market close",
    earningsEstimate: "$1.26",
    revenueEstimate: "$54.9B",
    exDividend: "Dec 4 · Estimated",
    description: "Provides GPUs, AI accelerators, and computing platforms for data centers.",
  },
  MSFT: {
    country: "United States · Redmond",
    industry: "Software",
    website: "microsoft.com",
    employees: "228,000",
    nextEarnings: "Oct 28 · Estimated",
    earningsSession: "After market close",
    earningsEstimate: "$3.67",
    revenueEstimate: "$75.4B",
    exDividend: "Nov 20 · Estimated",
    description: "A platform company spanning cloud, business software, AI, and gaming.",
  },
  TSLA: {
    country: "United States · Austin",
    industry: "Automotive",
    website: "tesla.com",
    employees: "125,000",
    nextEarnings: "Oct 22 · Estimated",
    earningsSession: "After market close",
    earningsEstimate: "$0.44",
    revenueEstimate: "$25.8B",
    exDividend: "—",
    description: "Develops electric vehicles, energy storage, charging networks, AI, and robotics.",
  },
};

const NEWS = [
  {
    time: "10:18",
    title: "Sample: on-device AI features expand this fall",
    summary: "Synthetic fixture copy for demonstrating the news layout.",
    source: "Unicorn Sample News",
    tag: "AI",
  },
  {
    time: "08:35",
    title: "Sample: analyst updates a target price",
    summary: "Synthetic fixture copy; it is not an article from a real publisher.",
    source: "Unicorn Sample News",
    tag: "Rating",
  },
  {
    time: "Yesterday",
    title: "Sample: services revenue reaches a new high",
    summary: "Synthetic fixture copy for the provider-empty fallback state.",
    source: "Unicorn Sample News",
    tag: "Earnings",
  },
];

const INDICATORS: IndicatorDefinition[] = [
  { id: "sma20", shortName: "SMA 20", name: "単純移動平均", category: "トレンド", description: "20期間の終値平均", color: "#f4c44e", placement: "チャート上" },
  { id: "ema50", shortName: "EMA 50", name: "指数平滑移動平均", category: "トレンド", description: "直近価格を重視する50期間平均", color: "#8b7cff", placement: "チャート上" },
  { id: "bollinger", shortName: "BB 20", name: "ボリンジャーバンド", category: "ボラティリティ", description: "20期間・標準偏差2σ", color: "#4d9fff", placement: "チャート上" },
  { id: "vwap", shortName: "VWAP", name: "出来高加重平均価格", category: "出来高", description: "価格を出来高で加重した平均", color: "#d26cff", placement: "チャート上" },
  { id: "rsi14", shortName: "RSI 14", name: "相対力指数", category: "モメンタム", description: "買われ過ぎ・売られ過ぎを判定", color: "#39c5bb", placement: "サブパネル" },
  { id: "macd", shortName: "MACD", name: "MACD 12, 26, 9", category: "モメンタム", description: "2本のEMAからトレンド転換を確認", color: "#ff8b55", placement: "サブパネル" },
  { id: "stochastic", shortName: "STOCH", name: "ストキャスティクス", category: "モメンタム", description: "レンジ内の終値位置を測定", color: "#e36faf", placement: "サブパネル" },
  { id: "atr14", shortName: "ATR 14", name: "Average True Range", category: "ボラティリティ", description: "14期間の実現値幅", color: "#7bc96f", placement: "サブパネル" },
  { id: "adx14", shortName: "ADX 14", name: "平均方向性指数", category: "トレンド", description: "トレンドの強さを測定", color: "#e8a95b", placement: "サブパネル" },
  { id: "obv", shortName: "OBV", name: "On Balance Volume", category: "出来高", description: "出来高から資金流入出を推定", color: "#62b0ff", placement: "サブパネル" },
];

const createIndicatorSettings = (
  color: string,
  overrides: Partial<IndicatorSettings> = {},
): IndicatorSettings => ({
  length: 14,
  source: "終値",
  offset: 0,
  multiplier: 2,
  fast: 12,
  slow: 26,
  signal: 9,
  smoothing: 3,
  anchor: "セッション",
  color,
  lineWidth: 2,
  lineStyle: "solid",
  visibility: {
    minutes: true,
    hours: true,
    days: true,
    weeks: true,
    months: true,
  },
  ...overrides,
});

const DEFAULT_INDICATOR_SETTINGS: Record<IndicatorId, IndicatorSettings> = {
  sma20: createIndicatorSettings("#f4c44e", { length: 20 }),
  ema50: createIndicatorSettings("#8b7cff", { length: 50 }),
  bollinger: createIndicatorSettings("#4d9fff", { length: 20, multiplier: 2, lineWidth: 1 }),
  vwap: createIndicatorSettings("#d26cff", { source: "HLC3" }),
  rsi14: createIndicatorSettings("#39c5bb", { length: 14 }),
  macd: createIndicatorSettings("#ff8b55", { fast: 12, slow: 26, signal: 9 }),
  stochastic: createIndicatorSettings("#e36faf", { length: 14, smoothing: 3, signal: 3 }),
  atr14: createIndicatorSettings("#7bc96f", { length: 14 }),
  adx14: createIndicatorSettings("#e8a95b", { length: 14 }),
  obv: createIndicatorSettings("#62b0ff"),
};

const INDICATOR_ID_SET = new Set<IndicatorId>(INDICATORS.map((indicator) => indicator.id));

function isIndicatorId(value: unknown): value is IndicatorId {
  return typeof value === "string" && INDICATOR_ID_SET.has(value as IndicatorId);
}


const PORTFOLIO_HOLDINGS = SAMPLE_PORTFOLIO_HOLDINGS;

const portfolioTransactionFromApi = (
  transaction: StrategyPortfolioTransaction,
): PortfolioTransaction => ({
  id: transaction.transactionId,
  date: transaction.date,
  ticker: transaction.symbol,
  side: transaction.side === "buy" ? "買付" : transaction.side === "sell" ? "売却" : "配当",
  shares: transaction.shares,
  price: transaction.price,
  fee: transaction.fee,
});

const compactNumber = (value: number | undefined, prefix = "") => {
  if (!Number.isFinite(value)) return "—";
  return `${prefix}${new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value as number)}`;
};

const percentValue = (value: number | undefined, digits = 1) => {
  if (!Number.isFinite(value)) return "—";
  const normalized = Math.abs(value as number) <= 2 ? (value as number) * 100 : value as number;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(digits)}%`;
};

const multipleValue = (value: number | undefined) => Number.isFinite(value) ? `${(value as number).toFixed(1)}x` : "—";

function instrumentPlaceholder(instrument: Instrument): Stock {
  return {
    ticker: instrument.symbol,
    name: instrument.name,
    logoPath: instrument.logoPath ?? "",
    logoFallback: instrument.symbol.slice(0, 2),
    market: instrument.exchange,
    sector: instrument.sector ?? "—",
    currency: "$",
    currencyCode: "USD",
    assetTypeLabel: instrument.assetType === "adr" ? "ADR" : "普通株",
    price: 0,
    change: 0,
    changeValue: 0,
    open: 0,
    high: 0,
    low: 0,
    volume: "—",
    marketCap: "—",
    target: 0,
    targetLow: 0,
    targetHigh: 0,
    analysts: 0,
    buy: 0,
    neutral: 0,
    sell: 0,
    revenue: "—",
    revenueGrowth: "—",
    eps: "—",
    epsGrowth: "—",
    pe: "—",
    dividend: "—",
    seed: instrument.symbol.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0),
  };
}

function watchlistItemPlaceholder(item: WatchlistItem): Stock {
  const existing = STOCKS.find((stock) => stock.ticker === item.symbol);
  if (existing) return { ...existing, logoPath: item.logoUrl ?? existing.logoPath };
  return instrumentPlaceholder({
    instrumentId: item.instrumentId,
    symbol: item.symbol,
    name: item.displayName ?? item.symbol,
    exchange: item.exchange ?? "US",
    exchangeMic: "XXXX",
    currency: "USD",
    listingCountry: "US",
    assetType: "common_stock",
    active: true,
    logoPath: item.logoUrl,
    provenance: {
      providerId: "unicorn-watchlists",
      sourceId: item.id,
      asOf: item.updatedAt,
      ingestedAt: item.updatedAt,
    },
  });
}

function workspaceStock(workspace: SymbolWorkspace): Stock {
  const stock = instrumentPlaceholder(workspace.instrument);
  const consensus = workspace.analyst;
  const fundamentals = workspace.fundamentals;
  const profile = workspace.profile;
  const buy = (consensus?.strongBuy ?? 0) + (consensus?.buy ?? 0);
  const neutral = consensus?.hold ?? 0;
  const sell = (consensus?.sell ?? 0) + (consensus?.strongSell ?? 0);
  const target = consensus?.targetConsensus ?? workspace.quote.price;
  return {
    ...stock,
    logoPath: profile?.logoUrl ?? stock.logoPath,
    sector: profile?.sector ?? workspace.instrument.sector ?? "—",
    price: workspace.quote.price,
    change: workspace.quote.changePercent,
    changeValue: workspace.quote.change,
    open: workspace.quote.open,
    high: workspace.quote.high,
    low: workspace.quote.low,
    volume: compactNumber(workspace.quote.volume),
    marketCap: compactNumber(workspace.quote.marketCap ?? profile?.marketCap, "$"),
    target,
    targetLow: consensus?.targetLow ?? target,
    targetHigh: consensus?.targetHigh ?? target,
    analysts: consensus?.analystCount ?? buy + neutral + sell,
    buy,
    neutral,
    sell,
    revenue: compactNumber(fundamentals?.revenue, "$"),
    revenueGrowth: percentValue(fundamentals?.revenueGrowth),
    eps: Number.isFinite(fundamentals?.eps) ? `$${fundamentals!.eps!.toFixed(2)}` : "—",
    epsGrowth: percentValue(fundamentals?.epsGrowth),
    pe: multipleValue(fundamentals?.trailingPe ?? fundamentals?.forwardPe),
    dividend: percentValue(fundamentals?.dividendYield).replace(/^\+/, ""),
  };
}

function watchlistQuoteStock(item: WatchlistQuoteItem, current?: Stock): Stock | null {
  if (!item.instrument || !item.quote || item.quote.price <= 0 || !Number.isFinite(item.quote.price)) return null;
  const base = current ?? instrumentPlaceholder(item.instrument);
  return {
    ...base,
    ticker: item.instrument.symbol,
    name: item.instrument.name,
    logoPath: item.instrument.logoPath ?? base.logoPath,
    market: item.instrument.exchange,
    sector: item.instrument.sector ?? base.sector,
    price: item.quote.price,
    change: item.quote.changePercent,
    changeValue: item.quote.change,
    open: item.quote.open,
    high: item.quote.high,
    low: item.quote.low,
    volume: compactNumber(item.quote.volume),
    marketCap: compactNumber(item.quote.marketCap, "$"),
  };
}

function chartPerformance(items: readonly MarketBar[], offset: number) {
  if (items.length < 2) return "—";
  const last = items[items.length - 1].close;
  const previous = items[Math.max(0, items.length - 1 - offset)].close;
  return percentValue(previous === 0 ? undefined : last / previous - 1);
}

const formatPrice = (stock: Stock, value = stock.price) =>
  !Number.isFinite(value) || value <= 0 ? "-" : `${stock.currency}${value.toLocaleString("ja-JP", {
    minimumFractionDigits: stock.currency === "$" ? 2 : 0,
    maximumFractionDigits: stock.currency === "$" ? 2 : 0,
  })}`;

const formatWatchlistPrice = (stock: Stock) =>
  !Number.isFinite(stock.price) || stock.price <= 0 ? "-" : stock.price.toLocaleString("ja-JP", {
    minimumFractionDigits: stock.currency === "$" ? 2 : 0,
    maximumFractionDigits: stock.currency === "$" ? 2 : 0,
  });

const pseudoRandom = (seed: number) => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

const scaledMetric = (seed: number, offset: number, min: number, max: number, digits = 1) =>
  (min + pseudoRandom(seed + offset) * (max - min)).toFixed(digits);

const signedPercentMetric = (seed: number, offset: number, min: number, max: number) => {
  const value = Number(scaledMetric(seed, offset, min, max));
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
};

const technicalRating = (score: number) => {
  if (score >= 78) return "強い買い";
  if (score >= 62) return "買い";
  if (score <= 28) return "強い売り";
  if (score <= 43) return "売り";
  return "中立";
};

function getStockIntelligence(
  stock: Stock,
  workspace?: SymbolWorkspace | null,
  bars: readonly MarketBar[] = [],
  locale: Locale = "en",
) {
  const displayLocale = locale === "ja" ? "ja-JP" : "en-US";
  const context = STOCK_CONTEXT[stock.ticker] ?? STOCK_CONTEXT.AAPL;
  const beta = scaledMetric(stock.seed, 7, 0.72, 2.18, 2);
  const yearLowValue = stock.price * Number(scaledMetric(stock.seed, 3, 0.64, 0.81, 2));
  const yearHighValue = stock.price * Number(scaledMetric(stock.seed, 5, 1.08, 1.29, 2));
  const technicalScore = Number(scaledMetric(stock.seed, 157, 24, 91, 0));
  const movingAverageScore = Number(scaledMetric(stock.seed, 163, 24, 91, 0));
  const oscillatorScore = Number(scaledMetric(stock.seed, 167, 24, 91, 0));

  const fixture = {
    ...context,
    employees: (() => {
      const count = /^([\d,]+)人$/.exec(context.employees)?.[1];
      return count ? translate(locale, "detail.value.employees", { count }) : context.employees;
    })(),
    yearLow: formatPrice(stock, yearLowValue),
    yearHigh: formatPrice(stock, yearHighValue),
    dayRangePosition: Math.min(100, Math.max(0, ((stock.price - stock.low) / Math.max(stock.high - stock.low, 0.01)) * 100)),
    yearRangePosition: Math.min(100, Math.max(0, ((stock.price - yearLowValue) / Math.max(yearHighValue - yearLowValue, 0.01)) * 100)),
    averageVolume30d: `${scaledMetric(stock.seed, 151, 22, 168)}M`,
    performance: {
      week: signedPercentMetric(stock.seed, 173, -8, 13),
      month: signedPercentMetric(stock.seed, 179, -14, 24),
      threeMonths: signedPercentMetric(stock.seed, 181, -24, 48),
      yearToDate: signedPercentMetric(stock.seed, 191, -31, 76),
      year: signedPercentMetric(stock.seed, 193, -42, 112),
    },
    technical: {
      overall: technicalRating(technicalScore),
      movingAverages: technicalRating(movingAverageScore),
      oscillators: technicalRating(oscillatorScore),
      rsi: scaledMetric(stock.seed, 197, 28, 78),
    },
    beta,
    dataFreshness: translate(locale, "summary.dataFreshnessFixture"),
  };

  if (!workspace || workspace.instrument.symbol !== stock.ticker) return fixture;

  const profile = workspace.profile;
  const earnings = workspace.earnings[0];
  const closes = bars.map((item) => item.close).filter(Number.isFinite);
  const yearLow = bars.length > 0 ? Math.min(...bars.map((item) => item.low)) : stock.low;
  const yearHigh = bars.length > 0 ? Math.max(...bars.map((item) => item.high)) : stock.high;
  const averageVolume = bars.length > 0
    ? bars.slice(-30).reduce((sum, item) => sum + item.volume, 0) / Math.min(30, bars.length)
    : workspace.quote.volume;
  const recent = closes.slice(-15);
  const gains = recent.flatMap((value, index) => index === 0 ? [] : [Math.max(0, value - recent[index - 1])]);
  const losses = recent.flatMap((value, index) => index === 0 ? [] : [Math.max(0, recent[index - 1] - value)]);
  const averageGain = gains.reduce((sum, value) => sum + value, 0) / Math.max(1, gains.length);
  const averageLoss = losses.reduce((sum, value) => sum + value, 0) / Math.max(1, losses.length);
  const rsi = averageLoss === 0 ? 100 : 100 - (100 / (1 + averageGain / averageLoss));
  const movingAverage20 = closes.slice(-20).reduce((sum, value) => sum + value, 0) / Math.max(1, Math.min(20, closes.length));
  const liveTechnicalScore = closes.length === 0 ? 50 : stock.price > movingAverage20 ? 68 : 36;
  const sessionLabels = {
    pre_market: translate(locale, "summary.market.preMarket"),
    regular: translate(locale, "summary.marketOpen"),
    after_hours: translate(locale, "summary.market.afterHours"),
    closed: translate(locale, "summary.market.closed"),
  } as const;

  return {
    ...fixture,
    country: [profile?.country, profile?.city].filter(Boolean).join(" · ") || "—",
    industry: profile?.industry ?? workspace.instrument.industry ?? "—",
    website: profile?.website ?? "—",
    employees: Number.isFinite(profile?.employees)
      ? translate(locale, "detail.value.employees", { count: profile!.employees!.toLocaleString(displayLocale) })
      : "—",
    nextEarnings: earnings?.reportDate ?? "—",
    earningsSession: "—",
    earningsEstimate: Number.isFinite(earnings?.epsEstimate) ? `$${earnings!.epsEstimate!.toFixed(2)}` : "—",
    revenueEstimate: compactNumber(earnings?.revenueEstimate, "$"),
    exDividend: "—",
    description: profile?.description ?? "—",
    yearLow: formatPrice(stock, yearLow),
    yearHigh: formatPrice(stock, yearHigh),
    dayRangePosition: Math.min(100, Math.max(0, ((stock.price - stock.low) / Math.max(stock.high - stock.low, 0.01)) * 100)),
    yearRangePosition: Math.min(100, Math.max(0, ((stock.price - yearLow) / Math.max(yearHigh - yearLow, 0.01)) * 100)),
    averageVolume30d: compactNumber(averageVolume),
    performance: {
      week: chartPerformance(bars, 5),
      month: chartPerformance(bars, 21),
      threeMonths: chartPerformance(bars, 63),
      yearToDate: chartPerformance(bars, Math.max(1, bars.length - 1)),
      year: chartPerformance(bars, 252),
    },
    technical: {
      overall: technicalRating(liveTechnicalScore),
      movingAverages: stock.price >= movingAverage20 ? "買い" : "売り",
      oscillators: rsi > 70 ? "売り" : rsi < 30 ? "買い" : "中立",
      rsi: Number.isFinite(rsi) ? rsi.toFixed(1) : "—",
    },
    beta: Number.isFinite(profile?.beta) ? profile!.beta!.toFixed(2) : "—",
    dataFreshness: new Date(workspace.asOf).toLocaleString(displayLocale, { timeZone: "Asia/Tokyo", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    marketStatus: sessionLabels[workspace.quote.marketState],
  };
}

function indicatorCalculationSpec(
  id: IndicatorId,
  settings: IndicatorSettings,
): IndicatorCalculationSpec {
  return {
    id,
    length: settings.length,
    source: settings.source,
    multiplier: settings.multiplier,
    fast: settings.fast,
    slow: settings.slow,
    signal: settings.signal,
    smoothing: settings.smoothing,
  };
}

function getIndicatorReading(
  id: IndicatorId,
  stock: Stock,
  bars: readonly MarketBar[],
  settings: IndicatorSettings,
) {
  const readings: Record<IndicatorId, string> = {
    sma20: formatPrice(stock, stock.price * Number(scaledMetric(stock.seed, 101, 0.94, 1.03, 3))),
    ema50: formatPrice(stock, stock.price * Number(scaledMetric(stock.seed, 103, 0.88, 1.01, 3))),
    bollinger: `${scaledMetric(stock.seed, 107, 1.6, 3.1)}σ`,
    vwap: formatPrice(stock, stock.price * Number(scaledMetric(stock.seed, 109, 0.96, 1.02, 3))),
    rsi14: scaledMetric(stock.seed, 113, 37, 76),
    macd: `${Number(scaledMetric(stock.seed, 127, -2.8, 4.2)) >= 0 ? "+" : ""}${scaledMetric(stock.seed, 127, -2.8, 4.2)}`,
    stochastic: scaledMetric(stock.seed, 131, 24, 88),
    atr14: `${scaledMetric(stock.seed, 137, 1.2, 5.8)}%`,
    adx14: scaledMetric(stock.seed, 139, 18, 43),
    obv: `${Number(scaledMetric(stock.seed, 149, -8, 15)) >= 0 ? "+" : ""}${scaledMetric(stock.seed, 149, -8, 15)}%`,
  };
  const computed = computeIndicatorSeries(bars, indicatorCalculationSpec(id, settings));
  const primaryValue = latestIndicatorValue(computed);
  if (primaryValue === undefined) return readings[id];
  if (id === "sma20" || id === "ema50" || id === "vwap") return formatPrice(stock, primaryValue);
  if (id === "bollinger") {
    const values = latestIndicatorValues(computed);
    const upper = values.find((item) => item.key === "upper")?.value;
    const lower = values.find((item) => item.key === "lower")?.value;
    return upper === undefined || lower === undefined
      ? readings[id]
      : `${formatPrice(stock, upper)} / ${formatPrice(stock, lower)}`;
  }
  if (id === "macd") return `${primaryValue >= 0 ? "+" : ""}${primaryValue.toFixed(3)}`;
  if (id === "stochastic" || id === "rsi14" || id === "adx14") return primaryValue.toFixed(1);
  if (id === "atr14") return formatPrice(stock, primaryValue);
  return compactNumber(primaryValue);
}

function getIndicatorDisplayName(
  indicator: IndicatorDefinition,
  settings: IndicatorSettings,
) {
  if (["sma20", "ema50", "rsi14", "atr14", "adx14"].includes(indicator.id)) {
    return `${indicator.shortName.split(" ")[0]} ${settings.length}`;
  }
  if (indicator.id === "bollinger") return `BB ${settings.length} ${settings.multiplier}`;
  if (indicator.id === "macd") return `MACD ${settings.fast} ${settings.slow} ${settings.signal}`;
  if (indicator.id === "stochastic") return `Stoch ${settings.length} ${settings.smoothing} ${settings.signal}`;
  return indicator.shortName;
}

function getChartLineStyle(style: IndicatorLineStyle) {
  if (style === "dashed") return LineStyle.Dashed;
  if (style === "dotted") return LineStyle.Dotted;
  return LineStyle.Solid;
}

function generateSeries(
  marketBars: readonly MarketBar[],
  indicatorSettings: Record<IndicatorId, IndicatorSettings>,
) {
  const candles: CandlestickData<Time>[] = [];
  const volumes: HistogramData<Time>[] = [];
  const chartTime = (value: string): Time => /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value as Time
    : Math.floor(new Date(value).getTime() / 1000) as Time;
  const overlaySeries = {
    sma20: computeIndicatorSeries(marketBars, indicatorCalculationSpec("sma20", indicatorSettings.sma20)),
    ema50: computeIndicatorSeries(marketBars, indicatorCalculationSpec("ema50", indicatorSettings.ema50)),
    bollinger: computeIndicatorSeries(marketBars, indicatorCalculationSpec("bollinger", indicatorSettings.bollinger)),
    vwap: computeIndicatorSeries(marketBars, indicatorCalculationSpec("vwap", indicatorSettings.vwap)),
  };
  const lineData = (
    computed: ReturnType<typeof computeIndicatorSeries>,
    seriesKey: string,
  ): LineData<Time>[] => {
    return computed.series
      .find((series) => series.key === seriesKey)
      ?.points.map((point) => ({ time: chartTime(point.time), value: point.value })) ?? [];
  };
  const raw: Array<{
    time: Time;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = finiteMarketBars(marketBars).map((point) => ({
    time: chartTime(point.time),
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close,
    volume: point.volume,
  }));

  raw.forEach((point) => {
    const open = point.open;
    const high = point.high;
    const low = point.low;
    const adjustedClose = point.close;
    candles.push({
      time: point.time,
      open,
      high,
      low,
      close: adjustedClose,
    });
    volumes.push({
      time: point.time,
      value: point.volume,
      color: adjustedClose >= open ? "rgba(38, 166, 154, .38)" : "rgba(239, 83, 80, .36)",
    });

  });

  return {
    candles,
    volumes,
    sma20: lineData(overlaySeries.sma20, "sma"),
    ema50: lineData(overlaySeries.ema50, "ema"),
    bollingerUpper: lineData(overlaySeries.bollinger, "upper"),
    bollingerLower: lineData(overlaySeries.bollinger, "lower"),
    vwap: lineData(overlaySeries.vwap, "vwap"),
  };
}

function PriceChart({
  stock,
  marketBars,
  range,
  chartType,
  activeIndicators,
  indicatorSettings,
}: {
  stock: Stock;
  marketBars: readonly MarketBar[];
  range: string;
  chartType: string;
  activeIndicators: IndicatorId[];
  indicatorSettings: Record<IndicatorId, IndicatorSettings>;
}) {
  const { locale, t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const fullData = useMemo(
    () => generateSeries(marketBars, indicatorSettings),
    [indicatorSettings, marketBars],
  );
  const latestCandle = fullData.candles.at(-1);
  const priceLineColor = latestCandle && latestCandle.close < latestCandle.open
    ? "#ef5350"
    : "#26a69a";

  useEffect(() => {
    if (!containerRef.current) return;
    const host = containerRef.current;
    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      autoSize: true,
      localization: { locale: chartLocaleTag(locale) },
      layout: {
        attributionLogo: false,
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#8e8e93",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: "#171717" },
        horzLines: { color: "#171717" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#717b88", labelBackgroundColor: "#363c45" },
        horzLine: { color: "#717b88", labelBackgroundColor: "#363c45" },
      },
      rightPriceScale: {
        borderColor: "#242424",
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: "#242424",
        rightOffset: 3,
        barSpacing: 7,
        minBarSpacing: 3,
        timeVisible: marketBars.some((item) => item.time.includes("T")),
      },
      handleScroll: true,
      handleScale: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      priceLineColor,
      priceLineWidth: 1,
      lastValueVisible: true,
      visible: chartType === "ローソク",
    });
    const priceLineSeries = chart.addSeries(LineSeries, {
      color: "#66a3ff",
      lineWidth: 2,
      priceLineVisible: true,
      visible: chartType === "ライン",
    });
    const priceAreaSeries = chart.addSeries(AreaSeries, {
      lineColor: "#66a3ff",
      topColor: "rgba(41, 98, 255, 0.34)",
      bottomColor: "rgba(41, 98, 255, 0.01)",
      lineWidth: 2,
      visible: chartType === "エリア",
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    const smaSeries = chart.addSeries(LineSeries, {
      color: indicatorSettings.sma20.color,
      lineWidth: indicatorSettings.sma20.lineWidth,
      lineStyle: getChartLineStyle(indicatorSettings.sma20.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: activeIndicators.includes("sma20"),
    });
    const emaSeries = chart.addSeries(LineSeries, {
      color: indicatorSettings.ema50.color,
      lineWidth: indicatorSettings.ema50.lineWidth,
      lineStyle: getChartLineStyle(indicatorSettings.ema50.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: activeIndicators.includes("ema50"),
    });
    const bollingerUpperSeries = chart.addSeries(LineSeries, {
      color: indicatorSettings.bollinger.color,
      lineWidth: indicatorSettings.bollinger.lineWidth,
      lineStyle: getChartLineStyle(indicatorSettings.bollinger.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: activeIndicators.includes("bollinger"),
    });
    const bollingerLowerSeries = chart.addSeries(LineSeries, {
      color: indicatorSettings.bollinger.color,
      lineWidth: indicatorSettings.bollinger.lineWidth,
      lineStyle: getChartLineStyle(indicatorSettings.bollinger.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: activeIndicators.includes("bollinger"),
    });
    const vwapSeries = chart.addSeries(LineSeries, {
      color: indicatorSettings.vwap.color,
      lineWidth: indicatorSettings.vwap.lineWidth,
      lineStyle: getChartLineStyle(indicatorSettings.vwap.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: activeIndicators.includes("vwap"),
    });

    const count = fullData.candles.length;
    candleSeries.setData(fullData.candles.slice(-count));
    const closeData = fullData.candles.map((point) => ({ time: point.time, value: point.close }));
    priceLineSeries.setData(closeData.slice(-count));
    priceAreaSeries.setData(closeData.slice(-count));
    volumeSeries.setData(fullData.volumes.slice(-count));
    smaSeries.setData(fullData.sma20.slice(-count));
    emaSeries.setData(fullData.ema50.slice(-count));
    bollingerUpperSeries.setData(fullData.bollingerUpper.slice(-count));
    bollingerLowerSeries.setData(fullData.bollingerLower.slice(-count));
    vwapSeries.setData(fullData.vwap.slice(-count));
    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [activeIndicators, chartType, fullData, indicatorSettings, locale, marketBars, priceLineColor, range]);

  return <div className="chart-canvas" ref={containerRef} aria-label={t("chart.priceAria", { symbol: stock.ticker })} />;
}

function PortfolioValueChart({
  mode,
  period,
  seed,
  ariaLabel,
}: {
  mode: "資産額" | "パフォーマンス";
  period: "1M" | "3M" | "6M" | "YTD" | "1Y" | "ALL";
  seed: number;
  ariaLabel: string;
}) {
  const { locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const host = containerRef.current;
    const countMap = { "1M": 24, "3M": 54, "6M": 88, YTD: 122, "1Y": 168, ALL: 220 };
    const count = countMap[period];
    const start = new Date(Date.UTC(2025, 8, 1));
    const values: LineData<Time>[] = [];
    const benchmark: LineData<Time>[] = [];
    let portfolioValue = 208400 + seed * 780;
    let benchmarkValue = portfolioValue;
    for (let index = 0; index < 220; index += 1) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + index * 2);
      const time = date.toISOString().slice(0, 10) as Time;
      const drift = 0.00078 + Math.sin(index / 13 + seed) * 0.0011 + (pseudoRandom(seed * 13 + index) - 0.48) * 0.012;
      const benchmarkDrift = 0.00048 + Math.sin(index / 17) * 0.0007 + (pseudoRandom(seed * 7 + index) - 0.49) * 0.007;
      portfolioValue *= 1 + drift;
      benchmarkValue *= 1 + benchmarkDrift;
      values.push({ time, value: mode === "資産額" ? portfolioValue : ((portfolioValue / (208400 + seed * 780)) - 1) * 100 });
      benchmark.push({ time, value: mode === "資産額" ? benchmarkValue : ((benchmarkValue / (208400 + seed * 780)) - 1) * 100 });
    }

    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      autoSize: true,
      localization: { locale: chartLocaleTag(locale) },
      layout: {
        attributionLogo: false,
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#8e8e93",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
        fontSize: 12,
      },
      grid: { vertLines: { color: "#171717" }, horzLines: { color: "#171717" } },
      rightPriceScale: { borderColor: "#242424" },
      timeScale: { borderColor: "#242424", rightOffset: 2 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: "#2962ff",
      topColor: "rgba(41, 98, 255, 0.32)",
      bottomColor: "rgba(41, 98, 255, 0.01)",
      lineWidth: 2,
      priceFormat: mode === "資産額" ? { type: "price", precision: 0, minMove: 1 } : { type: "price", precision: 1, minMove: 0.1 },
    });
    const benchmarkSeries = chart.addSeries(LineSeries, {
      color: "#8e8e93",
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    area.setData(values.slice(-count));
    benchmarkSeries.setData(benchmark.slice(-count));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [locale, mode, period, seed]);

  return <div className="portfolio-chart-canvas" ref={containerRef} aria-label={ariaLabel} />;
}

function PortfolioProfitChart({ seed, ariaLabel }: { seed: number; ariaLabel: string }) {
  const { locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!containerRef.current) return;
    const host = containerRef.current;
    const start = new Date(Date.UTC(2025, 8, 1));
    const data: HistogramData<Time>[] = Array.from({ length: 12 }, (_, index) => {
      const date = new Date(start);
      date.setUTCMonth(start.getUTCMonth() + index);
      const raw = (pseudoRandom(seed * 11 + index) - 0.38) * 9.5;
      return {
        time: date.toISOString().slice(0, 10) as Time,
        value: Number(raw.toFixed(2)),
        color: raw >= 0 ? "#26a69a" : "#ef5350",
      };
    });
    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      autoSize: true,
      localization: { locale: chartLocaleTag(locale) },
      layout: {
        attributionLogo: false,
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#8e8e93",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
        fontSize: 12,
      },
      grid: { vertLines: { color: "#171717" }, horzLines: { color: "#171717" } },
      rightPriceScale: { borderColor: "#242424" },
      timeScale: { borderColor: "#242424", rightOffset: 1 },
    });
    const series = chart.addSeries(HistogramSeries, { priceFormat: { type: "price", precision: 1, minMove: 0.1 } });
    series.setData(data);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [locale, seed]);
  return <div className="portfolio-analysis-chart" ref={containerRef} aria-label={ariaLabel} />;
}

function DialogShell({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="app-dialog-backdrop" onMouseDown={onClose}>
      <section className={`app-dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>
          <IconButton label={t("common.close")} onClick={onClose}><X size={18} /></IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

function IconButton({
  label,
  children,
  active = false,
  onClick,
  className = "",
  hasPopup,
  expanded,
  controls,
}: {
  label: string;
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
  hasPopup?: React.AriaAttributes["aria-haspopup"];
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "is-active" : ""} ${className}`}
      aria-label={label}
      aria-pressed={active}
      aria-haspopup={hasPopup}
      aria-expanded={expanded}
      aria-controls={controls}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

type TranslateMessage = ReturnType<typeof useI18n>["t"];

const STOCK_DETAIL_METRIC_LABEL_KEYS: Readonly<Record<string, string>> = {
  "上場市場": "metric.listingMarket",
  "証券種別": "metric.securityType",
  "セクター": "metric.sector",
  "業種": "metric.industry",
  "所在地": "metric.location",
  "従業員": "metric.employees",
  "Webサイト": "metric.website",
  "ベータ": "metric.beta",
  "現在値": "metric.currentPrice",
  "前日終値": "metric.previousClose",
  "始値": "metric.open",
  "高値": "metric.high",
  "安値": "metric.low",
  "出来高": "metric.volume",
  "時価総額": "metric.marketCap",
  "公称遅延": "metric.nominalDelay",
  "取得期間レンジ": "metric.periodRange",
  "取得期間リターン": "metric.periodReturn",
  "期間VWAP": "metric.periodVwap",
  "平均出来高 20": "metric.averageVolume20",
  "実現ボラティリティ 30": "metric.realizedVolatility30",
  "売上高": "metric.revenue",
  "売上高成長率": "metric.revenueGrowth",
  "粗利益": "metric.grossProfit",
  "営業利益": "metric.operatingIncome",
  "純利益": "metric.netIncome",
  "EPS成長率": "metric.epsGrowth",
  "企業価値（EV）": "metric.enterpriseValue",
  "実績PER": "metric.trailingPe",
  "予想PER": "metric.forwardPe",
  "EV / 売上高": "metric.evToRevenue",
  "利益利回り": "metric.earningsYield",
  "粗利率": "metric.grossMargin",
  "営業利益率": "metric.operatingMargin",
  "EBITDAマージン": "metric.ebitdaMargin",
  "純利益率": "metric.netMargin",
  "FCFマージン": "metric.fcfMargin",
  "総資産回転率": "metric.assetTurnover",
  "インタレスト・カバレッジ": "metric.interestCoverage",
  "現金・短期投資": "metric.cash",
  "総資産": "metric.totalAssets",
  "有利子負債": "metric.totalDebt",
  "ネットデット": "metric.netDebt",
  "株主資本": "metric.equity",
  "流動比率": "metric.currentRatio",
  "当座比率": "metric.quickRatio",
  "現金比率": "metric.cashRatio",
  "営業CF": "metric.operatingCashFlow",
  "設備投資": "metric.capex",
  "フリーCF": "metric.freeCashFlow",
  "FCF利回り": "metric.fcfYield",
  "配当利回り": "metric.dividendYield",
  "1株配当": "metric.dividendPerShare",
  "配当性向": "metric.payoutRatio",
  "1株売上高": "metric.revenuePerShare",
  "1株簿価": "metric.bookValuePerShare",
  "1株営業CF": "metric.operatingCfPerShare",
  "1株FCF": "metric.fcfPerShare",
  "EPS実績": "metric.epsActual",
  "EPS予想": "metric.epsEstimate",
  "売上高実績": "metric.revenueActual",
  "売上高予想": "metric.revenueEstimate",
  "目標価格・平均": "metric.targetAverage",
  "目標価格・中央値": "metric.targetMedian",
  "目標価格・下限": "metric.targetLow",
  "目標価格・上限": "metric.targetHigh",
  "アナリスト数": "metric.analystCount",
  "強い買い": "metric.strongBuy",
  "買い": "metric.buy",
  "中立": "metric.hold",
  "売り": "metric.sell",
  "強い売り": "metric.strongSell",
  "予想EPS": "metric.forwardEps",
  "予想売上高": "metric.forwardRevenue",
  "平均目標への乖離": "metric.targetUpside",
};

const STOCK_DETAIL_NOTE_KEYS: Readonly<Record<string, string>> = {
  "Provider最新値 · USD": "detail.note.providerUsd",
  "Provider最新値 · %": "detail.note.providerPercent",
  "Provider最新値 · 倍率": "detail.note.providerMultiple",
  "Provider最新値 · USD / 株": "detail.note.providerUsdPerShare",
  "取得OHLCV全期間": "detail.note.allOhlcv",
  "終値・日足20本": "detail.note.closeDaily20",
  "日足20本": "detail.note.daily20",
  "終値・日足50本以上": "detail.note.closeDaily50",
  "終値・日足14期間": "detail.note.closeDaily14",
  "日足14期間": "detail.note.daily14",
  "日次リターン・年率換算": "detail.note.annualizedDailyReturns",
};

function stockDetailMetricLabel(label: string, t: TranslateMessage) {
  const key = STOCK_DETAIL_METRIC_LABEL_KEYS[label];
  return key ? t(key) : label;
}

function stockDetailSourceLabel(label: string, t: TranslateMessage) {
  return label === "Provider未選択" ? t("detail.source.providerNotSelected") : label;
}

function stockDetailMarketState(value: string, t: TranslateMessage) {
  const key = ({
    "プレマーケット": "detail.marketState.preMarket",
    "取引中": "detail.marketState.regular",
    "時間外取引": "detail.marketState.afterHours",
    "取引時間外": "detail.marketState.closed",
  } as const)[value as "プレマーケット" | "取引中" | "時間外取引" | "取引時間外"];
  return key ? t(key) : value;
}

function stockDetailContext(value: string | undefined, t: TranslateMessage) {
  if (!value) return value;
  const localizedMarketState = stockDetailMarketState(value, t);
  if (localizedMarketState !== value) return localizedMarketState;
  const bars = /^([\d,]+)本$/.exec(value);
  return bars ? t("detail.context.bars", { count: bars[1] }) : value;
}

function stockDetailMetricNote(note: string, t: TranslateMessage) {
  const key = STOCK_DETAIL_NOTE_KEYS[note];
  if (key) return t(key);
  const bars = /^([\d,]+)本のOHLCV$/.exec(note);
  return bars ? t("detail.note.ohlcvBars", { count: bars[1] }) : note;
}

function stockDetailMetricValue(
  metric: StockDetailMetric,
  locale: Locale,
  t: TranslateMessage,
) {
  if (metric.label === "証券種別" && metric.value === "普通株") {
    return t("detail.value.commonStock");
  }
  const localizedCount = (pattern: RegExp, key: string) => {
    const match = pattern.exec(metric.value);
    if (!match) return null;
    const parsed = Number(match[1].replace(/,/g, ""));
    const count = Number.isFinite(parsed)
      ? parsed.toLocaleString(locale === "ja" ? "ja-JP" : "en-US")
      : match[1];
    return t(key, { count });
  };
  if (metric.label === "従業員") {
    return localizedCount(/^([\d,]+)人$/, "detail.value.employees") ?? metric.value;
  }
  if (metric.label === "公称遅延") {
    return localizedCount(/^([\d,]+)秒$/, "detail.value.seconds") ?? metric.value;
  }
  if (metric.label === "アナリスト数") {
    return localizedCount(/^([\d,]+)名$/, "detail.value.analysts") ?? metric.value;
  }
  return metric.value;
}

function formatStockDetailTimestamp(value: string | undefined, locale: Locale) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale === "ja" ? "ja-JP" : "en-US", {
    timeZone: "Asia/Tokyo",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DetailSourceChip({ source }: { source: StockDetailSource }) {
  const { locale, t } = useI18n();
  return (
    <span className={`detail-source-chip ${source.isStale ? "stale" : ""}`} title={source.sourceId}>
      <b>{stockDetailSourceLabel(source.label, t)}</b>
      {source.isStale && <em>{t("detail.source.stale")}</em>}
      {source.asOf && <small>{formatStockDetailTimestamp(source.asOf, locale)}</small>}
    </span>
  );
}

function StockDetailEmptyState({ message }: { message: string }) {
  const { t } = useI18n();
  return <div className="stock-detail-empty"><span>{message}</span><small>{t("detail.empty.noInference")}</small></div>;
}

function formatAnalystTarget(value: number | undefined, locale: Locale) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale === "ja" ? "ja-JP" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function AnalystRatingHistoryTable({
  history,
  status,
}: {
  history: AnalystRatingHistory | null;
  status: AnalystHistoryStatus;
}) {
  const { locale, t } = useI18n();
  if (status === "loading") return <div className="analyst-history-state" role="status">{t("detail.analyst.loading")}</div>;
  if (status === "error") return <div className="analyst-history-state is-error" role="alert">{t("detail.analyst.error")}</div>;
  const rows = [...(history?.items ?? [])].sort((left, right) => right.eventTime.localeCompare(left.eventTime));
  if (rows.length === 0) return <div className="analyst-history-state">{t("detail.analyst.empty")}</div>;
  return (
    <div className="analyst-history-table-shell">
      <table className="analyst-rating-history-table">
        <thead><tr><th>{t("detail.analyst.table.date")}</th><th>{t("detail.analyst.table.firm")}</th><th>{t("detail.analyst.table.rating")}</th><th>{t("detail.analyst.table.target")}</th><th>{t("detail.analyst.table.accuracy")}</th></tr></thead>
        <tbody>
          {rows.map((event) => {
            const previousTarget = event.adjustedPreviousPriceTarget ?? event.previousPriceTarget;
            const ratingCurrent = event.ratingCurrent ?? event.rating;
            const ratingChange = [event.ratingPrior, ratingCurrent].filter(Boolean).join(" → ") || "—";
            const targetChange = previousTarget !== undefined
              ? `${formatAnalystTarget(previousTarget, locale)} → ${formatAnalystTarget(event.effectivePriceTarget, locale)}`
              : formatAnalystTarget(event.effectivePriceTarget, locale);
            const success = typeof event.overallSuccessRate === "number"
              ? `${(Math.abs(event.overallSuccessRate) <= 1 ? event.overallSuccessRate * 100 : event.overallSuccessRate).toFixed(1)}%`
              : "—";
            return (
              <tr key={event.eventId}>
                <td><strong>{event.sourceEventDate}</strong><small>{event.actionPriceTarget ?? event.action ?? t("detail.analyst.updated")}</small></td>
                <td><strong>{event.analystFirm ?? "—"}</strong><small>{event.analystName ?? "—"}</small></td>
                <td className={`analyst-change-${analystRatingChangeTone(event)}`}>{ratingChange}</td>
                <td className={`analyst-target-cell analyst-change-${analystTargetChangeTone(event)}`}>{targetChange}</td>
                <td><strong>{event.smartScore !== undefined ? event.smartScore.toFixed(1) : "—"}</strong><small>{success}</small></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function detailEmptyMessage(status: MarketDataStatus, subjectKey: string, t: TranslateMessage) {
  const subject = t(subjectKey);
  if (status === "loading") return t("detail.empty.loading", { subject });
  if (status === "error") return t("detail.empty.error", { subject });
  return t("detail.empty.notProvided", { subject });
}

function MetricSection({
  eyebrow,
  title,
  source,
  metrics,
  context,
  emptyMessage,
  onOpenDetails,
}: {
  eyebrow: string;
  title: string;
  source: StockDetailSource;
  metrics: readonly StockDetailMetric[];
  context?: string;
  emptyMessage: string;
  onOpenDetails?: () => void;
}) {
  const { locale, t } = useI18n();
  const localizedContext = stockDetailContext(context, t);
  return (
    <section className="right-data-section">
      <div className="section-heading compact-heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <strong>{title}</strong>
          {localizedContext && <small className="detail-section-context">{localizedContext}</small>}
        </div>
        <div className="detail-section-actions">
          <DetailSourceChip source={source} />
          {onOpenDetails && metrics.length > 0 && <button type="button" className="text-action" onClick={onOpenDetails}>{t("common.details")}</button>}
        </div>
      </div>
      {metrics.length > 0 ? (
        <div className="detail-metric-grid">
          {metrics.map((metric) => (
            <div className="detail-metric" key={metric.label}>
              <span>{stockDetailMetricLabel(metric.label, t)}</span>
              {metric.href ? (
                <a className="detail-metric-link" href={metric.href} target="_blank" rel="noreferrer">{stockDetailMetricValue(metric, locale, t)}</a>
              ) : (
                <b className={metric.tone === "positive" ? "positive" : metric.tone === "negative" ? "negative-text" : ""}>
                  {stockDetailMetricValue(metric, locale, t)}
                </b>
              )}
              {metric.note && <small>{stockDetailMetricNote(metric.note, t)}</small>}
            </div>
          ))}
        </div>
      ) : <StockDetailEmptyState message={emptyMessage} />}
    </section>
  );
}

const FUNDAMENTAL_GROUP_PRESENTATION: Readonly<Record<FundamentalGroupId, Readonly<{
  eyebrow: string;
  titleKey: string;
}>>> = {
  income_statement: {
    eyebrow: "INCOME STATEMENT",
    titleKey: "detail.section.incomeStatement",
  },
  valuation: {
    eyebrow: "VALUATION",
    titleKey: "detail.section.valuation",
  },
  profitability: {
    eyebrow: "PROFITABILITY",
    titleKey: "detail.section.profitability",
  },
  balance_sheet: {
    eyebrow: "BALANCE SHEET",
    titleKey: "detail.section.balanceSheet",
  },
  cash_flow: {
    eyebrow: "CASH FLOW & DIVIDENDS",
    titleKey: "detail.section.cashFlow",
  },
  per_share: {
    eyebrow: "PER SHARE",
    titleKey: "detail.section.perShare",
  },
};

const FUNDAMENTAL_METRIC_GROUPS = unicornConfig.ui.symbolDetail.fundamentalGroups.map((group) => ({
  ...FUNDAMENTAL_GROUP_PRESENTATION[group.id],
  id: group.id,
  metrics: group.metrics,
}));

function configuredStockDetailMetrics(
  metrics: readonly StockDetailMetric[],
  ids: readonly StockDetailMetricId[],
) {
  const byId = new Map(metrics.map((metric) => [metric.id, metric]));
  return ids.flatMap((id) => {
    const metric = byId.get(id);
    return metric ? [metric] : [];
  });
}

function FundamentalMetricSections({
  metrics,
  source,
  context,
  emptyMessage,
}: {
  metrics: readonly StockDetailMetric[];
  source: StockDetailSource;
  context?: string;
  emptyMessage: string;
}) {
  const { t } = useI18n();
  const configuredGroups = FUNDAMENTAL_METRIC_GROUPS.flatMap((group) => {
    const groupMetrics = configuredStockDetailMetrics(metrics, group.metrics);
    return groupMetrics.length === 0 ? [] : [{ ...group, groupMetrics }];
  });
  if (metrics.length === 0) {
    return <MetricSection eyebrow="FUNDAMENTALS" title={t("detail.section.fundamentals")} source={source} context={context} metrics={metrics} emptyMessage={emptyMessage} />;
  }
  if (configuredGroups.length === 0) return null;
  return (
    <div className="stock-detail-fundamental-groups">
      {configuredGroups.map((group, index) => {
        return <MetricSection key={group.id} eyebrow={group.eyebrow} title={t(group.titleKey)} source={source} context={index === 0 ? context : undefined} metrics={group.groupMetrics} emptyMessage={emptyMessage} />;
      })}
    </div>
  );
}

function compactEarningsValue(value: number, kind: "eps" | "revenue", locale: Locale) {
  const numberLocale = locale === "ja" ? "ja-JP" : "en-US";
  if (kind === "eps") {
    return new Intl.NumberFormat(numberLocale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  }
  return new Intl.NumberFormat(numberLocale, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function EarningsComparisonMetric({
  label,
  kind,
  actual,
  estimate,
}: {
  label: string;
  kind: "eps" | "revenue";
  actual?: number;
  estimate?: number;
}) {
  const { locale, t } = useI18n();
  const validActual = typeof actual === "number" && Number.isFinite(actual);
  const validEstimate = typeof estimate === "number" && Number.isFinite(estimate);
  if (!validActual && !validEstimate) return null;
  const scale = Math.max(Math.abs(actual ?? 0), Math.abs(estimate ?? 0), Number.EPSILON);
  const actualWidth = validActual ? Math.max(6, Math.abs(actual) / scale * 100) : 0;
  const estimateWidth = validEstimate ? Math.max(6, Math.abs(estimate) / scale * 100) : 0;
  const surprise = validActual && validEstimate && estimate !== 0
    ? (actual - estimate) / Math.abs(estimate) * 100
    : null;

  return (
    <div className="earnings-comparison-metric">
      <header>
        <strong>{label}</strong>
        {surprise !== null && <em className={surprise >= 0 ? "positive" : "negative-text"}>{t(surprise >= 0 ? "detail.earnings.beat" : "detail.earnings.miss")} {surprise >= 0 ? "+" : ""}{surprise.toFixed(1)}%</em>}
      </header>
      <div className="earnings-comparison-row actual">
        <span>{t("detail.earnings.actual")}</span><i><b style={{ width: `${actualWidth}%` }} /></i><strong>{validActual ? compactEarningsValue(actual, kind, locale) : "—"}</strong>
      </div>
      <div className="earnings-comparison-row estimate">
        <span>{t("detail.earnings.estimate")}</span><i><b style={{ width: `${estimateWidth}%` }} /></i><strong>{validEstimate ? compactEarningsValue(estimate, kind, locale) : "—"}</strong>
      </div>
    </div>
  );
}

function EarningsSection({
  earnings,
  source,
  emptyMessage,
}: {
  earnings: readonly EarningsEvent[];
  source: StockDetailSource;
  emptyMessage: string;
}) {
  const { t } = useI18n();
  const recentEarnings = [...earnings]
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
    .slice(0, 4);

  return (
    <section className="right-data-section stock-detail-earnings-card">
      <div className="section-heading compact-heading">
        <div><span className="eyebrow">EARNINGS</span><strong>{t("detail.earnings.latestVsEstimate")}</strong></div>
        <DetailSourceChip source={source} />
      </div>
      {recentEarnings.length > 0 ? (
        <div className="earnings-comparison-grid">
          {recentEarnings.map((event) => (
            <article className="earnings-comparison-period" key={`${event.reportDate}-${event.fiscalDateEnding ?? "reported"}`}>
              <header><strong>{event.reportDate}</strong>{event.fiscalDateEnding && <small>FY {event.fiscalDateEnding}</small>}</header>
              <EarningsComparisonMetric label="EPS" kind="eps" actual={event.epsActual} estimate={event.epsEstimate} />
              <EarningsComparisonMetric label={t("detail.earnings.revenue")} kind="revenue" actual={event.revenueActual} estimate={event.revenueEstimate} />
            </article>
          ))}
        </div>
      ) : <StockDetailEmptyState message={emptyMessage} />}
    </section>
  );
}

const STOCK_DETAIL_TAB_LABEL_KEYS: Readonly<Record<SymbolDetailTabId, string>> = {
  financials: "detail.tab.financials",
  analyst: "detail.tab.analyst",
  technicals: "detail.tab.technicals",
};
const STOCK_DETAIL_TABS = unicornConfig.ui.symbolDetail.tabs.map((id) => ({
  id,
  labelKey: STOCK_DETAIL_TAB_LABEL_KEYS[id],
}));
const DEFAULT_STOCK_DETAIL_TAB = unicornConfig.ui.symbolDetail.tabs[0];
type StockDetailTabId = SymbolDetailTabId;

function StockDetailPage({
  stock,
  targetPriceMarketBars,
  earnings,
  analystHistory,
  analystHistoryStatus,
  detail,
  dataStatus,
  workspaceStatus,
  barsStatus,
  watched,
  onBack,
  onToggleWatched,
}: {
  stock: Stock;
  targetPriceMarketBars: readonly MarketBar[];
  earnings: readonly EarningsEvent[];
  analystHistory: AnalystRatingHistory | null;
  analystHistoryStatus: AnalystHistoryStatus;
  detail: StockDetailViewModel;
  dataStatus: MarketDataStatus;
  workspaceStatus: MarketDataStatus;
  barsStatus: MarketDataStatus;
  watched: boolean;
  onBack: () => void;
  onToggleWatched: () => void;
}) {
  const { t } = useI18n();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [tabSelection, setTabSelection] = useState<Readonly<{ ticker: string; tab: StockDetailTabId }>>({ ticker: stock.ticker, tab: DEFAULT_STOCK_DETAIL_TAB });
  const activeSection = tabSelection.ticker === stock.ticker && unicornConfig.ui.symbolDetail.tabs.includes(tabSelection.tab)
    ? tabSelection.tab
    : DEFAULT_STOCK_DETAIL_TAB;
  const identity = detail.identity;
  const quote = detail.quote;
  const identityMeta = [identity?.exchange ?? stock.market, identity?.sector].filter(Boolean).join(" · ");
  const detailStatus = dataStatus === "loading"
    ? t("detail.status.loading")
    : dataStatus === "error"
      ? t("detail.status.partialError")
      : detail.warnings.length > 0
        ? t("detail.status.partialMissing")
        : t("detail.status.ready");

  useEffect(() => {
    titleRef.current?.focus();
  }, [stock.ticker]);

  return (
    <section className="stock-detail-page" aria-label={t("detail.pageAria", { symbol: stock.ticker })}>
      <header className="stock-detail-hero">
        <button type="button" className="stock-detail-back" onClick={onBack}><CaretRight size={15} /> {t("detail.backToChart")}</button>
        <CompanyLogo stock={stock} className="stock-detail-avatar" eager />
        <div className="stock-detail-identity"><span>{identityMeta}</span><h1 ref={titleRef} tabIndex={-1}>{identity?.name ?? stock.name}</h1><small>{identity?.symbol ?? stock.ticker}</small></div>
        {quote ? (
          <div className="stock-detail-quote"><strong>{formatPrice(stock, quote.price)}</strong><span className={quote.changePercent >= 0 ? "positive" : "negative-text"}>{quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)} · {quote.changePercent >= 0 ? "+" : ""}{quote.changePercent.toFixed(2)}%</span><small>{stockDetailMarketState(quote.marketState, t)} · {stockDetailSourceLabel(quote.source.label, t)}</small></div>
        ) : (
          <div className="stock-detail-quote unavailable"><small>{detailEmptyMessage(workspaceStatus, "detail.subject.price", t)}</small></div>
        )}
        <button type="button" className={`stock-detail-watch ${watched ? "watched" : ""}`} onClick={onToggleWatched}><Star size={17} weight={watched ? "fill" : "regular"} /> {t(watched ? "detail.watching" : "detail.watch")}</button>
      </header>
      <nav className="stock-detail-nav" role="tablist" aria-label={t("detail.navAria")}>
        {STOCK_DETAIL_TABS.map(({ id, labelKey }) => <button type="button" role="tab" id={`stock-detail-tab-${id}`} aria-controls={`stock-detail-panel-${id}`} aria-selected={activeSection === id} className={activeSection === id ? "active" : ""} key={id} onClick={() => setTabSelection({ ticker: stock.ticker, tab: id })}>{t(labelKey)}</button>)}
      </nav>
      <div className="stock-detail-body">
        <div className="stock-detail-content stock-detail-content-one-column">
          {activeSection === "financials" && <section className="stock-detail-tab-panel stock-detail-section" id="stock-detail-panel-financials" role="tabpanel" aria-labelledby="stock-detail-tab-financials">
            <header className="stock-detail-section-heading"><div><span className="eyebrow">FUNDAMENTALS & EARNINGS</span><h2>{t("detail.section.financials")}</h2></div></header>
            <FundamentalMetricSections source={detail.fundamentals.source} context={detail.fundamentals.context} metrics={detail.fundamentals.metrics} emptyMessage={detailEmptyMessage(workspaceStatus, "detail.subject.fundamentals", t)} />
            <EarningsActualEstimateChart earnings={earnings} />
            <EarningsSection earnings={earnings} source={detail.earnings.source} emptyMessage={detailEmptyMessage(workspaceStatus, "detail.subject.earnings", t)} />
          </section>}

          {activeSection === "analyst" && <section className="stock-detail-tab-panel stock-detail-section" id="stock-detail-panel-analyst" role="tabpanel" aria-labelledby="stock-detail-tab-analyst">
            <header className="stock-detail-section-heading"><div><span className="eyebrow">ANALYST CONSENSUS</span><h2>{t("detail.section.analyst")}</h2></div></header>
            <AnalystTargetHistoryChart history={analystHistory} marketBars={targetPriceMarketBars} />
            <MetricSection eyebrow="TARGETS & RATINGS" title={t("detail.section.targetRatings")} source={detail.analyst.source} metrics={configuredStockDetailMetrics(detail.analyst.metrics, unicornConfig.ui.symbolDetail.analystMetrics)} emptyMessage={detailEmptyMessage(workspaceStatus, "detail.subject.analyst", t)} />
            <section className="stock-detail-analyst-history" aria-label={t("detail.section.targetHistory")}>
              <header><div><span className="eyebrow">BENZINGA RATINGS</span><h2>{t("detail.section.targetHistory")}</h2></div><small>{analystHistory?.dateFrom ?? ""}{analystHistory?.dateTo ? ` — ${analystHistory.dateTo}` : ""}</small></header>
              <AnalystRatingHistoryTable history={analystHistory} status={analystHistoryStatus} />
            </section>
          </section>}

          {activeSection === "technicals" && <section className="stock-detail-tab-panel stock-detail-section" id="stock-detail-panel-technicals" role="tabpanel" aria-labelledby="stock-detail-tab-technicals">
            <header className="stock-detail-section-heading"><div><span className="eyebrow">MARKET & TECHNICALS</span><h2>{t("detail.section.technicals")}</h2></div></header>
            <div className="stock-detail-card-grid two-columns">
              <MetricSection eyebrow="QUOTE" title={t("detail.section.marketSnapshot")} source={detail.market.source} context={detail.market.context} metrics={configuredStockDetailMetrics(detail.market.metrics, unicornConfig.ui.symbolDetail.marketMetrics)} emptyMessage={detailEmptyMessage(workspaceStatus, "detail.subject.market", t)} />
              <MetricSection eyebrow="CALCULATED FROM OHLCV" title={t("detail.section.technicalMetrics")} source={detail.technicals.source} context={detail.technicals.context} metrics={configuredStockDetailMetrics(detail.technicals.metrics, unicornConfig.ui.symbolDetail.technicalMetrics)} emptyMessage={detailEmptyMessage(barsStatus, "detail.subject.technicals", t)} />
            </div>
          </section>}
        </div>
      </div>
      <footer className={`stock-detail-status ${dataStatus}`}><span><span /> {identity?.exchange ?? stock.market} · {detailStatus}</span><span>{stockDetailSourceLabel(detail.market.source.label, t)}{detail.warnings.length > 0 ? ` · ${t("detail.warningCount", { count: detail.warnings.length })}` : ""}</span></footer>
    </section>
  );
}

function IndicatorsPanel({
  activeIndicators,
  hiddenIndicators,
  indicatorSettings,
  onAdd,
  onToggleVisibility,
  onOpenSettings,
  onRemove,
}: {
  activeIndicators: IndicatorId[];
  hiddenIndicators: IndicatorId[];
  indicatorSettings: Record<IndicatorId, IndicatorSettings>;
  onAdd: () => void;
  onToggleVisibility: (id: IndicatorId) => void;
  onOpenSettings: (id: IndicatorId) => void;
  onRemove: (id: IndicatorId) => void;
}) {
  const { locale } = useI18n();
  const activeDefinitions = INDICATORS.filter((indicator) => activeIndicators.includes(indicator.id));

  return (
    <div className="active-indicator-manager">
      <div className="right-panel-heading library-heading">
        <div><span className="eyebrow">{indicatorText(locale, "objectTree")}</span><strong>{indicatorText(locale, "chartIndicators")}</strong></div>
        <button type="button" className="text-action" onClick={onAdd}><Plus size={13} /> {indicatorText(locale, "add")}</button>
      </div>
      <div className="active-indicator-summary">
        <span>{indicatorAppliedCount(locale, activeDefinitions.length)}</span>
        <small>{indicatorText(locale, "managerHint")}</small>
      </div>
      <div className="active-indicator-list">
        {activeDefinitions.map((indicator) => {
          const hidden = hiddenIndicators.includes(indicator.id);
          const copy = localizeIndicator(locale, indicator);
          return (
            <div className={`active-indicator-manager-row ${hidden ? "is-hidden" : ""}`} key={indicator.id}>
              <span className="indicator-color-dot" style={{ background: indicatorSettings[indicator.id].color }} />
              <span className="active-indicator-copy">
                <strong>{getIndicatorDisplayName(indicator, indicatorSettings[indicator.id])}</strong>
                <small>{copy.name} · {copy.placement}</small>
              </span>
              <div className="indicator-manager-actions">
                <IconButton label={indicatorText(locale, hidden ? "show" : "hide", { name: indicator.shortName })} active={!hidden} onClick={() => onToggleVisibility(indicator.id)}><Eye size={15} /></IconButton>
                <IconButton label={indicatorText(locale, "settings", { name: indicator.shortName })} onClick={() => onOpenSettings(indicator.id)}><Gear size={15} /></IconButton>
                <IconButton label={indicatorText(locale, "remove", { name: indicator.shortName })} onClick={() => onRemove(indicator.id)}><X size={15} /></IconButton>
              </div>
            </div>
          );
        })}
        {activeDefinitions.length === 0 && (
          <div className="empty-indicator-manager">
            <FunctionIcon size={24} />
            <strong>{indicatorText(locale, "emptyTitle")}</strong>
            <span>{indicatorText(locale, "emptyBody")}</span>
            <button type="button" onClick={onAdd}><Plus size={14} /> {indicatorText(locale, "addIndicator")}</button>
          </div>
        )}
      </div>
      <div className="library-note"><FunctionIcon size={15} /><span>{indicatorText(locale, "saveNote")}</span></div>
    </div>
  );
}

function IndicatorLibraryDialog({
  activeIndicators,
  favorites,
  onAdd,
  onToggleFavorite,
  onClose,
}: {
  activeIndicators: IndicatorId[];
  favorites: IndicatorId[];
  onAdd: (id: IndicatorId) => void;
  onToggleFavorite: (id: IndicatorId) => void;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const [query, setQuery] = useState("");
  const [section, setSection] = useState("テクニカル");
  const normalizedQuery = query.trim().toLowerCase();
  const sections = ["お気に入り", "マイスクリプト", "テクニカル", "ファンダメンタルズ", "コミュニティ"];
  const filtered = INDICATORS.filter((indicator) => {
    const copy = localizeIndicator(locale, indicator);
    const sectionMatches = section === "テクニカル"
      || (section === "お気に入り" && favorites.includes(indicator.id));
    return sectionMatches
      && `${indicator.shortName} ${indicator.name} ${indicator.description} ${indicator.category} ${copy.name} ${copy.description} ${copy.category}`.toLowerCase().includes(normalizedQuery);
  });
  const sectionCopy = localizeIndicatorSection(locale, section);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="indicator-dialog" role="dialog" aria-modal="true" aria-label={indicatorText(locale, "libraryTitle")} onMouseDown={(event) => event.stopPropagation()}>
        <header className="indicator-dialog-header">
          <div><FunctionIcon size={19} /><strong>{indicatorText(locale, "libraryTitle")}</strong></div>
          <button type="button" onClick={onClose} aria-label={indicatorText(locale, "close")}><X size={18} /></button>
        </header>
        <div className="indicator-dialog-search">
          <MagnifyingGlass size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={indicatorText(locale, "search")} aria-label={indicatorText(locale, "searchAria")} autoFocus />
          <span>/</span>
        </div>
        <div className="indicator-dialog-body">
          <nav className="indicator-dialog-nav" aria-label={indicatorText(locale, "categoryAria")}>
            {sections.map((item) => (
              <button type="button" key={item} className={section === item ? "active" : ""} onClick={() => setSection(item)}>
                {item === "お気に入り" && <Star size={15} weight="fill" />}
                {item === "テクニカル" && <FunctionIcon size={15} />}
                {item === "ファンダメンタルズ" && <ChartBar size={15} />}
                {item === "コミュニティ" && <UserCircle size={15} />}
                {item === "マイスクリプト" && <PencilLine size={15} />}
                {localizeIndicatorSection(locale, item)}
              </button>
            ))}
          </nav>
          <div className="indicator-dialog-results">
            <div className="indicator-result-heading">
              <div><strong>{sectionCopy}</strong><span>{filtered.length > 0 ? indicatorResultCount(locale, filtered.length) : ""}</span></div>
              <small>{indicatorText(locale, "clickToAdd")}</small>
            </div>
            {filtered.map((indicator) => {
              const active = activeIndicators.includes(indicator.id);
              const favorite = favorites.includes(indicator.id);
              const copy = localizeIndicator(locale, indicator);
              return (
                <div className={`indicator-result-row ${active ? "is-added" : ""}`} key={indicator.id}>
                  <button type="button" className={`favorite-button ${favorite ? "active" : ""}`} aria-label={indicatorText(locale, favorite ? "removeFavorite" : "addFavorite", { name: indicator.shortName })} onClick={() => onToggleFavorite(indicator.id)}><Star size={16} weight={favorite ? "fill" : "regular"} /></button>
                  <button type="button" className="indicator-result-main" onClick={() => onAdd(indicator.id)}>
                    <span className="indicator-result-mark" style={{ background: indicator.color }} />
                    <span><strong>{copy.name}</strong><small>{indicator.shortName} · {copy.category} · {copy.placement}</small></span>
                    <span className="indicator-author">{indicatorText(locale, "builtIns")}</span>
                    {active ? <span className="added-label"><Check size={13} /> {indicatorText(locale, "added")}</span> : <Plus size={16} />}
                  </button>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="indicator-dialog-empty">
                <FunctionIcon size={28} />
                <strong>{indicatorText(locale, "emptySectionTitle", { section: sectionCopy })}</strong>
                <span>{indicatorText(locale, "emptySectionBody")}</span>
                <button type="button" onClick={() => setSection("テクニカル")}>{indicatorText(locale, "showTechnicals")}</button>
              </div>
            )}
          </div>
        </div>
        <footer className="indicator-dialog-footer">
          <span><b>/</b> {indicatorText(locale, "shortcutOpen")}</span>
          <span><b>Esc</b> {indicatorText(locale, "shortcutClose")}</span>
        </footer>
      </section>
    </div>
  );
}

function IndicatorSettingsDialog({
  indicator,
  settings,
  onApply,
  onClose,
}: {
  indicator: IndicatorDefinition;
  settings: IndicatorSettings;
  onApply: (settings: IndicatorSettings) => void;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const [tab, setTab] = useState<IndicatorSettingsTab>("パラメーター");
  const [draft, setDraft] = useState<IndicatorSettings>(() => ({
    ...settings,
    visibility: { ...settings.visibility },
  }));
  const copy = localizeIndicator(locale, indicator);
  const updateNumber = (key: "length" | "offset" | "multiplier" | "fast" | "slow" | "signal" | "smoothing", value: string) => {
    setDraft((current) => ({ ...current, [key]: Number(value) }));
  };
  const usesLength = !["vwap", "macd", "obv"].includes(indicator.id);
  const usesPriceSource = !["atr14", "adx14"].includes(indicator.id);
  const unsupportedSettingsMessage = locale === "ja"
    ? "オフセット、VWAPアンカー、時間足別表示は現在の描画エンジンでは未対応です。"
    : "Offset, VWAP anchors, and interval-specific visibility are not supported by the current renderer.";

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={onClose}>
      <section className="indicator-settings-dialog" role="dialog" aria-modal="true" aria-label={indicatorText(locale, "dialogSettings", { name: copy.name })} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="indicator-settings-color" style={{ background: draft.color }} /><div><strong>{copy.name}</strong><small>{getIndicatorDisplayName(indicator, draft)}</small></div></div>
          <button type="button" onClick={onClose} aria-label={indicatorText(locale, "close")}><X size={18} /></button>
        </header>
        <nav className="settings-tabs" role="tablist">
          {(["パラメーター", "スタイル", "表示"] as IndicatorSettingsTab[]).map((item) => (
            <button type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{indicatorText(locale, item === "パラメーター" ? "tabParameters" : item === "スタイル" ? "tabStyle" : "tabVisibility")}</button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === "パラメーター" && (
            <div className="settings-form-grid">
              {usesLength && <label><span>{indicatorText(locale, "length")}</span><input type="number" min="2" max="500" value={draft.length} onChange={(event) => updateNumber("length", event.target.value)} /></label>}
              {indicator.id === "bollinger" && <label><span>{indicatorText(locale, "standardDeviation")}</span><input type="number" min="0.1" max="10" step="0.1" value={draft.multiplier} onChange={(event) => updateNumber("multiplier", event.target.value)} /></label>}
              {indicator.id === "macd" && <>
                <label><span>{indicatorText(locale, "fast")}</span><input type="number" min="2" max="200" value={draft.fast} onChange={(event) => updateNumber("fast", event.target.value)} /></label>
                <label><span>{indicatorText(locale, "slow")}</span><input type="number" min="3" max="300" value={draft.slow} onChange={(event) => updateNumber("slow", event.target.value)} /></label>
                <label><span>{indicatorText(locale, "signal")}</span><input type="number" min="2" max="100" value={draft.signal} onChange={(event) => updateNumber("signal", event.target.value)} /></label>
              </>}
              {indicator.id === "stochastic" && <>
                <label><span>{indicatorText(locale, "kSmoothing")}</span><input type="number" min="1" max="50" value={draft.smoothing} onChange={(event) => updateNumber("smoothing", event.target.value)} /></label>
                <label><span>{indicatorText(locale, "dLength")}</span><input type="number" min="1" max="50" value={draft.signal} onChange={(event) => updateNumber("signal", event.target.value)} /></label>
              </>}
              {usesPriceSource && <label><span>{indicatorText(locale, "source")}</span><select value={draft.source} onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value as IndicatorSettings["source"] }))}>{["終値", "始値", "高値", "安値", "HL2", "HLC3"].map((item) => <option value={item} key={item}>{localizeIndicatorSource(locale, item)}</option>)}</select></label>}
              {indicator.id === "vwap" && <label><span>{indicatorText(locale, "anchorPeriod")}</span><select value={draft.anchor} disabled>{["セッション", "週", "月", "四半期", "年"].map((item) => <option value={item} key={item}>{localizeIndicatorAnchor(locale, item)}</option>)}</select></label>}
              <label><span>{indicatorText(locale, "offset")}</span><input type="number" min="-100" max="100" value={draft.offset} disabled /></label>
              <p role="note">{unsupportedSettingsMessage}</p>
            </div>
          )}
          {tab === "スタイル" && (
            <div className="settings-form-grid">
              <label className="color-setting"><span>{indicatorText(locale, "lineColor")}</span><span><input type="color" value={draft.color} onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))} /><b>{draft.color.toUpperCase()}</b></span></label>
              <label><span>{indicatorText(locale, "width")}</span><select value={draft.lineWidth} onChange={(event) => setDraft((current) => ({ ...current, lineWidth: Number(event.target.value) as LineWidth }))}>{[1, 2, 3, 4].map((item) => <option value={item} key={item}>{item}px</option>)}</select></label>
              <label><span>{indicatorText(locale, "line")}</span><select value={draft.lineStyle} onChange={(event) => setDraft((current) => ({ ...current, lineStyle: event.target.value as IndicatorLineStyle }))}><option value="solid">{indicatorText(locale, "solid")}</option><option value="dashed">{indicatorText(locale, "dashed")}</option><option value="dotted">{indicatorText(locale, "dotted")}</option></select></label>
              <div className="line-preview"><span style={{ borderColor: draft.color, borderWidth: `${draft.lineWidth}px`, borderStyle: draft.lineStyle === "solid" ? "solid" : draft.lineStyle === "dashed" ? "dashed" : "dotted" }} /></div>
            </div>
          )}
          {tab === "表示" && (
            <div className="visibility-settings">
              <p>{indicatorText(locale, "visibilityHeading")}</p>
              <p role="note">{unsupportedSettingsMessage}</p>
              {([['minutes', 'minute', 'minuteRange'], ['hours', 'hour', 'hourRange'], ['days', 'day', 'dayRange'], ['weeks', 'week', 'weekRange'], ['months', 'month', 'monthRange']] as const).map(([key, labelKey, rangeKey]) => (
                <label key={key}><input type="checkbox" checked={draft.visibility[key]} disabled /><span>{indicatorText(locale, labelKey)}</span><small>{indicatorText(locale, rangeKey)}</small></label>
              ))}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="settings-default" onClick={() => setDraft({ ...DEFAULT_INDICATOR_SETTINGS[indicator.id], visibility: { ...DEFAULT_INDICATOR_SETTINGS[indicator.id].visibility } })}>{indicatorText(locale, "default")}</button>
          <span />
          <button type="button" onClick={onClose}>{indicatorText(locale, "cancel")}</button>
          <button type="button" className="primary-action" onClick={() => onApply(draft)}>{indicatorText(locale, "apply")}</button>
        </footer>
      </section>
    </div>
  );
}

function StrategyHome({
  onOpenChart,
  onAction,
}: {
  onOpenChart: (ticker: string) => void;
  onAction: (message: string) => void;
}) {
  const { locale } = useI18n();
  const st = useMemo(() => createStrategyTranslator(locale), [locale]);
  const baseStrategies = useMemo(() => sampleStrategiesForLocale(locale), [locale]);
  const [strategyPreferences, setStrategyPreferences] = useState<StrategyPreference[] | null>(null);
  const strategies = useMemo(
    () => strategyPreferences === null
      ? []
      : sampleStrategiesForLocale(locale, strategyPreferences),
    [locale, strategyPreferences],
  );
  const [strategyPreferenceStatus, setStrategyPreferenceStatus] = useState<"loading" | "ready" | "error">("loading");
  const [strategyMutationStatus, setStrategyMutationStatus] = useState<"idle" | "saving" | "deleting">("idle");
  const [strategyRefreshVersion, setStrategyRefreshVersion] = useState(0);
  const strategyPreferenceReadControllerRef = useRef<AbortController | null>(null);
  const strategyPreferenceReadEpochRef = useRef(0);
  const [settingsName, setSettingsName] = useState("");
  const [settingsHeadline, setSettingsHeadline] = useState("");
  const [screen, setScreen] = useState<"index" | "detail">("index");
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_SAMPLE_STRATEGY_ID);
  const [tab, setTab] = useState<PortfolioTab>("概要");
  const [chartMode, setChartMode] = useState<"資産額" | "パフォーマンス">("資産額");
  const [period, setPeriod] = useState<"1M" | "3M" | "6M" | "YTD" | "1Y" | "ALL">("YTD");
  const [showSold, setShowSold] = useState(false);
  const [transactionTab, setTransactionTab] = useState<"取引" | "現金">("取引");
  const [analysisPeriod, setAnalysisPeriod] = useState<"TTM" | "2026">("TTM");
  const [transactionsByStrategy, setTransactionsByStrategy] = useState<Record<string, PortfolioTransaction[]>>({});
  const [transactionLoadStatus, setTransactionLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [transactionMutationStatus, setTransactionMutationStatus] = useState<"idle" | "saving" | "error">("idle");
  const [transactionRefreshVersion, setTransactionRefreshVersion] = useState(0);
  const transactionReadControllerRef = useRef<AbortController | null>(null);
  const transactionReadEpochRef = useRef(0);
  const transactionMutationEpochRef = useRef(0);
  const transactionSavingRef = useRef(false);
  const selectedStrategyIdRef = useRef<string>(DEFAULT_SAMPLE_STRATEGY_ID);
  const [dialog, setDialog] = useState<"transaction" | "import" | "settings" | "delete" | "create" | null>(null);
  const [portfolioMenuOpen, setPortfolioMenuOpen] = useState(false);
  const portfolioMenuHostRef = useRef<HTMLDivElement>(null);
  const portfolioMenuBoundaries = useMemo(() => [portfolioMenuHostRef] as const, []);
  useDismissibleLayer({
    open: portfolioMenuOpen,
    boundaryRefs: portfolioMenuBoundaries,
    onDismiss: () => setPortfolioMenuOpen(false),
  });
  const [createMethod, setCreateMethod] = useState<"manual" | "watchlist" | "csv">("manual");
  const [strategyDuration, setStrategyDuration] = useState<StrategyDuration>("1Y");
  const [strategySortKey, setStrategySortKey] = useState<StrategySortKey>("profit");
  const [strategySortDirection, setStrategySortDirection] = useState<"asc" | "desc">("desc");
  const [strategyQuery, setStrategyQuery] = useState("");
  const [strategyCategory, setStrategyCategory] = useState("すべて");
  const [strategyStatus, setStrategyStatus] = useState<"すべて" | "採用済み" | "未採用">("すべて");
  const [transactionTicker, setTransactionTicker] = useState("AAPL");
  const [transactionSide, setTransactionSide] = useState<PortfolioTransaction["side"]>("買付");
  const [transactionShares, setTransactionShares] = useState("10");
  const [transactionPrice, setTransactionPrice] = useState("231.41");
  const activeStrategyDurationLabel = strategyDurationLabel(locale, strategyDuration);
  const selected = strategies.find((strategy) => strategy.id === selectedId) ?? strategies[0] ?? baseStrategies[0];
  const strategyCatalogReady = strategyPreferences !== null;
  const selectedStrategyIsVisible = strategies.some((strategy) => strategy.id === selected.id);
  const transactions = transactionsByStrategy[selected.id] ?? [];
  useEffect(() => {
    selectedStrategyIdRef.current = selected.id;
  }, [selected.id]);
  const selectedCatalogIndex = Math.max(0, baseStrategies.findIndex((strategy) => strategy.id === selected.id));
  const unrealizedGain = PORTFOLIO_HOLDINGS.reduce((sum, holding) => sum + holding.unrealized, 0);
  const { portfolioValue, cards: strategySummaryCards } = buildStrategySummaryMetricRegistry({
    selected,
    selectedCatalogIndex,
    unrealizedGain,
    translate: st,
  });
  const holdingRows = showSold
    ? [...PORTFOLIO_HOLDINGS, { ticker: "META", shares: 0, average: 478.2, value: 0, allocation: 0, daily: 1.12, unrealized: 4832, beta: 1.22, rsi: 53.9, performance1M: 8.1, technicalRating: "買い" as const }]
    : PORTFOLIO_HOLDINGS;
  const durationFactor: Record<StrategyDuration, number> = { "1M": 0.12, "3M": 0.31, "6M": 0.58, "1Y": 1, "3Y": 1.68, "全期間": 2.14 };
  const metricsFor = (strategy: StrategyRecord) => {
    const factor = durationFactor[strategyDuration];
    const profit = strategy.netReturn * factor;
    const maxDrawdown = strategy.maxDrawdown * Math.min(1.22, 0.38 + factor * 0.62);
    const recoveryFactor = Math.abs(maxDrawdown) > 0 ? profit / Math.abs(maxDrawdown) : 0;
    const sharpe = strategy.sharpe === null ? null : strategy.sharpe * (0.84 + Math.min(factor, 1.4) * 0.16);
    const winRate = 50 + (strategy.winRate - 50) * (0.72 + Math.min(factor, 1.2) * 0.28);
    return { profit, maxDrawdown, recoveryFactor, sharpe, winRate };
  };
  const strategyCategories = ["すべて", ...Array.from(new Set(strategies.map((strategy) => strategy.category)))];
  const activeStrategyCategory = strategyCategories.includes(strategyCategory) ? strategyCategory : "すべて";
  const listedStrategies = strategies
    .filter((strategy) => {
      const matchesQuery = `${strategy.name} ${strategy.category} ${strategy.sourceLabels.join(" ")}`.toLowerCase().includes(strategyQuery.toLowerCase());
      const matchesCategory = activeStrategyCategory === "すべて" || strategy.category === activeStrategyCategory;
      const matchesStatus = strategyStatus === "すべて" || (strategyStatus === "採用済み" ? strategy.status === "pinned" : strategy.status !== "pinned");
      return matchesQuery && matchesCategory && matchesStatus;
    })
    .sort((a, b) => {
      if (strategySortKey === "candidateAt") return (a.candidateAt.localeCompare(b.candidateAt)) * (strategySortDirection === "asc" ? 1 : -1);
      const keyMap: Record<Exclude<StrategySortKey, "candidateAt">, keyof ReturnType<typeof metricsFor>> = {
        profit: "profit",
        maxDrawdown: "maxDrawdown",
        recoveryFactor: "recoveryFactor",
        sharpe: "sharpe",
        winRate: "winRate",
      };
      const metricKey = keyMap[strategySortKey];
      const aValue = metricsFor(a)[metricKey] ?? Number.NEGATIVE_INFINITY;
      const bValue = metricsFor(b)[metricKey] ?? Number.NEGATIVE_INFINITY;
      return (Number(aValue) - Number(bValue)) * (strategySortDirection === "asc" ? 1 : -1);
    });
  const profitableCount = listedStrategies.filter((strategy) => metricsFor(strategy).profit > 0).length;
  const averageSharpe = listedStrategies.length
    ? listedStrategies.reduce((sum, strategy) => sum + (metricsFor(strategy).sharpe ?? 0), 0) / listedStrategies.length
    : 0;
  const bestStrategy = [...listedStrategies].sort((a, b) => metricsFor(b).profit - metricsFor(a).profit)[0];

  const applyStrategySort = (key: StrategySortKey) => {
    if (key === strategySortKey) setStrategySortDirection((current) => current === "desc" ? "asc" : "desc");
    else {
      setStrategySortKey(key);
      setStrategySortDirection("desc");
    }
  };

  const selectPortfolio = (id: string) => {
    selectedStrategyIdRef.current = id;
    setTransactionLoadStatus("loading");
    setSelectedId(id);
  };

  const openPortfolio = (id: string) => {
    selectPortfolio(id);
    setTab("概要");
    setScreen("detail");
  };

  const openTransaction = (ticker = "AAPL") => {
    const stock = STOCKS.find((item) => item.ticker === ticker) ?? STOCKS[0];
    setTransactionTicker(ticker);
    setTransactionPrice(String(stock.price));
    setDialog("transaction");
  };

  const upsertStrategyPreference = (preference: StrategyPreference) => {
    setStrategyPreferences((current) => mergeStrategyPreferenceSnapshots(current ?? [], [preference]));
  };

  const invalidateStrategyPreferenceRead = () => {
    strategyPreferenceReadEpochRef.current += 1;
    strategyPreferenceReadControllerRef.current?.abort();
    strategyPreferenceReadControllerRef.current = null;
  };

  const openStrategySettings = () => {
    setSettingsName(selected.name);
    setSettingsHeadline(selected.headline);
    setDialog("settings");
  };

  useEffect(() => {
    const controller = new AbortController();
    strategyPreferenceReadControllerRef.current?.abort();
    strategyPreferenceReadControllerRef.current = controller;
    const requestEpoch = strategyPreferenceReadEpochRef.current + 1;
    strategyPreferenceReadEpochRef.current = requestEpoch;
    void fetch("/api/v1/strategy-preferences", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("strategy preference request failed");
        return response.json() as Promise<StrategyPreferencesResponse>;
      })
      .then((payload) => {
        if (controller.signal.aborted || strategyPreferenceReadEpochRef.current !== requestEpoch) return;
        setStrategyPreferences((current) => current === null
          ? payload.preferences
          : mergeStrategyPreferenceSnapshots(current, payload.preferences));
        const visibleStrategies = sampleStrategiesForLocale("en", payload.preferences);
        setSelectedId((current) => visibleStrategies.some((strategy) => strategy.id === current)
          ? current
          : visibleStrategies[0]?.id ?? DEFAULT_SAMPLE_STRATEGY_ID);
        setStrategyPreferenceStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (strategyPreferenceReadEpochRef.current !== requestEpoch) return;
        setStrategyPreferenceStatus("error");
      });
    return () => {
      controller.abort();
      if (strategyPreferenceReadControllerRef.current === controller) {
        strategyPreferenceReadControllerRef.current = null;
      }
    };
  }, [strategyRefreshVersion]);

  useEffect(() => {
    if (!strategyCatalogReady || !selectedStrategyIsVisible) return;
    const strategyId = selected.id;
    const controller = new AbortController();
    transactionReadControllerRef.current?.abort();
    transactionReadControllerRef.current = controller;
    const requestEpoch = transactionReadEpochRef.current + 1;
    transactionReadEpochRef.current = requestEpoch;
    queueMicrotask(() => {
      if (!controller.signal.aborted && selectedStrategyIdRef.current === strategyId) {
        setTransactionLoadStatus("loading");
      }
    });
    void fetch(`/api/v1/strategy-portfolios/${encodeURIComponent(strategyId)}/transactions`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("strategy transactions request failed");
        return response.json() as Promise<StrategyPortfolioTransactionsResponse>;
      })
      .then((payload) => {
        if (
          controller.signal.aborted
          || transactionReadEpochRef.current !== requestEpoch
          || selectedStrategyIdRef.current !== strategyId
        ) return;
        setTransactionsByStrategy((current) => ({
          ...current,
          [strategyId]: payload.transactions.map(portfolioTransactionFromApi),
        }));
        setTransactionLoadStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (
          transactionReadEpochRef.current !== requestEpoch
          || selectedStrategyIdRef.current !== strategyId
        ) return;
        setTransactionLoadStatus("error");
      });
    return () => {
      controller.abort();
      if (transactionReadControllerRef.current === controller) {
        transactionReadControllerRef.current = null;
      }
    };
  }, [selected.id, selectedStrategyIsVisible, strategyCatalogReady, transactionRefreshVersion]);

  const submitTransaction = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (transactionSavingRef.current) return;
    const shares = Number(transactionShares);
    const price = Number(transactionPrice);
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price < 0) {
      onAction(st("toast.invalidTransaction"));
      return;
    }
    const strategyId = selected.id;
    const transactionId = crypto.randomUUID();
    const mutationEpoch = transactionMutationEpochRef.current + 1;
    transactionMutationEpochRef.current = mutationEpoch;
    transactionSavingRef.current = true;
    transactionReadEpochRef.current += 1;
    transactionReadControllerRef.current?.abort();
    transactionReadControllerRef.current = null;
    setTransactionMutationStatus("saving");
    try {
      const response = await fetch(`/api/v1/strategy-portfolios/${encodeURIComponent(strategyId)}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionId,
          date: new Date().toISOString().slice(0, 10),
          symbol: transactionTicker,
          side: transactionSide === "買付" ? "buy" : transactionSide === "売却" ? "sell" : "dividend",
          shares,
          price,
          fee: 0,
        }),
      });
      if (!response.ok) throw new Error("strategy transaction save failed");
      const payload = await response.json() as StrategyPortfolioTransactionMutationResponse;
      if (transactionMutationEpochRef.current !== mutationEpoch) return;
      const saved = portfolioTransactionFromApi(payload.transaction);
      setTransactionsByStrategy((current) => ({
        ...current,
        [strategyId]: [
          saved,
          ...(current[strategyId] ?? []).filter((item) => item.id !== saved.id),
        ],
      }));
      setTransactionMutationStatus("idle");
      if (selectedStrategyIdRef.current === strategyId) {
        setTransactionRefreshVersion((current) => current + 1);
        setDialog(null);
        setTab("取引");
      }
      onAction(st("toast.transactionSaved", {
        symbol: transactionTicker,
        side: portfolioTransactionSideLabel(locale, transactionSide),
      }));
    } catch {
      if (transactionMutationEpochRef.current !== mutationEpoch) return;
      setTransactionMutationStatus("error");
      if (selectedStrategyIdRef.current === strategyId) {
        setTransactionRefreshVersion((current) => current + 1);
      }
      onAction(st("toast.transactionSaveFailed"));
    } finally {
      if (transactionMutationEpochRef.current === mutationEpoch) {
        transactionSavingRef.current = false;
      }
    }
  };

  const saveStrategySettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = settingsName.trim();
    const headline = settingsHeadline.trim();
    if (!name || !headline || name.length > 120 || headline.length > 500) return;
    const changes: { name?: string; headline?: string } = {};
    if (name !== selected.name) changes.name = name;
    if (headline !== selected.headline) changes.headline = headline;
    if (Object.keys(changes).length === 0) {
      setDialog(null);
      return;
    }

    invalidateStrategyPreferenceRead();
    setStrategyMutationStatus("saving");
    try {
      const response = await fetch(
        `/api/v1/strategy-preferences/${encodeURIComponent(selected.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(changes),
        },
      );
      if (!response.ok) throw new Error("strategy preference save failed");
      const payload = await response.json() as StrategyPreferenceMutationResponse;
      upsertStrategyPreference(payload.preference);
      setStrategyPreferenceStatus("ready");
      setStrategyMutationStatus("idle");
      setDialog(null);
      onAction(st("toast.settingsSaved"));
    } catch {
      setStrategyPreferenceStatus("error");
      setStrategyMutationStatus("idle");
      onAction(st("toast.settingsSaveFailed"));
    }
  };

  const deleteSelectedStrategy = async () => {
    if (strategies.length <= 1) {
      onAction(st("toast.lastStrategyRequired"));
      return;
    }
    const currentIndex = strategies.findIndex((strategy) => strategy.id === selected.id);
    const fallback = strategies[currentIndex + 1] ?? strategies[currentIndex - 1] ?? strategies[0];
    invalidateStrategyPreferenceRead();
    setStrategyMutationStatus("deleting");
    try {
      const response = await fetch(
        `/api/v1/strategy-preferences/${encodeURIComponent(selected.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        if (payload?.error?.code === "last_visible_strategy") {
          onAction(st("toast.lastStrategyRequired"));
          setStrategyMutationStatus("idle");
          return;
        }
        throw new Error("strategy preference delete failed");
      }
      const payload = await response.json() as StrategyPreferenceDeleteResponse;
      upsertStrategyPreference(payload.preference);
      selectPortfolio(fallback.id);
      setTab("概要");
      setScreen("index");
      setDialog(null);
      setStrategyPreferenceStatus("ready");
      setStrategyMutationStatus("idle");
      onAction(st("toast.portfolioDeleted"));
    } catch {
      setStrategyPreferenceStatus("error");
      setStrategyMutationStatus("idle");
      onAction(st("toast.portfolioDeleteFailed"));
    }
  };

  if (screen === "index") {
    return (
      <section className="strategy-home-shell portfolio-index-shell strategy-report-shell" aria-label={st("index.aria")}>
        <header className="portfolio-index-header strategy-report-header">
          <div><span className="eyebrow">{st("index.eyebrow")}</span><h1>{st("index.title")}</h1><p>{st("index.description")}</p></div>
          <div><button type="button" onClick={() => { setStrategyPreferenceStatus("loading"); setStrategyRefreshVersion((current) => current + 1); onAction(st("toast.strategyRefreshed")); }}><ClockCounterClockwise size={15} /> {st("action.refresh")}</button><button type="button" className="primary-action" disabled={!strategyCatalogReady} onClick={() => { setCreateMethod("manual"); setDialog("create"); }}><Plus size={16} /> {st("action.addStrategy")}</button></div>
        </header>
        <div className="portfolio-index-content strategy-report-content">
          <section className="strategy-report-kpis" aria-label={st("summary.aria")}>
            <div><span>{st("summary.visible")}</span><strong>{listedStrategies.length}</strong><small>{st("summary.total", { count: strategies.length })}</small></div>
            <div><span>{st("summary.profitable")}</span><strong>{profitableCount} / {listedStrategies.length}</strong><small>{st("summary.periodEvaluation", { period: activeStrategyDurationLabel })}</small></div>
            <div><span>{st("summary.bestProfit")}</span><strong className="positive">{bestStrategy ? `+${metricsFor(bestStrategy).profit.toFixed(1)}%` : "—"}</strong><small>{bestStrategy?.name ?? st("common.none")}</small></div>
            <div><span>{st("summary.averageSharpe")}</span><strong>{averageSharpe.toFixed(2)}</strong><small>{st("summary.visibleSubset")}</small></div>
          </section>

          <section className="strategy-report-toolbar" aria-label={st("filter.aria")}>
            <label className="strategy-search-field"><MagnifyingGlass size={15} /><input value={strategyQuery} onChange={(event) => setStrategyQuery(event.target.value)} placeholder={st("filter.placeholder")} /><span>{st("common.count", { count: listedStrategies.length })}</span></label>
            <label><span>{st("filter.duration")}</span><select value={strategyDuration} onChange={(event) => setStrategyDuration(event.target.value as StrategyDuration)}>{(["1M", "3M", "6M", "1Y", "3Y", "全期間"] as StrategyDuration[]).map((item) => <option value={item} key={item}>{strategyDurationLabel(locale, item)}</option>)}</select></label>
            <label><span>{st("filter.category")}</span><select value={activeStrategyCategory} onChange={(event) => setStrategyCategory(event.target.value)}>{strategyCategories.map((item) => <option value={item} key={item}>{item === "すべて" ? st("filter.all") : item}</option>)}</select></label>
            <label><span>{st("filter.adoption")}</span><select value={strategyStatus} onChange={(event) => setStrategyStatus(event.target.value as typeof strategyStatus)}><option value="すべて">{st("filter.all")}</option><option value="採用済み">{st("filter.adopted")}</option><option value="未採用">{st("filter.notAdopted")}</option></select></label>
            <button type="button" onClick={() => { setStrategyQuery(""); setStrategyCategory("すべて"); setStrategyStatus("すべて"); setStrategyDuration("1Y"); setStrategySortKey("profit"); setStrategySortDirection("desc"); }}>{st("filter.reset")}</button>
          </section>

          <div className="strategy-report-table-scroll">
            <table className="strategy-report-table" aria-label={st("table.aria")}>
              <thead><tr>
                <th aria-sort={strategySortKey === "candidateAt" ? (strategySortDirection === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => applyStrategySort("candidateAt")}>{st("table.candidateAt")} <CaretDown size={11} /></button></th>
                <th>{st("table.category")}</th>
                <th>{st("table.strategy")}</th>
                <th aria-sort={strategySortKey === "profit" ? (strategySortDirection === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => applyStrategySort("profit")}>{st("table.profit", { period: activeStrategyDurationLabel })} <CaretDown size={11} /></button></th>
                <th aria-sort={strategySortKey === "maxDrawdown" ? (strategySortDirection === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => applyStrategySort("maxDrawdown")}>{st("table.maxDrawdown", { period: activeStrategyDurationLabel })} <CaretDown size={11} /></button></th>
                <th aria-sort={strategySortKey === "recoveryFactor" ? (strategySortDirection === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => applyStrategySort("recoveryFactor")}>{st("table.recoveryFactor", { period: activeStrategyDurationLabel })} <CaretDown size={11} /></button></th>
                <th aria-sort={strategySortKey === "sharpe" ? (strategySortDirection === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => applyStrategySort("sharpe")}>{st("table.sharpe", { period: activeStrategyDurationLabel })} <CaretDown size={11} /></button></th>
                <th>{st("table.audit")}</th>
                <th>{st("table.custom")}</th>
                <th aria-sort={strategySortKey === "winRate" ? (strategySortDirection === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => applyStrategySort("winRate")}>{st("table.winRate", { period: activeStrategyDurationLabel })} <CaretDown size={11} /></button></th>
              </tr></thead>
              <tbody>
                {listedStrategies.map((strategy) => {
                  const metric = metricsFor(strategy);
                  const riskTone = (score: number) => score >= 65 ? "high" : score >= 40 ? "medium" : "low";
                  return <tr key={strategy.id}>
                    <td><span className="candidate-date">{strategy.candidateAt.split(" ")[0]}<small>{strategy.candidateAt.split(" ")[1]}</small></span></td>
                    <td><span className="strategy-category">{strategy.category}</span><span className="strategy-source-tags">{strategy.sourceLabels.map((label) => <i key={label}>{label}</i>)}</span></td>
                    <td><button type="button" className="strategy-name-cell" onClick={() => openPortfolio(strategy.id)}><span><strong>{strategy.name}</strong><small>{strategy.headline}</small></span><span className="strategy-name-badges"><i className="strategy-sample-badge">{st("sample.badge")}</i><i className={`strategy-status ${strategy.status}`}>{strategy.status === "pinned" ? st("filter.adopted") : st("filter.notAdopted")}</i><i>{st("table.symbolCount", { count: strategy.symbols })}</i><i>{st("table.tradeCount", { count: strategy.trades })}</i></span><CaretRight size={15} /></button></td>
                    <td className={metric.profit >= 0 ? "positive" : "negative-text"}><strong>{metric.profit >= 0 ? "+" : ""}{metric.profit.toFixed(1)}%</strong></td>
                    <td className="negative-text"><strong>{metric.maxDrawdown.toFixed(1)}%</strong></td>
                    <td><strong>{metric.recoveryFactor.toFixed(2)}</strong></td>
                    <td><strong>{metric.sharpe?.toFixed(2) ?? "—"}</strong></td>
                    <td><div className="strategy-audit-cell"><span>{strategy.audit.overfit === null ? <i>{st("audit.overfitNotEvaluated")}</i> : <i className={riskTone(strategy.audit.overfit)}>{st("audit.overfit", { score: strategy.audit.overfit })}</i>}{strategy.audit.leakage === null ? <i>{st("audit.leakageNotEvaluated")}</i> : <i className={riskTone(strategy.audit.leakage)}>{st("audit.leakage", { score: strategy.audit.leakage })}</i>}</span><small>{strategy.audit.verdict}</small></div></td>
                    <td><div className="strategy-custom-cell"><strong className={strategy.forwardReturn >= 0 ? "positive" : "negative-text"}>{strategy.forwardReturn >= 0 ? "+" : ""}{strategy.forwardReturn.toFixed(1)}%</strong><small>{st("sample.illustrative")}</small></div></td>
                    <td><strong>{metric.winRate.toFixed(1)}%</strong></td>
                  </tr>;
                })}
              </tbody>
            </table>
            {listedStrategies.length === 0 && <div className="strategy-report-empty"><MagnifyingGlass size={24} /><strong>{st("empty.title")}</strong><span>{st("empty.description")}</span></div>}
          </div>
        </div>
        <footer className="strategy-status-bar"><span><span /> {st("status.preferences", { status: strategyPreferenceStatus === "ready" ? st("common.connected") : strategyPreferenceStatus === "error" ? st("common.error") : st("common.loading") })}</span><span>{st("status.mockDisclaimer")}</span></footer>
        {dialog === "create" && (
          <DialogShell title={st("create.title")} eyebrow="STEP 1 / 3" onClose={() => setDialog(null)}>
            <div className="dialog-body portfolio-create-dialog">
              <div className="segmented-control three">
                {(["manual", "csv", "watchlist"] as const).map((method) => <button type="button" key={method} className={createMethod === method ? "active" : ""} onClick={() => setCreateMethod(method)}>{st(method === "manual" ? "create.manual" : method === "csv" ? "create.csv" : "create.watchlist")}</button>)}
              </div>
              {createMethod === "csv" ? <label className="file-drop"><UploadSimple size={24} /><strong>{st("create.chooseCsv")}</strong><span>{st("create.csvRequirements")}</span><input type="file" accept=".csv" /></label> : <div className="dialog-form-grid"><label><span>{st("create.portfolioName")}</span><input defaultValue={st(createMethod === "watchlist" ? "create.mainWatchName" : "create.newPortfolioName")} /></label><label><span>{st("create.baseCurrency")}</span><select defaultValue="USD"><option>USD</option><option>JPY</option></select></label>{createMethod === "watchlist" && <label className="check-line"><input type="checkbox" defaultChecked /> {st("create.addWatchlistSymbols", { count: 5 })}</label>}</div>}
            </div>
            <footer className="dialog-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="button" className="primary-action" onClick={() => { setDialog(null); openPortfolio(DEFAULT_SAMPLE_STRATEGY_ID); onAction(st("toast.portfolioCreated")); }}>{st("common.continue")}</button></footer>
          </DialogShell>
        )}
      </section>
    );
  }

  return (
    <section className="strategy-home-shell portfolio-detail-shell" aria-label={st("detail.aria")}>
      <header className="portfolio-detail-header">
        <button type="button" className="back-to-portfolios" onClick={() => setScreen("index")}><CaretRight size={15} /> {st("detail.back")}</button>
        <div className="portfolio-title-block"><select aria-label={st("detail.selectPortfolio")} value={selected.id} onChange={(event) => selectPortfolio(event.target.value)}>{strategies.map((strategy) => <option value={strategy.id} key={strategy.id}>{strategy.name}</option>)}</select><span>{selected.headline}</span></div>
        <div className="portfolio-header-actions">
          <button type="button" className="primary-action" onClick={() => openTransaction()}><Plus size={16} /> {st("detail.addTransaction")}</button>
          <div className="portfolio-menu-host" ref={portfolioMenuHostRef}><IconButton label={st("detail.portfolioMenu")} hasPopup="menu" expanded={portfolioMenuOpen} controls="portfolio-actions-menu" onClick={() => setPortfolioMenuOpen((value) => !value)}><DotsThree size={19} /></IconButton>{portfolioMenuOpen && <div id="portfolio-actions-menu" className="portfolio-menu" role="menu"><button type="button" onClick={() => { setPortfolioMenuOpen(false); openStrategySettings(); }}><Gear size={15} /> {st("detail.editStrategy")}</button><button type="button" onClick={() => { setPortfolioMenuOpen(false); onAction(st("toast.portfolioDuplicated")); }}><Copy size={15} /> {st("common.duplicate")}</button><button type="button" className="danger" disabled={strategies.length <= 1} onClick={() => { setPortfolioMenuOpen(false); setDialog("delete"); }}><Trash size={15} /> {st("common.delete")}</button></div>}</div>
        </div>
      </header>
      <div className="portfolio-detail-scroll">
        <div className="portfolio-tip"><Lightning size={18} /><div><strong>{st("tip.title")}</strong><span>{st("tip.description")}</span></div><button type="button" onClick={() => setTab("概要")}>{st("tip.viewOverview")} <CaretRight size={14} /></button></div>
        <section className="portfolio-summary-cards" aria-label={st("portfolio.summaryAria")}>
          {unicornConfig.ui.strategyDetail.summaryMetrics.map((id) => {
            const metric = strategySummaryCards[id];
            return <div key={id} data-metric-id={id}><span>{metric.label}</span><strong className={metric.tone}>{metric.value}</strong><small className={metric.tone}>{metric.note}</small></div>;
          })}
        </section>
        <nav className="portfolio-primary-tabs" role="tablist" aria-label={st("portfolio.viewAria")}>
          {(["概要", "保有銘柄", "取引"] as PortfolioTab[]).map((item) => <button type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{portfolioTabLabel(locale, item)}</button>)}
        </nav>

        {tab === "概要" && <div className="portfolio-tab-panel overview-panel" role="tabpanel">
          <section className="portfolio-main-card portfolio-change-card">
            <header><div><h2>{st("chart.portfolioTrend")}</h2><span><i className="legend-dot portfolio-dot" /> Portfolio <i className="legend-dot benchmark-dot" /> S&P 500</span></div><div className="portfolio-chart-controls"><div className="segmented-control">{(["資産額", "パフォーマンス"] as const).map((item) => <button type="button" className={chartMode === item ? "active" : ""} onClick={() => setChartMode(item)} key={item}>{portfolioChartModeLabel(locale, item)}</button>)}</div><div className="period-control">{(["1M", "3M", "6M", "YTD", "1Y", "ALL"] as const).map((item) => <button type="button" className={period === item ? "active" : ""} onClick={() => setPeriod(item)} key={item}>{item}</button>)}</div></div></header>
            <PortfolioValueChart
              mode={chartMode}
              period={period}
              seed={selectedCatalogIndex + 2}
              ariaLabel={`${st("chart.portfolioTrend")} · ${portfolioChartModeLabel(locale, chartMode)}`}
            />
          </section>
          <div className="portfolio-overview-grid">
            <section className="portfolio-main-card"><header><div><h2>{st("allocation.title")}</h2><span>{st("allocation.subtitle")}</span></div><ChartPieSlice size={18} /></header><div className="allocation-list">{PORTFOLIO_HOLDINGS.map((holding) => <button type="button" key={holding.ticker} onClick={() => onOpenChart(holding.ticker)}><span><i style={{ background: holding.daily >= 0 ? "#2962ff" : "#8b7cff" }} />{holding.ticker}</span><span>{holding.allocation.toFixed(1)}%</span><strong>${holding.value.toLocaleString("en-US")}</strong></button>)}</div></section>
            <section className="portfolio-main-card"><header><div><h2>{st("movers.title")}</h2><span>{st("movers.subtitle")}</span></div><ChartLineUp size={18} /></header><div className="movers-list">{[...PORTFOLIO_HOLDINGS].sort((a, b) => b.daily - a.daily).map((holding) => { const holdingStock = STOCKS.find((item) => item.ticker === holding.ticker) ?? STOCKS[0]; return <button type="button" key={holding.ticker} onClick={() => onOpenChart(holding.ticker)}><CompanyLogo stock={holdingStock} /><span><strong>{holding.ticker}</strong><small>{holdingStock.name}</small></span><b className={holding.daily >= 0 ? "positive" : "negative-text"}>{holding.daily >= 0 ? "+" : ""}{holding.daily.toFixed(2)}%</b></button>; })}</div></section>
          </div>
          <section className="portfolio-main-card profitability-card" id="portfolio-profitability"><header><div><h2>{st("profitability.title")}</h2><span>{st("profitability.subtitle")}</span></div><div className="segmented-control">{(["TTM", "2026"] as const).map((item) => <button type="button" className={analysisPeriod === item ? "active" : ""} onClick={() => setAnalysisPeriod(item)} key={item}>{item}</button>)}</div></header><PortfolioProfitChart seed={selectedCatalogIndex + (analysisPeriod === "TTM" ? 4 : 8)} ariaLabel={st("profitability.title")} /></section>
          <section className="portfolio-main-card contribution-card"><header><div><h2>{st("contribution.title")}</h2><span>{st("contribution.subtitle")}</span></div></header>{PORTFOLIO_HOLDINGS.map((holding) => <button type="button" key={holding.ticker} onClick={() => onOpenChart(holding.ticker)}><span><strong>{holding.ticker}</strong><small>{st("contribution.allocation", { value: holding.allocation.toFixed(1) })}</small></span><span className="contribution-track"><i style={{ width: `${Math.min(100, Math.abs(holding.unrealized) / 140)}%` }} /></span><b className={holding.unrealized >= 0 ? "positive" : "negative-text"}>{holding.unrealized >= 0 ? "+" : "-"}${Math.abs(holding.unrealized).toLocaleString("en-US")}</b></button>)}</section>
        </div>}

        {tab === "保有銘柄" && <div className="portfolio-tab-panel holdings-panel" role="tabpanel">
          <div className="portfolio-table-title"><div><h2>{st("holdings.title")}</h2><span>{st("holdings.summary", { count: holdingRows.length, value: `$${PORTFOLIO_HOLDINGS.reduce((sum, item) => sum + item.value, 0).toLocaleString("en-US")}` })}</span></div><div><label className="toggle-label"><input type="checkbox" checked={showSold} onChange={(event) => setShowSold(event.target.checked)} />{st("holdings.showSold")}</label></div></div>
          <div className="portfolio-table-scroll holdings-table-scroll"><table className="holdings-data-table" aria-label={st("holdings.aria")}><thead><tr><th>{st("holdings.symbol")}</th><th>{st("holdings.shares")}</th><th>{st("holdings.averageCost")}</th><th>{st("holdings.currentPrice")}</th><th>{st("holdings.currentValue")}</th><th>{st("holdings.allocation")}</th><th>{st("holdings.unrealized")}</th><th>{st("holdings.daily")}</th><th>{st("holdings.marketCap")}</th><th>PER</th><th>{st("holdings.oneMonth")}</th><th>Beta</th><th>RSI 14</th><th>{st("holdings.technical")}</th><th aria-label={st("holdings.actions")} /></tr></thead><tbody>{holdingRows.map((holding) => { const stock = STOCKS.find((item) => item.ticker === holding.ticker) ?? { ...STOCKS[0], ticker: holding.ticker, name: holding.ticker, logoFallback: holding.ticker.slice(0, 2), logoPath: "" }; const technicalTone = holding.technicalRating.includes("買い") ? "positive" : holding.technicalRating.includes("売り") ? "negative-text" : ""; return <tr key={holding.ticker}><td><button type="button" className="holding-symbol" onClick={() => onOpenChart(holding.ticker)}><CompanyLogo stock={stock} /><span><strong>{holding.ticker}</strong><small>{stock.name}</small></span></button></td><td>{holding.shares.toLocaleString("en-US")}</td><td>{formatPrice(stock, holding.average)}</td><td>{formatPrice(stock, stock.price)}</td><td>${holding.value.toLocaleString("en-US")}</td><td>{holding.allocation.toFixed(1)}%</td><td className={holding.unrealized >= 0 ? "positive" : "negative-text"}>{holding.unrealized >= 0 ? "+" : "-"}${Math.abs(holding.unrealized).toLocaleString("en-US")}</td><td className={holding.daily >= 0 ? "positive" : "negative-text"}>{holding.daily >= 0 ? "+" : ""}{holding.daily.toFixed(2)}%</td><td>{stock.marketCap}</td><td>{stock.pe}</td><td className={holding.performance1M >= 0 ? "positive" : "negative-text"}>{holding.performance1M >= 0 ? "+" : ""}{holding.performance1M.toFixed(1)}%</td><td>{holding.beta.toFixed(2)}</td><td>{holding.rsi.toFixed(1)}</td><td><span className={`technical-rating ${technicalTone}`}>{strategyTechnicalRatingLabel(locale, holding.technicalRating)}</span></td><td><IconButton label={st("holdings.transactionMenu", { symbol: holding.ticker })} onClick={() => openTransaction(holding.ticker)}><DotsThree size={17} /></IconButton></td></tr>; })}</tbody></table></div>
        </div>}

        {tab === "取引" && <div className="portfolio-tab-panel transactions-panel" role="tabpanel">
          <div className="portfolio-table-title"><div><h2>{st("transactions.title")}</h2><span>{transactionLoadStatus === "loading" ? st("transactions.loading") : st("common.count", { count: transactions.length })} · {transactionMutationStatus === "saving" ? st("transactions.saving") : transactionLoadStatus === "error" || transactionMutationStatus === "error" ? st("transactions.saveError") : st("transactions.savedToD1")}</span></div><div className="transaction-actions"><div className="segmented-control">{(["取引", "現金"] as const).map((item) => <button type="button" className={transactionTab === item ? "active" : ""} onClick={() => setTransactionTab(item)} key={item}>{portfolioTransactionTabLabel(locale, item)}</button>)}</div><button type="button" onClick={() => setDialog("import")}><DownloadSimple size={15} /> {st("transactions.import")}</button><button type="button" onClick={() => onAction(st("toast.transactionsExported"))}><UploadSimple size={15} /> {st("transactions.export")}</button><button type="button" className="primary-action" onClick={() => openTransaction()}><Plus size={15} /> {st("detail.addTransaction")}</button></div></div>
          {transactionTab === "取引" ? <div className="portfolio-table-scroll"><div className="transactions-table" role="table" aria-label={st("transactions.aria")}><div className="transactions-row transactions-head"><span>{st("transactions.date")}</span><span>{st("transactions.symbol")}</span><span>{st("transactions.type")}</span><span>{st("transactions.quantity")}</span><span>{st("transactions.price")}</span><span>{st("transactions.fee")}</span><span>{st("transactions.total")}</span><span /></div>{transactions.map((transaction) => <button type="button" className="transactions-row" key={transaction.id} onClick={() => openTransaction(transaction.ticker)}><span>{transaction.date}</span><span><b>{transaction.ticker}</b></span><span><i className={`transaction-side ${transaction.side}`}>{portfolioTransactionSideLabel(locale, transaction.side)}</i></span><span>{transaction.shares.toLocaleString("en-US")}</span><span>${transaction.price.toLocaleString("en-US")}</span><span>${transaction.fee.toFixed(2)}</span><span>${(transaction.shares * transaction.price).toLocaleString("en-US", { maximumFractionDigits: 0 })}</span><CaretRight size={14} /></button>)}</div></div> : <div className="cash-ledger"><Wallet size={26} /><h3>{st("transactions.cashBalance", { value: `$${Math.round(portfolioValue * selected.cash / 100).toLocaleString("en-US")}` })}</h3><p>{st("transactions.cashDescription")}</p><button type="button" onClick={() => { setTransactionSide("配当"); openTransaction(); }}>{st("transactions.addCash")}</button></div>}
        </div>}

      </div>
      <footer className="strategy-status-bar"><span><span /> {st("status.transactions", { status: transactionLoadStatus === "error" || transactionMutationStatus === "error" ? st("common.error") : transactionLoadStatus === "loading" ? st("common.loading") : st("common.connected") })}</span><span>{st("status.backtestForward")}</span><span>{st("status.strategyDisclaimer")}</span></footer>

      {dialog === "transaction" && <DialogShell title={st("transaction.dialogTitle")} eyebrow={selected.name} onClose={() => setDialog(null)}><form className="dialog-body dialog-form-grid" onSubmit={submitTransaction}><label><span>{st("transaction.symbol")}</span><select value={transactionTicker} onChange={(event) => { setTransactionTicker(event.target.value); const next = STOCKS.find((item) => item.ticker === event.target.value); if (next) setTransactionPrice(String(next.price)); }}>{STOCKS.map((item) => <option value={item.ticker} key={item.ticker}>{item.ticker} · {item.name}</option>)}</select></label><label><span>{st("transaction.type")}</span><select value={transactionSide} onChange={(event) => setTransactionSide(event.target.value as PortfolioTransaction["side"])}><option value="買付">{st("transaction.buy")}</option><option value="売却">{st("transaction.sell")}</option><option value="配当">{st("transaction.dividend")}</option></select></label><label><span>{st("transaction.quantity")}</span><input type="number" min="0.01" step="0.01" value={transactionShares} onChange={(event) => setTransactionShares(event.target.value)} /></label><label><span>{st("transaction.price")}</span><input type="number" min="0" step="0.01" value={transactionPrice} onChange={(event) => setTransactionPrice(event.target.value)} /></label><footer className="dialog-actions form-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="submit" className="primary-action" disabled={transactionMutationStatus === "saving"}>{transactionMutationStatus === "saving" ? st("transaction.saving") : st("transaction.save")}</button></footer></form></DialogShell>}
      {dialog === "import" && <DialogShell title={st("import.title")} eyebrow="CSV IMPORT" onClose={() => setDialog(null)}><div className="dialog-body"><label className="file-drop"><UploadSimple size={24} /><strong>{st("import.dropCsv")}</strong><span>{st("import.description")}</span><input type="file" accept=".csv" /></label></div><footer className="dialog-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="button" className="primary-action" onClick={() => { setDialog(null); onAction(st("toast.transactionsImported", { count: 5 })); }}>{st("import.action")}</button></footer></DialogShell>}
      {dialog === "settings" && <DialogShell title={st("settings.title")} eyebrow="STRATEGY SETTINGS" onClose={() => setDialog(null)}><form className="dialog-body dialog-form-grid" onSubmit={saveStrategySettings}><label><span>{st("settings.name")}</span><input value={settingsName} required maxLength={120} onChange={(event) => setSettingsName(event.target.value)} autoFocus /></label><label><span>{st("settings.description")}</span><textarea value={settingsHeadline} required maxLength={500} onChange={(event) => setSettingsHeadline(event.target.value)} /></label><footer className="dialog-actions form-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="submit" className="primary-action" disabled={strategyMutationStatus !== "idle" || !settingsName.trim() || !settingsHeadline.trim()}>{strategyMutationStatus === "saving" ? st("settings.saving") : st("common.save")}</button></footer></form></DialogShell>}
      {dialog === "delete" && <DialogShell title={st("delete.title")} eyebrow={st("delete.confirm")} onClose={() => setDialog(null)}><div className="dialog-body confirm-copy"><Trash size={28} /><p>{st("delete.description", { name: selected.name })}</p></div><footer className="dialog-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="button" className="danger-action" disabled={strategyMutationStatus !== "idle" || strategies.length <= 1} onClick={() => { void deleteSelectedStrategy(); }}>{strategyMutationStatus === "deleting" ? st("delete.deleting") : st("common.delete")}</button></footer></DialogShell>}
    </section>
  );
}

function WatchlistPanel({
  selectedTicker,
  onSelect,
  stocks,
  onAdd,
  onCreate,
  onRename,
  onDeleteWatchlist,
  watchlists,
  activeWatchlistId,
  onSelectWatchlist,
  onDelete,
  persistenceStatus,
  afterHours,
}: {
  selectedTicker: string;
  onSelect: (ticker: string) => void;
  stocks: Stock[];
  onAdd: () => void;
  onCreate: () => void;
  onRename: () => void;
  onDeleteWatchlist: () => void;
  watchlists: readonly Watchlist[];
  activeWatchlistId: string;
  onSelectWatchlist: (watchlistId: string) => void;
  onDelete: (ticker: string) => void | Promise<void>;
  persistenceStatus: "loading" | "ready" | "saving" | "error";
  afterHours: Readonly<Record<string, SyntheticLatestClose>>;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<"lists" | "more" | null>(null);
  const [sort, setSort] = useState<"manual" | "ticker" | "change">("manual");
  const [rowContextMenu, setRowContextMenu] = useState<{
    ticker: string;
    left: number;
    top: number;
  } | null>(null);
  const rowContextMenuRef = useRef<HTMLDivElement>(null);
  const rowContextActionRef = useRef<HTMLButtonElement>(null);
  const rowContextTriggerRef = useRef<HTMLButtonElement | null>(null);
  const listsMenuHostRef = useRef<HTMLDivElement>(null);
  const moreMenuHostRef = useRef<HTMLDivElement>(null);
  const listsMenuBoundaries = useMemo(() => [listsMenuHostRef] as const, []);
  const moreMenuBoundaries = useMemo(() => [moreMenuHostRef] as const, []);
  const rowContextMenuBoundaries = useMemo(() => [rowContextMenuRef] as const, []);
  const activeWatchlist = watchlists.find((watchlist) => watchlist.id === activeWatchlistId) ?? watchlists[0];
  const sortedStocks = [...stocks].sort((a, b) => sort === "ticker" ? a.ticker.localeCompare(b.ticker) : sort === "change" ? b.change - a.change : 0);

  const openRowContextMenu = useCallback((ticker: string, trigger: HTMLButtonElement, left: number, top: number) => {
    const menuWidth = 176;
    const menuHeight = 52;
    rowContextTriggerRef.current = trigger;
    setMenu(null);
    setRowContextMenu({
      ticker,
      left: Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - menuHeight - 8)),
    });
  }, []);

  useDismissibleLayer({
    open: menu === "lists",
    boundaryRefs: listsMenuBoundaries,
    onDismiss: () => setMenu(null),
  });
  useDismissibleLayer({
    open: menu === "more",
    boundaryRefs: moreMenuBoundaries,
    onDismiss: () => setMenu(null),
  });
  useDismissibleLayer({
    open: rowContextMenu !== null,
    boundaryRefs: rowContextMenuBoundaries,
    onDismiss: () => setRowContextMenu(null),
    restoreFocusRef: rowContextTriggerRef,
  });

  useEffect(() => {
    if (rowContextMenu) rowContextActionRef.current?.focus();
  }, [rowContextMenu]);

  return (
    <div className="watchlist-panel">
      <div className="right-panel-heading">
        <div className="watch-menu-host" ref={listsMenuHostRef}><button type="button" className="panel-title-button" aria-haspopup="menu" aria-expanded={menu === "lists"} aria-controls="watchlist-selector-menu" onClick={() => setMenu((current) => current === "lists" ? null : "lists")}>
          {activeWatchlist?.name ?? t("watchlist.defaultName")} <CaretDown size={13} weight="bold" />
        </button>{menu === "lists" && <div id="watchlist-selector-menu" className="watch-popover" role="menu">{watchlists.map((watchlist) => <button type="button" className={activeWatchlist?.id === watchlist.id ? "active" : ""} onClick={() => { onSelectWatchlist(watchlist.id); setMenu(null); }} key={watchlist.id}>{activeWatchlist?.id === watchlist.id && <Check size={13} />}{watchlist.name}<small>{watchlist.items.length}</small></button>)}<button type="button" onClick={() => { setMenu(null); onCreate(); }}><Plus size={13} />{t("watchlist.newList")}</button></div>}</div>
        <div className="heading-actions">
          <span className={`watch-save-state ${persistenceStatus}`} aria-live="polite">{t(`watchlist.status.${persistenceStatus === "ready" ? "saved" : persistenceStatus}`)}</span>
          <IconButton label={t("watchlist.addSymbol")} onClick={onAdd}><Plus size={17} /></IconButton>
          <div className="watch-menu-host" ref={moreMenuHostRef}><IconButton label={t("watchlist.more")} hasPopup="menu" expanded={menu === "more"} controls="watchlist-options-menu" onClick={() => setMenu((current) => current === "more" ? null : "more")}><DotsThree size={18} /></IconButton>{menu === "more" && <div id="watchlist-options-menu" className="watch-popover align-right" role="menu"><span>{t("watchlist.sort")}</span>{[["manual", "watchlist.sort.manual"], ["ticker", "watchlist.sort.ticker"], ["change", "watchlist.sort.change"]].map(([value, labelKey]) => <button type="button" className={sort === value ? "active" : ""} key={value} onClick={() => { setSort(value as typeof sort); setMenu(null); }}>{sort === value && <Check size={13} />}{t(labelKey)}</button>)}<button type="button" role="menuitem" disabled={!activeWatchlist || persistenceStatus === "saving"} onClick={() => { setMenu(null); onRename(); }}><PencilLine size={13} />{t("watchlist.rename")}</button><button type="button" role="menuitem" onClick={() => { setMenu(null); onCreate(); }}><Plus size={13} />{t("watchlist.newList")}</button><button type="button" role="menuitem" className="watchlist-delete-action" disabled={!activeWatchlist || watchlists.length <= 1 || persistenceStatus === "saving"} title={watchlists.length <= 1 ? t("watchlist.deleteLastRequired") : undefined} onClick={() => { setMenu(null); onDeleteWatchlist(); }}><Trash size={13} />{t("watchlist.delete")}</button></div>}</div>
        </div>
      </div>
      <div className="watchlist-columns">
        <span>{t("watchlist.symbol")}</span><span>{t("watchlist.current")}</span><span>{t("watchlist.change")}</span><span>{t("watchlist.afterHours")}</span>
      </div>
      <div className="watchlist-rows">
        {sortedStocks.map((item) => {
          const afterHoursClose = afterHours[item.ticker]?.close;
          const hasCurrentPrice = Number.isFinite(item.price) && item.price > 0;
          const hasAfterHoursPrice = typeof afterHoursClose === "number" && Number.isFinite(afterHoursClose) && afterHoursClose > 0;
          const afterHoursTone = !hasAfterHoursPrice
            ? "is-missing"
            : !hasCurrentPrice
              ? "is-neutral"
              : afterHoursClose > item.price
                ? "is-higher"
                : afterHoursClose < item.price ? "is-lower" : "is-equal";
          return (
            <button
              type="button"
              key={item.ticker}
              className={`watch-row ${selectedTicker === item.ticker ? "selected" : ""}`}
              aria-haspopup="menu"
              aria-controls={rowContextMenu?.ticker === item.ticker ? "watchlist-row-context-menu" : undefined}
              onClick={() => onSelect(item.ticker)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openRowContextMenu(item.ticker, event.currentTarget, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                event.preventDefault();
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                openRowContextMenu(item.ticker, event.currentTarget, bounds.left + 24, bounds.top + bounds.height - 4);
              }}
            >
              <span className="watch-symbol">
                <CompanyLogo stock={item} />
                <span><b>{item.ticker}</b><small>{item.market}</small></span>
              </span>
              <span className="watch-price">{formatWatchlistPrice(item)}</span>
              <span className={item.price > 0 ? (item.change >= 0 ? "positive" : "negative-text") : "muted-value"}>
                {item.price > 0 && Number.isFinite(item.price) ? `${item.change >= 0 ? "+" : ""}${item.change.toFixed(2)}%` : "-"}
              </span>
              <span className={`watch-after-hours ${afterHoursTone}`} title={t("watchlist.afterHoursTooltip", { symbol: item.ticker })}>
                {hasAfterHoursPrice ? afterHoursClose.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "-"}
              </span>
            </button>
          );
        })}
        {sortedStocks.length === 0 && <div className="empty-watchlist">{t("watchlist.empty")}</div>}
      </div>
      {rowContextMenu && (
        <div
          ref={rowContextMenuRef}
          id="watchlist-row-context-menu"
          className="watch-popover watchlist-row-context-menu"
          role="menu"
          aria-label={t("watchlist.rowMenu", { symbol: rowContextMenu.ticker })}
          style={{ left: rowContextMenu.left, top: rowContextMenu.top }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            ref={rowContextActionRef}
            type="button"
            role="menuitem"
            className="watchlist-delete-action"
            disabled={persistenceStatus === "saving"}
            onClick={(event) => {
              event.stopPropagation();
              const ticker = rowContextMenu.ticker;
              rowContextTriggerRef.current = null;
              setRowContextMenu(null);
              void onDelete(ticker);
            }}
          >
            <Trash size={15} />{t("watchlist.remove")}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const { locale, setLocale, t, supportedLocales } = useI18n();
  const numberLocale = locale === "ja" ? "ja-JP" : "en-US";
  const [selectedTicker, setSelectedTicker] = useState("AAPL");
  const [stockModels, setStockModels] = useState<Record<string, Stock>>(() => Object.fromEntries(STOCKS.map((item) => [item.ticker, item])));
  const [workspace, setWorkspace] = useState<SymbolWorkspace | null>(null);
  const [marketBars, setMarketBars] = useState<readonly MarketBar[]>([]);
  const [marketBarsSymbol, setMarketBarsSymbol] = useState("");
  const [marketBarsProvenance, setMarketBarsProvenance] = useState<DataProvenance | undefined>();
  const [workspaceStatus, setWorkspaceStatus] = useState<MarketDataStatus>("loading");
  const [barsStatus, setBarsStatus] = useState<MarketDataStatus>("loading");
  const [analystHistoryResponse, setAnalystHistoryResponse] = useState<AnalystRatingHistoryResponse | null>(null);
  const [analystHistoryStatus, setAnalystHistoryStatus] = useState<AnalystHistoryStatus>("idle");
  const [targetPriceMarketBars, setTargetPriceMarketBars] = useState<readonly MarketBar[]>([]);
  const [targetPriceMarketBarsSymbol, setTargetPriceMarketBarsSymbol] = useState("");
  const [searchResults, setSearchResults] = useState<readonly Instrument[]>([]);
  const [searchStatus, setSearchStatus] = useState<InstrumentSearchStatus>("idle");
  const [searchRetryNonce, setSearchRetryNonce] = useState(0);
  const [activeIndicators, setActiveIndicators] = useState<IndicatorId[]>(["sma20", "rsi14"]);
  const [hiddenIndicators, setHiddenIndicators] = useState<IndicatorId[]>([]);
  const [favoriteIndicators, setFavoriteIndicators] = useState<IndicatorId[]>(["sma20", "rsi14"]);
  const [indicatorSettings, setIndicatorSettings] = useState<Record<IndicatorId, IndicatorSettings>>(() =>
    Object.fromEntries(
      Object.entries(DEFAULT_INDICATOR_SETTINGS).map(([id, settings]) => [id, { ...settings, visibility: { ...settings.visibility } }]),
    ) as Record<IndicatorId, IndicatorSettings>,
  );
  const [primaryView, setPrimaryView] = useState<PrimaryView>("chart");
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanelId | null>("watchlist");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchIntent, setSearchIntent] = useState<InstrumentSearchIntent>("select");
  const [indicatorLibraryOpen, setIndicatorLibraryOpen] = useState(false);
  const [settingsIndicatorId, setSettingsIndicatorId] = useState<IndicatorId | null>(null);
  const [query, setQuery] = useState("");
  const [watchlists, setWatchlists] = useState<readonly Watchlist[] | null>(null);
  const [activeWatchlistId, setActiveWatchlistId] = useState("");
  const [watchlistStatus, setWatchlistStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [afterHoursBySymbol, setAfterHoursBySymbol] = useState<Readonly<Record<string, SyntheticLatestClose>>>({});
  const [newWatchlistName, setNewWatchlistName] = useState("");
  const [renameWatchlistName, setRenameWatchlistName] = useState("");
  const [interval, setInterval] = useState<MarketBarInterval>("1d");
  const [chartCandleCount, setChartCandleCount] = useState<number>(DEFAULT_CHART_CANDLE_COUNT);
  const [chartCandleCountDraft, setChartCandleCountDraft] = useState(String(DEFAULT_CHART_CANDLE_COUNT));
  const [localeDraft, setLocaleDraft] = useState<Locale>(locale);
  const [chartType, setChartType] = useState("ローソク");
  const [toolbarMenu, setToolbarMenu] = useState<ToolbarMenuId>(null);
  const chartTypeMenuHostRef = useRef<HTMLDivElement>(null);
  const chartTypeMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const templateMenuHostRef = useRef<HTMLDivElement>(null);
  const templateMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const chartTypeMenuBoundaries = useMemo(() => [chartTypeMenuHostRef] as const, []);
  const templateMenuBoundaries = useMemo(() => [templateMenuHostRef] as const, []);
  useDismissibleLayer({
    open: toolbarMenu === "chart-type",
    boundaryRefs: chartTypeMenuBoundaries,
    onDismiss: () => setToolbarMenu(null),
    restoreFocusRef: chartTypeMenuTriggerRef,
  });
  useDismissibleLayer({
    open: toolbarMenu === "templates",
    boundaryRefs: templateMenuBoundaries,
    onDismiss: () => setToolbarMenu(null),
    restoreFocusRef: templateMenuTriggerRef,
  });
  const [appDialog, setAppDialog] = useState<AppDialogId>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [showAllNews, setShowAllNews] = useState(false);
  const [chartPreferencesReady, setChartPreferencesReady] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stock = stockModels[selectedTicker] ?? STOCKS[0];
  const activeWatchlist = watchlists?.find((watchlist) => watchlist.id === activeWatchlistId) ?? watchlists?.[0] ?? null;
  const watchedTickers = activeWatchlist
    ? activeWatchlist.items.map((item) => item.symbol)
    : watchlists === null ? ["AAPL", "NVDA", "MSFT", "TSLA"] : [];
  const watchedStocks = watchedTickers.map((ticker) => stockModels[ticker]).filter((item): item is Stock => Boolean(item));
  const watchedTickerKey = watchedTickers.join("\u0000");
  const afterHoursTickerKey = Array.from(new Set([...watchedTickers, selectedTicker]))
    .slice(0, WATCHLIST_AFTER_HOURS_MAX_SYMBOLS)
    .join("\u0000");
  const searchView = resolveInstrumentSearchView(searchStatus, searchResults.length);
  const watched = watchedTickers.includes(selectedTicker);
  const dataStatus: MarketDataStatus = workspaceStatus === "error" || barsStatus === "error"
    ? "error"
    : workspaceStatus === "loading" || barsStatus === "loading"
      ? "loading"
      : workspaceStatus === "provider" || barsStatus === "provider" ? "provider" : "fixture";
  const detailWorkspace = workspace?.instrument.symbol === selectedTicker ? workspace : null;
  const detailMarketBars = useMemo<readonly MarketBar[]>(
    () => marketBarsSymbol === selectedTicker ? marketBars : [],
    [marketBars, marketBarsSymbol, selectedTicker],
  );
  const detailBarsProvenance = marketBarsSymbol === selectedTicker ? marketBarsProvenance : undefined;
  const selectedTargetPriceMarketBars = interval === "1d"
    ? detailMarketBars
    : targetPriceMarketBarsSymbol === selectedTicker ? targetPriceMarketBars : detailMarketBars;
  const stockDetailViewModel = useMemo(
    () => buildStockDetailViewModel(detailWorkspace, detailMarketBars, detailBarsProvenance),
    [detailBarsProvenance, detailMarketBars, detailWorkspace],
  );
  const stockIntelligence = useMemo(
    () => getStockIntelligence(stock, detailWorkspace, detailMarketBars, locale),
    [detailMarketBars, detailWorkspace, locale, stock],
  );
  const visibleNews = useMemo(() => {
    if (workspace?.instrument.symbol === stock.ticker && workspace.dataMode === "provider") {
      return workspace.news.map((item) => ({
        time: new Date(item.publishedAt).toLocaleString(numberLocale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        title: item.title,
        summary: item.summary || "",
        source: item.publisher,
        tag: t("sidebar.news"),
        url: item.url,
      }));
    }
    return NEWS.map((item) => ({
      ...item,
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(stock.ticker)}/news/`,
    }));
  }, [numberLocale, stock.ticker, t, workspace]);
  const selectedAnalystHistory = analystHistoryResponse?.instrument.symbol === selectedTicker
    ? analystHistoryResponse.history
    : null;
  const shouldLoadAnalystHistory = primaryView === "stock-detail";
  const activeIndicatorDefinitions = useMemo(
    () => INDICATORS.filter((indicator) => activeIndicators.includes(indicator.id)),
    [activeIndicators],
  );
  const visibleIndicatorDefinitions = useMemo(
    () => activeIndicatorDefinitions.filter((indicator) => !hiddenIndicators.includes(indicator.id)),
    [activeIndicatorDefinitions, hiddenIndicators],
  );
  const visibleIndicatorIds = useMemo(
    () => visibleIndicatorDefinitions.map((indicator) => indicator.id),
    [visibleIndicatorDefinitions],
  );
  const subIndicatorSpecs: readonly SubIndicatorSpec[] = useMemo(
    () => visibleIndicatorDefinitions
      .filter((indicator) => indicator.placement === "サブパネル")
      .map((indicator) => {
        const settings = indicatorSettings[indicator.id];
        return {
          id: indicator.id as SubIndicatorId,
          label: getIndicatorDisplayName(indicator, settings),
          color: settings.color,
          length: settings.length,
          fast: settings.fast,
          slow: settings.slow,
          signal: settings.signal,
          smoothing: settings.smoothing,
          source: settings.source,
          lineWidth: settings.lineWidth,
          lineStyle: settings.lineStyle,
        };
      }),
    [indicatorSettings, visibleIndicatorDefinitions],
  );
  const indicatorReadings = useMemo<Partial<Record<IndicatorId, string>>>(
    () => Object.fromEntries(activeIndicatorDefinitions.map((indicator) => [
      indicator.id,
      getIndicatorReading(
        indicator.id,
        stock,
        detailMarketBars,
        indicatorSettings[indicator.id],
      ),
    ])),
    [activeIndicatorDefinitions, detailMarketBars, indicatorSettings, stock],
  );
  const settingsIndicator = settingsIndicatorId
    ? INDICATORS.find((indicator) => indicator.id === settingsIndicatorId) ?? null
    : null;

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToast("");
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  const selectStock = useCallback((ticker: string) => {
    setSelectedTicker(ticker);
    setSearchOpen(false);
    setQuery("");
  }, []);

  const addInstrumentToWatchlist = useCallback(async (instrument: Instrument) => {
    if (!activeWatchlist) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    setWatchlistStatus("saving");
    try {
      const response = await fetch(`/api/v1/watchlists/${encodeURIComponent(activeWatchlist.id)}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrumentId: instrument.instrumentId,
          symbol: instrument.symbol,
          displayName: instrument.name,
          exchange: instrument.exchange,
          logoUrl: instrument.logoPath,
        }),
      });
      if (!response.ok) throw new Error("watchlist item request failed");
      const payload = await response.json() as WatchlistItemMutationResponse;
      setWatchlists((current) => current?.map((watchlist) => watchlist.id !== activeWatchlist.id
        ? watchlist
        : {
          ...watchlist,
          items: [
            ...watchlist.items.filter((item) => item.id !== payload.item.id && item.instrumentId !== payload.item.instrumentId),
            payload.item,
          ].sort((left, right) => left.position - right.position),
        }) ?? current);
      setWatchlistStatus("ready");
      showToast(t("watchlist.addSuccess", { symbol: instrument.symbol, name: activeWatchlist.name }));
      return true;
    } catch {
      setWatchlistStatus("error");
      showToast(t("watchlist.addError", { symbol: instrument.symbol }));
      return false;
    }
  }, [activeWatchlist, showToast, t]);

  const selectSearchInstrument = useCallback(async (instrument: Instrument) => {
    setStockModels((current) => current[instrument.symbol]
      ? current
      : { ...current, [instrument.symbol]: instrumentPlaceholder(instrument) });
    setSelectedTicker(instrument.symbol);
    if (searchIntent === "watchlist-add" && !await addInstrumentToWatchlist(instrument)) return;
    setSearchOpen(false);
    setQuery("");
  }, [addInstrumentToWatchlist, searchIntent]);

  const openInstrumentSearch = useCallback(() => {
    setSearchIntent("select");
    setSearchResults([]);
    setSearchStatus("loading");
    setSearchOpen(true);
  }, []);

  const openWatchlistInstrumentSearch = useCallback(() => {
    setSearchIntent("watchlist-add");
    setSearchResults([]);
    setSearchStatus("loading");
    setSearchOpen(true);
  }, []);

  const removeWatchlistItem = useCallback(async (ticker: string) => {
    if (!activeWatchlist) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    const existing = activeWatchlist.items.find((item) => item.symbol === ticker);
    if (!existing) {
      showToast(t("watchlist.notFound", { symbol: ticker, name: activeWatchlist.name }));
      return;
    }
    setWatchlistStatus("saving");
    try {
      const response = await fetch(`/api/v1/watchlists/${encodeURIComponent(activeWatchlist.id)}/items/${encodeURIComponent(existing.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("watchlist delete request failed");
      setWatchlists((current) => current?.map((watchlist) => watchlist.id !== activeWatchlist.id
        ? watchlist
        : { ...watchlist, items: watchlist.items.filter((item) => item.id !== existing.id) }) ?? current);
      setWatchlistStatus("ready");
      showToast(t("watchlist.removeSuccess", { symbol: ticker, name: activeWatchlist.name }));
    } catch {
      setWatchlistStatus("error");
      showToast(t("watchlist.removeError", { symbol: ticker }));
    }
  }, [activeWatchlist, showToast, t]);

  const toggleWatched = useCallback(async (ticker: string) => {
    if (!activeWatchlist) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    const existing = activeWatchlist.items.find((item) => item.symbol === ticker);
    if (existing) {
      await removeWatchlistItem(ticker);
      return;
    }

    const currentStock = stockModels[ticker];
    if (!currentStock || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) {
      showToast(t("watchlist.usOnly"));
      return;
    }
    const providerInstrument = workspace?.instrument.symbol === ticker ? workspace.instrument : null;
    const mic = currentStock.market.toUpperCase().includes("NYSE") ? "XNYS" : "XNAS";
    await addInstrumentToWatchlist(providerInstrument ?? {
      instrumentId: `us:${mic}:${ticker}`,
      symbol: ticker,
      name: currentStock.name,
      exchange: currentStock.market,
      exchangeMic: mic,
      currency: "USD",
      listingCountry: "US",
      assetType: "common_stock",
      active: true,
      sector: currentStock.sector,
      logoPath: currentStock.logoPath,
      provenance: {
        providerId: "unicorn-ui",
        sourceId: ticker,
        asOf: new Date().toISOString(),
        ingestedAt: new Date().toISOString(),
      },
    });
  }, [activeWatchlist, addInstrumentToWatchlist, removeWatchlistItem, showToast, stockModels, t, workspace]);

  const openChartFromStrategy = useCallback((ticker: string) => {
    if (stockModels[ticker]) setSelectedTicker(ticker);
    setPrimaryView("chart");
  }, [stockModels]);

  const openStockDetails = useCallback(() => {
    setPrimaryView("stock-detail");
    setToolbarMenu(null);
  }, []);

  const selectChartInterval = useCallback((nextInterval: MarketBarInterval) => {
    setInterval(nextInterval);
    showToast(locale === "ja"
      ? `${localizedIntervalLabel(nextInterval, locale)}足・${chartCandleCount.toLocaleString(numberLocale)}本へ変更しました`
      : `${localizedIntervalLabel(nextInterval, locale)} · ${chartCandleCount.toLocaleString(numberLocale)} candles`);
  }, [chartCandleCount, locale, numberLocale, showToast]);

  const openWorkspaceSettings = useCallback(() => {
    setChartCandleCountDraft(String(chartCandleCount));
    setLocaleDraft(locale);
    setAppDialog("settings");
  }, [chartCandleCount, locale]);

  const applyWorkspaceSettings = useCallback(() => {
    const nextCandleCount = parseChartCandleCount(chartCandleCountDraft);
    if (nextCandleCount === null) {
      showToast(t("settings.candles.invalid", {
        min: MIN_CHART_CANDLE_COUNT.toLocaleString(numberLocale),
        max: MAX_CHART_CANDLE_COUNT.toLocaleString(numberLocale),
      }));
      return;
    }
    setChartCandleCount(nextCandleCount);
    setChartCandleCountDraft(String(nextCandleCount));
    setLocale(localeDraft);
    setAppDialog(null);
    const targetLanguage = translate(localeDraft, `settings.language.${localeDraft === "en" ? "english" : "japanese"}`);
    showToast(`${translate(localeDraft, "settings.candles.saved", { count: nextCandleCount.toLocaleString(localeDraft === "ja" ? "ja-JP" : "en-US") })} ${translate(localeDraft, "settings.language.saved", { language: targetLanguage })}`);
  }, [chartCandleCountDraft, localeDraft, numberLocale, setLocale, showToast, t]);

  const addIndicator = useCallback((id: IndicatorId) => {
    setActiveIndicators((current) => current.includes(id) ? current : [...current, id]);
    setHiddenIndicators((current) => current.filter((indicatorId) => indicatorId !== id));
    const indicator = INDICATORS.find((item) => item.id === id);
    showToast(locale === "ja" ? `${indicator?.shortName ?? id}をチャートに追加しました` : `Added ${indicator?.shortName ?? id} to the chart.`);
  }, [locale, showToast]);

  const removeIndicator = useCallback((id: IndicatorId) => {
    setActiveIndicators((current) => current.filter((indicatorId) => indicatorId !== id));
    setHiddenIndicators((current) => current.filter((indicatorId) => indicatorId !== id));
  }, []);

  const toggleIndicatorVisibility = useCallback((id: IndicatorId) => {
    setHiddenIndicators((current) => current.includes(id)
      ? current.filter((indicatorId) => indicatorId !== id)
      : [...current, id]);
  }, []);

  const toggleFavoriteIndicator = useCallback((id: IndicatorId) => {
    setFavoriteIndicators((current) => current.includes(id)
      ? current.filter((indicatorId) => indicatorId !== id)
      : [...current, id]);
  }, []);

  const toggleUtilityPanel = useCallback((id: UtilityPanelId) => {
    setUtilityPanel((current) => current === id ? null : id);
  }, []);

  const selectWatchlist = useCallback((watchlistId: string) => {
    setActiveWatchlistId(watchlistId);
    window.localStorage.setItem("unicorn.active-watchlist.v1", watchlistId);
  }, []);

  const createWatchlist = useCallback(async () => {
    const name = newWatchlistName.trim();
    if (!name) return;
    setWatchlistStatus("saving");
    try {
      const response = await fetch("/api/v1/watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error("watchlist create request failed");
      const payload = await response.json() as WatchlistMutationResponse;
      setWatchlists((current) => [...(current ?? []), payload.watchlist]);
      selectWatchlist(payload.watchlist.id);
      setNewWatchlistName("");
      setAppDialog(null);
      setWatchlistStatus("ready");
      showToast(t("watchlist.createSuccess", { name: payload.watchlist.name }));
    } catch {
      setWatchlistStatus("error");
      showToast(t("watchlist.createError"));
    }
  }, [newWatchlistName, selectWatchlist, showToast, t]);

  const openWatchlistRename = useCallback(() => {
    if (!activeWatchlist) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    setRenameWatchlistName(activeWatchlist.name);
    setAppDialog("watchlist-rename");
  }, [activeWatchlist, showToast, t]);

  const renameActiveWatchlist = useCallback(async () => {
    if (!activeWatchlist) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    const name = renameWatchlistName.trim();
    if (!name || name.length > 60 || name === activeWatchlist.name) return;

    setWatchlistStatus("saving");
    try {
      const response = await fetch(`/api/v1/watchlists/${encodeURIComponent(activeWatchlist.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json() as WatchlistMutationResponse & {
        error?: { code?: string };
      };
      if (!response.ok) throw new Error(payload.error?.code ?? "watchlist_rename_failed");

      setWatchlists((current) => current?.map((watchlist) =>
        watchlist.id === payload.watchlist.id ? payload.watchlist : watchlist,
      ) ?? current);
      setRenameWatchlistName("");
      setAppDialog(null);
      setWatchlistStatus("ready");
      showToast(t("watchlist.renameSuccess", { name: payload.watchlist.name }));
    } catch (error) {
      setWatchlistStatus("error");
      showToast(t(error instanceof Error && error.message === "watchlist_name_exists"
        ? "watchlist.renameDuplicate"
        : "watchlist.renameError"));
    }
  }, [activeWatchlist, renameWatchlistName, showToast, t]);

  const openWatchlistDelete = useCallback(() => {
    if (!activeWatchlist || !watchlists) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    if (watchlists.length <= 1) {
      showToast(t("watchlist.deleteLastRequired"));
      return;
    }
    setAppDialog("watchlist-delete");
  }, [activeWatchlist, showToast, t, watchlists]);

  const deleteActiveWatchlist = useCallback(async () => {
    if (!activeWatchlist || !watchlists) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    if (watchlists.length <= 1) {
      setAppDialog(null);
      showToast(t("watchlist.deleteLastRequired"));
      return;
    }

    const deletingWatchlist = activeWatchlist;
    setWatchlistStatus("saving");
    try {
      const response = await fetch(`/api/v1/watchlists/${encodeURIComponent(deletingWatchlist.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json() as WatchlistDeletionResponse & {
        error?: { code?: string };
      };
      if (!response.ok) throw new Error(payload.error?.code ?? "watchlist_delete_failed");

      const remaining = watchlists.filter((watchlist) => watchlist.id !== payload.deletedId);
      const nextWatchlist = remaining.find((watchlist) => watchlist.id === payload.nextWatchlistId)
        ?? remaining.find((watchlist) => watchlist.isDefault)
        ?? remaining[0];
      if (!nextWatchlist) throw new Error("last_watchlist_required");
      setWatchlists(remaining.map((watchlist) => ({
        ...watchlist,
        isDefault: watchlist.id === nextWatchlist.id,
      })));
      selectWatchlist(nextWatchlist.id);
      setAppDialog(null);
      setWatchlistStatus("ready");
      showToast(t("watchlist.deleteSuccess", { name: deletingWatchlist.name }));
    } catch (error) {
      const lastWatchlistRequired = error instanceof Error && error.message === "last_watchlist_required";
      setWatchlistStatus(lastWatchlistRequired ? "ready" : "error");
      showToast(t(lastWatchlistRequired ? "watchlist.deleteLastRequired" : "watchlist.deleteError"));
    }
  }, [activeWatchlist, selectWatchlist, showToast, t, watchlists]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/watchlists", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("watchlists request failed");
        return response.json() as Promise<WatchlistsResponse>;
      })
      .then((payload) => {
        setWatchlists(payload.watchlists);
        const remembered = window.localStorage.getItem("unicorn.active-watchlist.v1");
        const selected = payload.watchlists.find((watchlist) => watchlist.id === remembered)
          ?? payload.watchlists.find((watchlist) => watchlist.isDefault)
          ?? payload.watchlists[0];
        if (selected) setActiveWatchlistId(selected.id);
        setStockModels((current) => {
          const next = { ...current };
          for (const watchlist of payload.watchlists) {
            for (const item of watchlist.items) next[item.symbol] ??= watchlistItemPlaceholder(item);
          }
          return next;
        });
        setWatchlistStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setWatchlistStatus("error");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const symbols = watchedTickerKey
      ? watchedTickerKey.split("\u0000").slice(0, WATCHLIST_QUOTES_MAX_SYMBOLS)
      : [];
    if (symbols.length === 0) return;
    const controller = new AbortController();
    let disposed = false;
    let refreshTimer: number | undefined;
    const refresh = () => {
      void fetch("/api/v1/watchlists/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols }),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("watchlist quotes request failed");
          return response.json() as Promise<WatchlistQuotesResponse>;
        })
        .then((response) => {
          if (disposed) return;
          setStockModels((current) => {
            const next = { ...current };
            for (const item of response.items) {
              const merged = watchlistQuoteStock(item, next[item.symbol]);
              if (merged) next[item.symbol] = merged;
            }
            return next;
          });
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // Preserve the last known valid quote. A later poll retries it.
        })
        .finally(() => {
          if (!disposed) refreshTimer = window.setTimeout(refresh, WATCHLIST_MARKET_REFRESH_MS);
        });
  };
    refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [watchedTickerKey]);

  useEffect(() => {
    const symbols = afterHoursTickerKey
      ? afterHoursTickerKey.split("\u0000")
      : [];
    if (symbols.length === 0) {
      queueMicrotask(() => setAfterHoursBySymbol({}));
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    let refreshTimer: number | undefined;
    const refresh = () => {
      void fetch("/api/v1/watchlists/after-hours", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols }),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("after-hours request failed");
          return response.json() as Promise<WatchlistAfterHoursResponse>;
        })
        .then((response) => {
          if (!disposed) setAfterHoursBySymbol(Object.fromEntries(response.items.map((item) => [item.symbol, item])));
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // Keep the last successful batch visible and retry automatically.
        })
        .finally(() => {
          if (!disposed) refreshTimer = window.setTimeout(refresh, WATCHLIST_MARKET_REFRESH_MS);
        });
    };
    refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [afterHoursTickerKey]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = window.localStorage.getItem("unicorn.chart-preferences.v1");
        if (raw) {
          const saved = JSON.parse(raw) as Record<string, unknown>;
          const savedInterval = CHART_INTERVAL_OPTIONS.find((option) => option.interval === saved.interval)?.interval;
          if (savedInterval) setInterval(savedInterval);
          const savedCandleCount = parseChartCandleCount(saved.candleCount);
          if (savedCandleCount !== null) setChartCandleCount(savedCandleCount);
          if (["ローソク", "ライン", "エリア"].includes(String(saved.chartType))) setChartType(String(saved.chartType));
          if (Array.isArray(saved.activeIndicators)) setActiveIndicators(saved.activeIndicators.filter(isIndicatorId));
          if (Array.isArray(saved.hiddenIndicators)) setHiddenIndicators(saved.hiddenIndicators.filter(isIndicatorId));
          if (Array.isArray(saved.favoriteIndicators)) setFavoriteIndicators(saved.favoriteIndicators.filter(isIndicatorId));
          if (saved.utilityPanel === null || ["watchlist", "indicators", "news"].includes(String(saved.utilityPanel))) {
            setUtilityPanel(saved.utilityPanel as UtilityPanelId | null);
          }
          if (saved.indicatorSettings && typeof saved.indicatorSettings === "object" && !Array.isArray(saved.indicatorSettings)) {
            const record = saved.indicatorSettings as Partial<Record<IndicatorId, Partial<IndicatorSettings>>>;
            setIndicatorSettings((current) => Object.fromEntries(INDICATORS.map(({ id }) => {
              const candidate = record[id];
              if (!candidate || typeof candidate !== "object") return [id, current[id]];
              return [id, {
                ...current[id],
                ...candidate,
                visibility: { ...current[id].visibility, ...(candidate.visibility ?? {}) },
              }];
            })) as Record<IndicatorId, IndicatorSettings>);
          }
        }
      } catch {
        window.localStorage.removeItem("unicorn.chart-preferences.v1");
      } finally {
        if (!cancelled) setChartPreferencesReady(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!chartPreferencesReady) return;
    window.localStorage.setItem("unicorn.chart-preferences.v1", JSON.stringify({
      schemaVersion: "unicorn.chart-preferences.v1",
      interval,
      candleCount: chartCandleCount,
      chartType,
      activeIndicators,
      hiddenIndicators,
      favoriteIndicators,
      indicatorSettings,
      utilityPanel,
    }));
  }, [activeIndicators, chartCandleCount, chartPreferencesReady, chartType, favoriteIndicators, hiddenIndicators, indicatorSettings, interval, utilityPanel]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setWorkspaceStatus("loading");
        setWorkspace(null);
      }
    });
    void fetch(`/api/v1/symbols/${encodeURIComponent(selectedTicker)}/workspace`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("workspace request failed");
        return response.json() as Promise<SymbolWorkspace>;
      })
      .then((snapshot) => {
        if (snapshot.instrument.symbol !== selectedTicker) return;
        setWorkspace(snapshot);
        setWorkspaceStatus(snapshot.dataMode);
        if (snapshot.dataMode === "provider") {
          setStockModels((current) => ({ ...current, [snapshot.instrument.symbol]: workspaceStock(snapshot) }));
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setWorkspaceStatus("error");
      });
    return () => controller.abort();
  }, [selectedTicker]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setBarsStatus("loading");
        setMarketBars([]);
        setMarketBarsSymbol("");
        setMarketBarsProvenance(undefined);
      }
    });
    const params = new URLSearchParams({
      range: CHART_RANGE,
      interval,
      count: String(chartCandleCount),
    });
    void fetch(`/api/v1/symbols/${encodeURIComponent(selectedTicker)}/bars?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("bars request failed");
        return response.json() as Promise<MarketBarsResponse>;
      })
      .then((snapshot) => {
        if (snapshot.instrument.symbol !== selectedTicker) return;
        setMarketBars(snapshot.bars.items);
        setMarketBarsSymbol(snapshot.instrument.symbol);
        setMarketBarsProvenance(snapshot.bars.provenance);
        setBarsStatus(snapshot.dataMode);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setBarsStatus("error");
      });
    return () => controller.abort();
  }, [chartCandleCount, interval, selectedTicker]);

  useEffect(() => {
    if (!shouldLoadAnalystHistory) return;
    const controller = new AbortController();
    const today = new Date();
    const dateTo = today.toISOString().slice(0, 10);
    const dateFrom = `${today.getUTCFullYear() - 2}-01-01`;
    const params = new URLSearchParams({
      pagesize: "1000",
      "parameters[date_from]": dateFrom,
      "parameters[date_to]": dateTo,
      "parameters[tickers]": selectedTicker,
    });
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setAnalystHistoryStatus("loading");
        setAnalystHistoryResponse(null);
      }
    });
    void fetch(`/api/v1/symbols/${encodeURIComponent(selectedTicker)}/analyst-ratings?${params}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("analyst rating history request failed");
        return response.json() as Promise<AnalystRatingHistoryResponse>;
      })
      .then((response) => {
        if (response.instrument.symbol !== selectedTicker) return;
        setAnalystHistoryResponse(response);
        setAnalystHistoryStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAnalystHistoryStatus("error");
      });
    return () => controller.abort();
  }, [selectedTicker, shouldLoadAnalystHistory]);

  useEffect(() => {
    if (!shouldLoadAnalystHistory || interval === "1d") return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      range: CHART_RANGE,
      interval: "1d",
      count: String(chartCandleCount),
    });
    void fetch(`/api/v1/symbols/${encodeURIComponent(selectedTicker)}/bars?${params}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("target-price bars request failed");
        return response.json() as Promise<MarketBarsResponse>;
      })
      .then((response) => {
        if (response.instrument.symbol !== selectedTicker) return;
        setTargetPriceMarketBars(response.bars.items);
        setTargetPriceMarketBarsSymbol(response.instrument.symbol);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setTargetPriceMarketBars([]);
        setTargetPriceMarketBarsSymbol("");
      });
    return () => controller.abort();
  }, [chartCandleCount, interval, selectedTicker, shouldLoadAnalystHistory]);

  useEffect(() => {
    if (!searchOpen) return;
    const normalizedQuery = query.trim();
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setSearchResults([]);
        setSearchStatus("loading");
      }
    });
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: normalizedQuery, limit: "20" });
      void fetch(`/api/v1/instruments/search?${params}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("search request failed");
          return response.json() as Promise<InstrumentSearchResponse>;
        })
        .then((result) => {
          setSearchResults(result.items);
          setSearchStatus("ready");
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setSearchResults([]);
          setSearchStatus("error");
        });
    }, normalizedQuery ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchOpen, searchRetryNonce]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing = target?.matches("input, textarea, select, [contenteditable='true']") ?? false;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openInstrumentSearch();
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === "/" && !isEditing && primaryView === "chart") {
        event.preventDefault();
        setIndicatorLibraryOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setIndicatorLibraryOpen(false);
        setSettingsIndicatorId(null);
        setToolbarMenu(null);
        setAppDialog(null);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openInstrumentSearch, primaryView]);

  return (
    <main className="market-app">
      <nav className="workspace-view-tabs" role="tablist" aria-label={t("shell.workspace")}>
        <div className="brand-lockup workspace-brand-lockup" aria-label={UNICORN_BRAND.name}>
          <Image className="brand-logo" src={UNICORN_BRAND.logoPath} alt="" width={28} height={28} unoptimized aria-hidden="true" />
          <strong>{UNICORN_BRAND.wordmark}</strong>
        </div>
        <button type="button" role="tab" aria-selected={primaryView !== "strategy"} className={primaryView !== "strategy" ? "active" : ""} onClick={() => setPrimaryView("chart")}><ChartBar size={15} /> {t("nav.chart")}</button>
        <button type="button" role="tab" aria-label={t("nav.strategies")} aria-selected={primaryView === "strategy"} className={primaryView === "strategy" ? "active" : ""} onClick={() => setPrimaryView("strategy")}><Lightning size={15} /> {t("nav.strategies")}</button>
        <span />
        <small>{primaryView === "chart" ? t("shell.chartContext", { symbol: stock.ticker }) : primaryView === "stock-detail" ? t("shell.detailContext", { symbol: stock.ticker }) : t("shell.strategyContext")}</small>
      </nav>

      <header className="global-toolbar">
        {primaryView === "chart" ? <>
          <button type="button" className="symbol-search-trigger" onClick={openInstrumentSearch}>
            <MagnifyingGlass size={17} />
            <span><b>{stock.ticker}</b><small>{stock.name}</small></span>
            <span className="shortcut-key">⌘ F</span>
          </button>
          <div className="toolbar-divider" />
          <div className="interval-group" aria-label={t("toolbar.timeframe")}>
            {CHART_INTERVAL_OPTIONS.map((item) => (
              <button key={item.interval} type="button" className={item.interval === interval ? "active" : ""} onClick={() => selectChartInterval(item.interval)}>{localizedIntervalLabel(item.interval, locale)}</button>
            ))}
          </div>
          <div className="toolbar-divider hide-narrow" />
          <div className="toolbar-popover-host hide-narrow" ref={chartTypeMenuHostRef}><button ref={chartTypeMenuTriggerRef} type="button" className="toolbar-button" aria-haspopup="menu" aria-expanded={toolbarMenu === "chart-type"} aria-controls="chart-type-menu" onClick={() => setToolbarMenu((current) => current === "chart-type" ? null : "chart-type")}><ChartBar size={17} /> {t(chartType === "ローソク" ? "toolbar.candlestick" : chartType === "ライン" ? "toolbar.line" : "toolbar.area")} <CaretDown size={12} /></button>{toolbarMenu === "chart-type" && <div id="chart-type-menu" className="toolbar-popover chart-type-menu" role="menu">{[["ローソク", "toolbar.candlestick"], ["ライン", "toolbar.line"], ["エリア", "toolbar.area"]].map(([item, labelKey]) => <button type="button" className={chartType === item ? "active" : ""} key={item} onClick={() => { setChartType(item); setToolbarMenu(null); }}>{chartType === item && <Check size={13} />}{t(labelKey)}</button>)}</div>}</div>
          <button type="button" className={`toolbar-button hide-narrow ${indicatorLibraryOpen ? "selected" : ""}`} onClick={() => setIndicatorLibraryOpen(true)}><FunctionIcon size={17} /> {t("toolbar.indicators")}</button>
          <div className="toolbar-popover-host hide-mid" ref={templateMenuHostRef}><button ref={templateMenuTriggerRef} type="button" className="toolbar-button" aria-haspopup="menu" aria-expanded={toolbarMenu === "templates"} aria-controls="indicator-template-menu" onClick={() => setToolbarMenu((current) => current === "templates" ? null : "templates")}><Rows size={17} /> {t("toolbar.templates")}</button>{toolbarMenu === "templates" && <div id="indicator-template-menu" className="toolbar-popover template-menu" role="menu"><span>{t("toolbar.indicatorSet")}</span><button type="button" onClick={() => { setActiveIndicators(["sma20", "ema50", "rsi14"]); setToolbarMenu(null); showToast(t("toolbar.trendTemplate")); }}>{t("toolbar.trendTemplate")}<small>{t("toolbar.trendTemplateHelp")}</small></button><button type="button" onClick={() => { setActiveIndicators(["bollinger", "atr14", "macd"]); setToolbarMenu(null); showToast(t("toolbar.volatilityTemplate")); }}>{t("toolbar.volatilityTemplate")}<small>{t("toolbar.volatilityTemplateHelp")}</small></button><button type="button" onClick={() => { setActiveIndicators([]); setToolbarMenu(null); showToast(t("toolbar.noIndicators")); }}>{t("toolbar.noIndicators")}<small>{t("toolbar.noIndicatorsHelp")}</small></button></div>}</div>
          <button type="button" className="toolbar-button hide-mid" onClick={() => setAppDialog("alert")}><Bell size={17} /> {t("toolbar.alert")}</button>
        </> : primaryView === "strategy" ? <>
          <div className="strategy-toolbar-title"><Lightning size={18} weight="fill" /><span><strong>{t("toolbar.strategyReport")}</strong><small>{t("toolbar.strategySubtitle")}</small></span></div>
        </> : <>
          <button type="button" className="symbol-search-trigger" onClick={openInstrumentSearch}><MagnifyingGlass size={17} /><span><b>{stock.ticker}</b><small>{stock.name}</small></span><span className="shortcut-key">⌘ F</span></button>
          <div className="toolbar-divider" />
          <div className="strategy-toolbar-title stock-detail-toolbar-title"><ChartLineUp size={18} /><span><strong>{t("toolbar.symbolDetails")}</strong><small>{t("toolbar.symbolDetailsSubtitle")}</small></span></div>
          <button type="button" className="toolbar-button hide-mid" onClick={() => setPrimaryView("chart")}><ChartBar size={17} /> {t("toolbar.openChart")}</button>
        </>}
        <div className="toolbar-spacer" />
        <IconButton label={t("nav.settings")} onClick={openWorkspaceSettings}><Gear size={18} /></IconButton>
      </header>

      {primaryView === "chart" ? <div className={`workspace-grid ${utilityPanel && !focusMode ? "" : "utility-closed"} ${focusMode ? "focus-mode" : ""}`}>
        <section className="chart-area">
          <div className="chart-commandbar">
            <button type="button" className="chart-symbol-button" onClick={openInstrumentSearch}>
              <CompanyLogo stock={stock} eager />
              <span><b>{stock.ticker}</b><small>{stock.market}</small></span>
              <CaretDown size={12} />
            </button>
            <div className="quote-summary">
              <strong>{formatPrice(stock)}</strong>
              <span className={stock.change >= 0 ? "positive" : "negative-text"}>
                {stock.changeValue >= 0 ? "+" : ""}{stock.changeValue.toFixed(stock.currency === "$" ? 2 : 1)} ({stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)}%)
              </span>
            </div>
            <div className="ohlc-summary hide-mid">
              <span>O <b>{formatPrice(stock, stock.open)}</b></span>
              <span>H <b>{formatPrice(stock, stock.high)}</b></span>
              <span>L <b>{formatPrice(stock, stock.low)}</b></span>
              <span>Vol <b>{stock.volume}</b></span>
            </div>
            <div className="chart-actions">
              <IconButton label={t("chart.addIndicator")} active={indicatorLibraryOpen} onClick={() => setIndicatorLibraryOpen(true)}><FunctionIcon size={17} /></IconButton>
              <IconButton label={t("chart.snapshot")} onClick={() => setAppDialog("snapshot")}><Camera size={18} /></IconButton>
              <IconButton label={t(focusMode ? "chart.exitFullscreen" : "chart.fullscreen")} active={focusMode} onClick={() => setFocusMode((value) => !value)}><ArrowsOut size={18} /></IconButton>
            </div>
          </div>
          <div className={`chart-stack ${subIndicatorSpecs.length > 0 ? "has-subindicators" : ""}`}>
            <div className="chart-stage">
              <PriceChart stock={stock} marketBars={detailMarketBars} range={CHART_RANGE} chartType={chartType} activeIndicators={visibleIndicatorIds} indicatorSettings={indicatorSettings} />
              {dataStatus === "loading" && <div className="chart-data-state" role="status">{t("chart.historyLoading")}</div>}
              {dataStatus === "error" && <div className="chart-data-state is-error" role="alert">{t("chart.historyError")}</div>}
              <div className="chart-watermark">{stock.ticker}</div>
              <div className="chart-indicator-legend" aria-label={indicatorText(locale, "chartIndicators")}>
                {activeIndicatorDefinitions.map((indicator) => {
                  const hidden = hiddenIndicators.includes(indicator.id);
                  return (
                    <div className={`chart-indicator-row ${hidden ? "is-hidden" : ""}`} key={indicator.id}>
                      <span className="indicator-swatch" style={{ background: indicatorSettings[indicator.id].color }} />
                      <button type="button" className="indicator-legend-name" onDoubleClick={() => setSettingsIndicatorId(indicator.id)}>{getIndicatorDisplayName(indicator, indicatorSettings[indicator.id])}</button>
                      <b>{indicatorReadings[indicator.id] ?? "—"}</b>
                      <span className="indicator-legend-actions">
                        <button type="button" aria-label={indicatorText(locale, hidden ? "show" : "hide", { name: indicator.shortName })} onClick={() => toggleIndicatorVisibility(indicator.id)}><Eye size={13} /></button>
                        <button type="button" aria-label={indicatorText(locale, "settings", { name: indicator.shortName })} onClick={() => setSettingsIndicatorId(indicator.id)}><Gear size={13} /></button>
                        <button type="button" aria-label={indicatorText(locale, "remove", { name: indicator.shortName })} onClick={() => removeIndicator(indicator.id)}><X size={13} /></button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <SubIndicatorPanes bars={detailMarketBars} indicators={subIndicatorSpecs} />
          </div>
        </section>

        <aside className={`right-panel utility-panel ${utilityPanel && !focusMode ? "is-open" : ""}`}>
          {utilityPanel === "watchlist" && (
            <div className="right-tab-content watchlist-detail-layout" role="tabpanel" aria-label={`${t("sidebar.watchlist")} · ${t("summary.title")}`}>
              <WatchlistPanel
                selectedTicker={selectedTicker}
                onSelect={selectStock}
                stocks={watchedStocks}
                onAdd={openWatchlistInstrumentSearch}
                onCreate={() => setAppDialog("watchlist-create")}
                onRename={openWatchlistRename}
                onDeleteWatchlist={openWatchlistDelete}
                watchlists={watchlists ?? []}
                activeWatchlistId={activeWatchlist?.id ?? ""}
                onSelectWatchlist={selectWatchlist}
                onDelete={removeWatchlistItem}
                persistenceStatus={watchlistStatus}
                afterHours={afterHoursBySymbol}
              />
              <div className="stock-summary-scroll" aria-label={t("summary.ariaLabel", { symbol: stock.ticker })}>
                <SymbolSummaryHost
                  stock={stock}
                  intelligence={stockIntelligence}
                  afterHours={afterHoursBySymbol[stock.ticker]}
                  watched={watched}
                  onToggleWatched={() => toggleWatched(stock.ticker)}
                  onOpenDetails={openStockDetails}
                  registrations={DEFAULT_SYMBOL_SUMMARY_MODULES}
                  density={DEFAULT_SYMBOL_SUMMARY_DENSITY}
                />
              </div>
            </div>
          )}
          {utilityPanel === "indicators" && (
            <div className="right-tab-content" role="tabpanel" aria-label={t("sidebar.indicators")}>
              <IndicatorsPanel activeIndicators={activeIndicators} hiddenIndicators={hiddenIndicators} indicatorSettings={indicatorSettings} onAdd={() => setIndicatorLibraryOpen(true)} onToggleVisibility={toggleIndicatorVisibility} onOpenSettings={setSettingsIndicatorId} onRemove={removeIndicator} />
            </div>
          )}
          {utilityPanel === "news" && (
            <div className="right-news-panel right-tab-content" role="tabpanel" aria-label={t("sidebar.news")}>
              <div className="right-panel-heading"><strong>{stock.ticker} · {t("sidebar.news")}</strong><button type="button" className="text-action" onClick={() => setShowAllNews((value) => !value)}>{showAllNews ? t("news.primaryOnly") : t("news.all")}</button></div>
              {(showAllNews ? visibleNews.concat(visibleNews.slice(0, 2)) : visibleNews).map((item, index) => (
                <a className="right-news-row" href={item.url} target="_blank" rel="noopener noreferrer" key={`${item.title}-${index}`}>
                  <span>{item.time} · {item.source}</span>
                  <strong>{item.title}</strong>
                  {item.summary && <small>{item.summary}</small>}
                </a>
              ))}
              {visibleNews.length === 0 && <div className="empty-state">{t("news.empty")}</div>}
            </div>
          )}
        </aside>

        {!focusMode && <aside className="right-menu-rail" aria-label={t("shell.workspace")}>
          <IconButton label={t("sidebar.watchlist")} active={utilityPanel === "watchlist"} onClick={() => toggleUtilityPanel("watchlist")}><ListBullets size={19} /></IconButton>
          <IconButton label={t("sidebar.indicators")} active={utilityPanel === "indicators"} onClick={() => toggleUtilityPanel("indicators")}><FunctionIcon size={19} /></IconButton>
          <IconButton label={t("sidebar.news")} active={utilityPanel === "news"} onClick={() => toggleUtilityPanel("news")}><Newspaper size={19} /></IconButton>
          <span className="rail-spacer" />
          <IconButton label={t("sidebar.close")} onClick={() => setUtilityPanel(null)}><SidebarSimple size={18} /></IconButton>
        </aside>}

        <footer className="status-bar">
          <span className="status-delay"><ClockCounterClockwise size={13} /> {detailBarsProvenance ? `${detailBarsProvenance.providerId} · ${t("status.chart")}` : detailWorkspace ? `${detailWorkspace.selectedProviders.market} · ${detailWorkspace.quote.delaySeconds > 0 ? t("status.delayed", { seconds: detailWorkspace.quote.delaySeconds }) : t("status.noDelayGuarantee")}` : t("status.waiting")}</span>
          <span className="status-timezone">UTC+9</span>
          <span className="status-spacer" />
          <span className="connection-state status-connection"><span /> {t(dataStatus === "error" ? "status.connectionError" : dataStatus === "loading" ? "status.fetching" : "status.connected")}</span>
          <span className="status-disclaimer">{dataStatus === "provider" ? t("status.providerAsOf", { time: workspace?.asOf ? new Date(workspace.asOf).toLocaleString(numberLocale) : "—" }) : t("status.fixtureDisclaimer")}</span>
          <a className="chart-library-attribution" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Lightweight Charts by TradingView</a>
        </footer>
      </div> : primaryView === "stock-detail" ? <StockDetailPage stock={stock} targetPriceMarketBars={selectedTargetPriceMarketBars} earnings={detailWorkspace?.earnings ?? []} analystHistory={selectedAnalystHistory} analystHistoryStatus={analystHistoryStatus} detail={stockDetailViewModel} dataStatus={dataStatus} workspaceStatus={workspaceStatus} barsStatus={barsStatus} watched={watched} onBack={() => setPrimaryView("chart")} onToggleWatched={() => toggleWatched(stock.ticker)} /> : <StrategyHome onOpenChart={openChartFromStrategy} onAction={showToast} />}

      {searchOpen && (
        <div className="search-backdrop" onMouseDown={() => setSearchOpen(false)}>
          <section className="symbol-search-dialog" role="dialog" aria-modal="true" aria-label={t(searchIntent === "watchlist-add" ? "search.watchlistTitle" : "search.dialogTitle")} onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-search-row">
              <MagnifyingGlass size={20} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchResults([]);
                  setSearchStatus("loading");
                }}
                placeholder={t("search.inputPlaceholder")}
                aria-label={t("search.placeholder")}
                autoFocus
              />
              <button type="button" onClick={() => setSearchOpen(false)} aria-label={t("common.close")}><X size={18} /></button>
            </div>
            <div className="dialog-filter-row search-scope-row" aria-label={t("search.scope")}>
              <span className="search-scope-pill">{t("search.usStocks")}</span>
              <span>{t("search.exchanges")}</span>
              <small>{searchView === "loading" ? t("search.searching") : searchView === "error" ? t("search.providerError") : t("search.commonAndAdr")}</small>
            </div>
            <div className="search-results" aria-live="polite" aria-busy={searchView === "loading"}>
              {searchView === "results" && <div className="search-results-heading">{t(query.trim() ? "search.results" : "search.candidates")}</div>}
              {searchView === "results" && searchResults.map((item) => {
                const displayStock = stockModels[item.symbol] ?? instrumentPlaceholder(item);
                return (
                  <button type="button" key={item.instrumentId} onClick={() => selectSearchInstrument(item)}>
                    <CompanyLogo stock={displayStock} />
                    <span className="result-main"><b>{item.symbol}</b><small>{item.name}</small></span>
                    <span className="result-market">{item.exchange}<small>{item.assetType === "adr" ? "ADR" : item.sector ?? t("summary.assetType.commonStock")}</small></span>
                    {searchIntent === "watchlist-add" ? <Plus size={16} /> : <CaretRight size={16} />}
                  </button>
                );
              })}
              {searchView === "loading" && <div className="empty-state" role="status">{t(query.trim() ? "search.loadingQuery" : "search.loadingCandidates")}</div>}
              {searchView === "empty" && <div className="empty-state">{t("search.empty")}</div>}
              {searchView === "error" && <div className="empty-state search-error-state" role="alert"><span>{t("search.retryHint")}</span><button type="button" onClick={() => { setSearchResults([]); setSearchStatus("loading"); setSearchRetryNonce((value) => value + 1); }}>{t("common.retry")}</button></div>}
            </div>
          </section>
        </div>
      )}

      {appDialog === "alert" && <DialogShell title={t("alert.title")} eyebrow={`${stock.ticker} · ${formatPrice(stock)}`} onClose={() => setAppDialog(null)}><div className="dialog-body dialog-form-grid"><label><span>{t("alert.condition")}</span><select defaultValue="cross-above"><option value="cross-above">{t("alert.crossAbove")}</option><option value="cross-below">{t("alert.crossBelow")}</option><option value="percent">{t("alert.percentChange")}</option></select></label><label><span>{t("alert.price")}</span><input type="number" defaultValue={stock.target.toFixed(2)} /></label><label><span>{t("alert.expiration")}</span><select defaultValue="never"><option value="never">{t("alert.never")}</option><option value="week">{t("alert.week")}</option><option value="30d">{t("alert.days30")}</option></select></label><label className="check-line"><input type="checkbox" defaultChecked /> {t("alert.inApp")}</label></div><footer className="dialog-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.cancel")}</button><button type="button" className="primary-action" onClick={() => { setAppDialog(null); showToast(t("alert.created", { symbol: stock.ticker })); }}>{t("common.create")}</button></footer></DialogShell>}

      {appDialog === "settings" && <DialogShell title={t("settings.workspace.title")} eyebrow={t("settings.workspace.eyebrow")} onClose={() => setAppDialog(null)}><div className="dialog-body settings-list"><label><span><strong>{t("settings.candles.title")}</strong><small>{t("settings.candles.help", { min: MIN_CHART_CANDLE_COUNT.toLocaleString(numberLocale), max: MAX_CHART_CANDLE_COUNT.toLocaleString(numberLocale) })}</small></span><input type="number" inputMode="numeric" min={MIN_CHART_CANDLE_COUNT} max={MAX_CHART_CANDLE_COUNT} step={1} value={chartCandleCountDraft} aria-label={t("settings.candles.title")} aria-invalid={parseChartCandleCount(chartCandleCountDraft) === null} onChange={(event) => setChartCandleCountDraft(event.target.value)} /></label><label><span><strong>{t("settings.priceGrid.title")}</strong><small>{t("settings.priceGrid.help")}</small></span><input type="checkbox" defaultChecked /></label><label><span><strong>{t("settings.watermark.title")}</strong><small>{t("settings.watermark.help")}</small></span><input type="checkbox" defaultChecked /></label><label><span><strong>{t("settings.extendedHours.title")}</strong><small>{t("settings.extendedHours.help")}</small></span><input type="checkbox" /></label><label><span><strong>{t("settings.language.title")}</strong><small>{t("settings.language.description")} {t("settings.language.storageNote")}</small></span><select value={localeDraft} aria-label={t("settings.language.title")} onChange={(event) => setLocaleDraft(event.target.value as Locale)}>{supportedLocales.map((option) => <option key={option.code} value={option.code}>{option.nativeLabel}{option.code === "en" ? ` · ${t("settings.language.default")}` : ""}</option>)}</select></label></div><footer className="dialog-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.cancel")}</button><button type="button" className="primary-action" onClick={applyWorkspaceSettings}>{t("common.apply")}</button></footer></DialogShell>}

      {appDialog === "snapshot" && <DialogShell title={t("snapshot.title")} eyebrow={`${stock.ticker} · ${localizedIntervalLabel(interval, locale)}`} onClose={() => setAppDialog(null)} wide><div className="dialog-body snapshot-dialog"><div className="snapshot-preview"><PriceChart stock={stock} marketBars={detailMarketBars} range={CHART_RANGE} chartType={chartType} activeIndicators={visibleIndicatorIds} indicatorSettings={indicatorSettings} /></div><div className="snapshot-meta"><span>1280 × 720</span><span>Unicorn watermark</span><span>{dataStatus === "provider" ? `${detailBarsProvenance?.providerId ?? detailWorkspace?.selectedProviders.market ?? "Provider"} data` : "Fixture data"}</span></div></div><footer className="dialog-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.close")}</button><button type="button" className="primary-action" onClick={() => { setAppDialog(null); showToast(t("snapshot.prepared")); }}><DownloadSimple size={15} /> {t("snapshot.save")}</button></footer></DialogShell>}

      {appDialog === "watchlist-create" && <DialogShell title={t("watchlist.createDialogTitle")} eyebrow={t("watchlist.createDialogEyebrow")} onClose={() => setAppDialog(null)}><form className="dialog-body dialog-form-grid" onSubmit={(event) => { event.preventDefault(); void createWatchlist(); }}><label><span>{t("watchlist.name")}</span><input value={newWatchlistName} maxLength={60} onChange={(event) => setNewWatchlistName(event.target.value)} placeholder={t("watchlist.namePlaceholder")} autoFocus /></label><p className="dialog-helper-copy">{t("watchlist.createHelp")}</p><footer className="dialog-actions form-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.cancel")}</button><button type="submit" className="primary-action" disabled={!newWatchlistName.trim() || watchlistStatus === "saving"}>{t(watchlistStatus === "saving" ? "watchlist.creating" : "common.create")}</button></footer></form></DialogShell>}

      {appDialog === "watchlist-rename" && activeWatchlist && <DialogShell title={t("watchlist.renameDialogTitle")} eyebrow={t("watchlist.renameDialogEyebrow")} onClose={() => setAppDialog(null)}><form className="dialog-body dialog-form-grid" onSubmit={(event) => { event.preventDefault(); void renameActiveWatchlist(); }}><label><span>{t("watchlist.name")}</span><input value={renameWatchlistName} maxLength={60} aria-invalid={!renameWatchlistName.trim() || renameWatchlistName.trim().length > 60} onChange={(event) => setRenameWatchlistName(event.target.value)} placeholder={t("watchlist.namePlaceholder")} autoFocus /></label><p className="dialog-helper-copy">{t("watchlist.renameHelp")}</p><footer className="dialog-actions form-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.cancel")}</button><button type="submit" className="primary-action" disabled={!renameWatchlistName.trim() || renameWatchlistName.trim().length > 60 || renameWatchlistName.trim() === activeWatchlist.name || watchlistStatus === "saving"}>{t(watchlistStatus === "saving" ? "watchlist.renaming" : "common.save")}</button></footer></form></DialogShell>}

      {appDialog === "watchlist-delete" && activeWatchlist && <DialogShell title={t("watchlist.deleteDialogTitle")} eyebrow={t("watchlist.deleteDialogEyebrow")} onClose={() => setAppDialog(null)}><div className="dialog-body confirm-copy"><Trash size={28} /><p>{t("watchlist.deleteHelp", { name: activeWatchlist.name })}</p></div><footer className="dialog-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.cancel")}</button><button type="button" className="danger-action" disabled={watchlistStatus === "saving" || !watchlists || watchlists.length <= 1} onClick={() => void deleteActiveWatchlist()}>{t(watchlistStatus === "saving" ? "watchlist.deleting" : "common.delete")}</button></footer></DialogShell>}

      {indicatorLibraryOpen && (
        <IndicatorLibraryDialog activeIndicators={activeIndicators} favorites={favoriteIndicators} onAdd={addIndicator} onToggleFavorite={toggleFavoriteIndicator} onClose={() => setIndicatorLibraryOpen(false)} />
      )}

      {settingsIndicator && settingsIndicatorId && (
        <IndicatorSettingsDialog
          key={settingsIndicatorId}
          indicator={settingsIndicator}
          settings={indicatorSettings[settingsIndicatorId]}
          onClose={() => setSettingsIndicatorId(null)}
          onApply={(settings) => {
            setIndicatorSettings((current) => ({ ...current, [settingsIndicatorId]: settings }));
            setSettingsIndicatorId(null);
            showToast(indicatorText(locale, "settingsApplied", { name: settingsIndicator.shortName }));
          }}
        />
      )}

      {toast && <div className="toast"><Check size={17} weight="bold" /> {toast}</div>}
    </main>
  );
}
