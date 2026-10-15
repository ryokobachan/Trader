"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type LineWidth,
  type Time,
} from "lightweight-charts";
import {
  ArrowsOut,
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
import { TRADER_BRAND } from "./platform/brand";
import { traderConfig } from "./trader.config";
import type {
  FundamentalGroupId,
  StockDetailMetricId,
  SymbolDetailTabId,
} from "./platform/trader-config";
import { CompanyLogo } from "./components/CompanyLogo";
import { LoadingIndicator } from "./components/LoadingIndicator";
import { companyLogoPathForUSStock } from "./platform/company-logo";
import {
  formatSummaryAfterHoursPrice,
  type SymbolSummaryIntelligence,
  type SymbolSummaryStock,
} from "./platform/symbol-summary";
import {
  DEFAULT_SYMBOL_SUMMARY_DENSITY,
  DEFAULT_SYMBOL_SUMMARY_MODULES,
} from "@extensions";
import { SymbolSummaryHost } from "./features/symbol-summary/SymbolSummaryHost";
import { buildSummaryDailyMarketMetrics } from "./features/symbol-summary/daily-market-metrics";
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
  type SampleStrategyRecord,
} from "@strategies/catalog";
import { buildStrategySummaryMetricRegistry } from "@strategies/metrics";
import {
  SAMPLE_PORTFOLIO_HOLDINGS,
  samplePortfolioHoldingsForStrategy,
} from "@strategies/sample-portfolio";
import {
  markSamplePortfolio,
  strategyMarketMark,
  type StrategyMarketMark,
} from "@strategies/market-valuation";
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
  buildStockDetailTechnicalRatings,
  type TechnicalRatingVerdict,
} from "@api/stock-detail/technical-ratings";
import {
  AnalystTargetHistoryChart,
  EarningsActualEstimateChart,
  analystRatingChangeTone,
  analystTargetChangeTone,
} from "./features/stock-detail/StockDetailCharts";
import { TechnicalRatingsPanel } from "./features/stock-detail/TechnicalRatingsPanel";
import {
  createLatestRequestCoordinator,
  mergeFreshWorkspaceSection,
  type WorkspaceRefreshSection,
} from "./features/stock-detail/workspace-refresh";
import {
  canonicalStockDetailTabSelection,
  resolveStockDetailTab,
  type StockDetailTabSelection,
} from "./features/stock-detail/tab-selection";
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
  resolveChartTypeId,
  toHeikinAshiBars,
  type ChartTypeId,
} from "./features/chart-types/chart-types";
import {
  SYNCHRONIZED_PRICE_SCALE_MIN_WIDTH,
  createChartTimeScaleSync,
  type ChartTimeScaleSync,
} from "./features/chart-sync/chart-time-scale-sync";
import {
  EMPTY_CHART_DATA_LIFECYCLE,
  planChartDataUpdate,
  type ChartDataLifecycleState,
} from "./features/chart-sync/chart-data-lifecycle";
import {
  CHART_TEMPLATE_STORAGE_KEY,
  MAX_CHART_TEMPLATE_NAME_LENGTH,
  createChartTemplate,
  normalizeChartTemplateName,
  parseChartTemplates,
  serializeChartTemplates,
  validateChartTemplateName,
  type ChartIndicatorId,
  type ChartTemplate,
  type ChartTemplateNameError,
} from "./features/chart-templates/chart-templates";
import {
  DEFAULT_RIGHT_PANEL_WIDTH,
  DEFAULT_WATCHLIST_SPLIT_PERCENT,
  MAX_RIGHT_PANEL_WIDTH,
  MAX_WATCHLIST_SPLIT_PERCENT,
  MIN_RIGHT_PANEL_WIDTH,
  MIN_WATCHLIST_SPLIT_PERCENT,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  clampRightPanelWidth,
  clampWatchlistSplitPercent,
  parseWorkspaceLayoutPreferences,
  rightPanelMaxForViewport,
  serializeWorkspaceLayoutPreferences,
} from "./features/workspace-layout/panel-sizing";
import {
  WATCHLIST_AFTER_HOURS_MAX_SYMBOLS,
  WATCHLIST_AFTER_HOURS_POLL_SCHEMA_VERSION,
  WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
  WATCHLIST_QUOTES_SCHEMA_VERSION,
  WATCHLIST_QUOTES_MAX_SYMBOLS,
  WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION,
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
  Quote,
  SymbolWorkspace,
  SyntheticLatestClose,
  WatchlistAfterHoursPollCursor,
  WatchlistAfterHoursPollResponse,
  WatchlistAfterHoursResponse,
  WatchlistQuoteItem,
  WatchlistQuotesResponse,
} from "./platform/provider-contracts";
import {
  isNewerWatchlistQuote,
  parseWatchlistQuoteStreamMessage,
} from "./features/watchlist/quote-stream";
import {
  isEditableKeyboardTarget,
  isWatchlistDeleteShortcut,
  moveWatchlistItemIds,
  nextWatchlistSymbolAfterRemoval,
  type WatchlistDropEdge,
} from "./features/watchlist/interactions";
import {
  isFreshSyntheticLatestClose,
  isNewerAfterHoursClose,
  isNominalUsRegularSession,
  millisecondsUntilNextUsSessionBoundary,
  parseWatchlistAfterHoursStreamMessage,
  pruneStaleAfterHoursCloses,
  SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS,
  shouldReplaceMarketSessionObservation,
  shouldUseAfterHoursPrices,
  type MarketSessionObservation,
} from "./features/watchlist/after-hours-stream";
import {
  advanceMarketDataRequestGeneration,
  didMarketDataRequestStayInNominalSession,
  isCurrentMarketDataRequestGeneration,
  isQuoteNewerThan,
  marketBarsRefreshDelay,
  mergeLiveQuoteIntoWorkspace,
  prioritizedWatchlistQuoteSymbols,
} from "./features/live-market-data";
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
  StrategiesResponse,
  StrategyMutationResponse,
  StrategyPerformance,
  StrategyRecord as StrategyApiRecord,
} from "./platform/strategy-contracts";

type Stock = SymbolSummaryStock & {
  currency: "$" | "¥";
  marketState?: Quote["marketState"];
  open: number;
  seed: number;
};

type MarketDataStatus = "loading" | "provider" | "fixture" | "error";
type AnalystHistoryStatus = "idle" | "loading" | "ready" | "error";

type IndicatorId = ChartIndicatorId;

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
type AppDialogId = "settings" | "snapshot" | "watchlist-create" | "watchlist-rename" | "watchlist-delete" | null;
type ToolbarMenuId = "chart-type" | "templates" | null;
type InstrumentSearchIntent = "select" | "watchlist-add";
type IndicatorSettingsTab = "パラメーター" | "スタイル" | "表示";
type IndicatorLineStyle = "solid" | "dashed" | "dotted";

const CHART_RANGE: MarketBarRange = "5y";
const WATCHLIST_QUOTE_REFRESH_MS = 15_000;
const WATCHLIST_AFTER_HOURS_REFRESH_MS = 15_000;
const WATCHLIST_AFTER_HOURS_PRESENT_TIMEOUT_MS = 30_000;
const WATCHLIST_AFTER_HOURS_LIVENESS_TIMEOUT_MS = 45_000;
const WATCHLIST_SESSION_STATE_REFRESH_MS = 15_000;
const MARKET_SESSION_CLOCK_REFRESH_MS = 30_000;
const ANALYST_HISTORY_REFRESH_MS = 5 * 60_000;

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

type StrategyRecord = SampleStrategyRecord & {
  origin: StrategyApiRecord["origin"];
  version: number;
  performance: StrategyPerformance;
  createdAt: string | null;
  updatedAt: string | null;
};

function strategyRecordFromApi(strategy: StrategyApiRecord): StrategyRecord {
  return {
    id: strategy.id,
    origin: strategy.origin,
    version: strategy.version,
    family: strategy.family,
    status: strategy.status,
    candidateAt: strategy.candidateAt,
    name: strategy.name,
    category: strategy.category,
    sourceLabels: [...strategy.sourceLabels],
    headline: strategy.headline,
    audit: { ...strategy.audit },
    performance: { ...strategy.performance },
    netReturn: strategy.performance.netReturn ?? 0,
    maxDrawdown: strategy.performance.maxDrawdown ?? 0,
    recoveryFactor: strategy.performance.recoveryFactor ?? 0,
    sharpe: strategy.performance.sharpe,
    forwardReturn: strategy.performance.forwardReturn ?? 0,
    winRate: strategy.performance.winRate ?? 0,
    trades: strategy.performance.trades ?? 0,
    symbols: strategy.performance.symbols ?? 0,
    cash: strategy.performance.cash ?? 0,
    createdAt: strategy.createdAt,
    updatedAt: strategy.updatedAt,
  };
}

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
const STRATEGY_MARKET_SYMBOLS = Object.freeze(
  Array.from(new Set(PORTFOLIO_HOLDINGS.map((holding) => holding.ticker))),
);

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

function stockIdentityPlaceholder(stock: Stock): Stock {
  return {
    ...stock,
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
  };
}

function tickerIdentityPlaceholder(symbol: string): Stock {
  const catalogStock = STOCKS.find((stock) => stock.ticker === symbol);
  if (catalogStock) return stockIdentityPlaceholder(catalogStock);
  const normalizedSymbol = symbol.trim().toUpperCase();
  return {
    ...stockIdentityPlaceholder(STOCKS[0]),
    ticker: normalizedSymbol,
    name: normalizedSymbol,
    logoPath: companyLogoPathForUSStock(normalizedSymbol),
    logoFallback: normalizedSymbol.slice(0, 2),
    market: "US",
    sector: "—",
    seed: normalizedSymbol.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0),
  };
}

function watchlistItemPlaceholder(item: WatchlistItem): Stock {
  const existing = STOCKS.find((stock) => stock.ticker === item.symbol);
  if (existing) {
    return {
      ...stockIdentityPlaceholder(existing),
      name: item.displayName ?? existing.name,
      market: item.exchange ?? existing.market,
      logoPath: item.logoUrl ?? existing.logoPath,
    };
  }
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
      providerId: "trader-watchlists",
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
  const target = consensus?.targetConsensus ?? 0;
  return {
    ...stock,
    logoPath: profile?.logoUrl ?? stock.logoPath,
    sector: profile?.sector ?? workspace.instrument.sector ?? "—",
    price: workspace.quote.price,
    marketState: workspace.quote.marketState,
    change: workspace.quote.changePercent,
    changeValue: workspace.quote.change,
    open: workspace.quote.open,
    high: workspace.quote.high,
    low: workspace.quote.low,
    volume: compactNumber(workspace.quote.volume),
    marketCap: compactNumber(workspace.quote.marketCap ?? profile?.marketCap, "$"),
    target,
    targetLow: consensus?.targetLow ?? 0,
    targetHigh: consensus?.targetHigh ?? 0,
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
    marketState: item.quote.marketState,
    change: item.quote.changePercent,
    changeValue: item.quote.change,
    open: item.quote.open,
    high: item.quote.high,
    low: item.quote.low,
    volume: compactNumber(item.quote.volume),
    marketCap: compactNumber(item.quote.marketCap, "$"),
  };
}

function watchlistStreamQuoteStock(quote: Quote, current?: Stock): Stock | null {
  if (!current || quote.price <= 0 || !Number.isFinite(quote.price)) return null;
  return {
    ...current,
    price: quote.price,
    marketState: quote.marketState,
    change: quote.changePercent,
    changeValue: quote.change,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    volume: compactNumber(quote.volume),
    marketCap: compactNumber(quote.marketCap, "$"),
  };
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

const summaryTechnicalVerdict = (verdict: TechnicalRatingVerdict) => {
  const labels: Readonly<Record<TechnicalRatingVerdict, string>> = {
    strong_sell: "strong sell",
    sell: "sell",
    neutral: "neutral",
    buy: "buy",
    strong_buy: "strong buy",
    unavailable: "—",
  };
  return labels[verdict];
};

function unavailableStockIntelligence(): SymbolSummaryIntelligence {
  return {
    country: "—",
    industry: "—",
    website: "—",
    employees: "—",
    nextEarnings: "—",
    earningsSession: "—",
    earningsEstimate: "—",
    revenueEstimate: "—",
    exDividend: "—",
    description: "—",
    averageVolume30d: "—",
    dayRangePosition: null,
    yearRangePosition: null,
    yearLow: "—",
    yearHigh: "—",
    beta: "—",
    dataFreshness: "—",
    marketStatus: "—",
    performance: {
      week: "—",
      month: "—",
      threeMonths: "—",
      yearToDate: "—",
      year: "—",
    },
    technical: {
      overall: "—",
      movingAverages: "—",
      oscillators: "—",
      rsi: "—",
    },
  };
}

function getStockIntelligence(
  stock: Stock,
  workspace?: SymbolWorkspace | null,
  bars: readonly MarketBar[] = [],
  locale: Locale = "en",
): SymbolSummaryIntelligence {
  const displayLocale = locale === "ja" ? "ja-JP" : "en-US";
  if (
    !workspace
    || workspace.dataMode !== "provider"
    || workspace.instrument.symbol !== stock.ticker
  ) return unavailableStockIntelligence();

  const profile = workspace.profile;
  const earnings = workspace.earnings[0];
  const quote = workspace.quote;
  const dailyMetrics = buildSummaryDailyMarketMetrics(bars);
  const technicalRatings = buildStockDetailTechnicalRatings(bars);
  const yearLow = dailyMetrics.range52Week?.low;
  const yearHigh = dailyMetrics.range52Week?.high;
  const rsi = dailyMetrics.rsi14;
  const dayRangePosition = Number.isFinite(quote.price)
    && Number.isFinite(quote.low)
    && Number.isFinite(quote.high)
    && quote.high > quote.low
    ? Math.min(100, Math.max(0, ((quote.price - quote.low) / (quote.high - quote.low)) * 100))
    : null;
  const yearRangePosition = yearLow !== undefined
    && yearHigh !== undefined
    && yearHigh > yearLow
    ? Math.min(100, Math.max(0, ((quote.price - yearLow) / (yearHigh - yearLow)) * 100))
    : null;
  const asOf = new Date(workspace.asOf);
  const sessionLabels = {
    pre_market: translate(locale, "summary.market.preMarket"),
    regular: translate(locale, "summary.marketOpen"),
    after_hours: translate(locale, "summary.market.afterHours"),
    closed: translate(locale, "summary.market.closed"),
  } as const;

  return {
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
    yearLow: yearLow === undefined ? "—" : formatPrice(stock, yearLow),
    yearHigh: yearHigh === undefined ? "—" : formatPrice(stock, yearHigh),
    dayRangePosition,
    yearRangePosition,
    averageVolume30d: compactNumber(dailyMetrics.averageVolume30 ?? undefined),
    performance: {
      week: percentValue(dailyMetrics.performance.week ?? undefined),
      month: percentValue(dailyMetrics.performance.month ?? undefined),
      threeMonths: percentValue(dailyMetrics.performance.threeMonths ?? undefined),
      yearToDate: percentValue(dailyMetrics.performance.yearToDate ?? undefined),
      year: percentValue(dailyMetrics.performance.year ?? undefined),
    },
    technical: {
      overall: summaryTechnicalVerdict(technicalRatings.overall.verdict),
      movingAverages: summaryTechnicalVerdict(technicalRatings.movingAverages.verdict),
      oscillators: summaryTechnicalVerdict(technicalRatings.oscillators.verdict),
      rsi: rsi === null ? "—" : rsi.toFixed(1),
    },
    beta: Number.isFinite(profile?.beta) ? profile!.beta!.toFixed(2) : "—",
    dataFreshness: Number.isFinite(asOf.getTime())
      ? asOf.toLocaleString(displayLocale, { timeZone: "Asia/Tokyo", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "—",
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
    anchor: settings.anchor,
  };
}

function getIndicatorReading(
  id: IndicatorId,
  stock: Stock,
  bars: readonly MarketBar[],
  settings: IndicatorSettings,
) {
  const computed = computeIndicatorSeries(bars, indicatorCalculationSpec(id, settings));
  const primaryValue = latestIndicatorValue(computed);
  if (primaryValue === undefined) return "—";
  if (id === "sma20" || id === "ema50" || id === "vwap") return formatPrice(stock, primaryValue);
  if (id === "bollinger") {
    const values = latestIndicatorValues(computed);
    const upper = values.find((item) => item.key === "upper")?.value;
    const lower = values.find((item) => item.key === "lower")?.value;
    return upper === undefined || lower === undefined ? "—" : `${formatPrice(stock, upper)} / ${formatPrice(stock, lower)}`;
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
      color: adjustedClose >= open ? "rgba(0, 255, 161, .38)" : "rgba(252, 63, 66, .36)",
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
  interval,
  candleCount,
  chartType,
  activeIndicators,
  indicatorSettings,
  timeScaleSync,
}: {
  stock: Stock;
  marketBars: readonly MarketBar[];
  range: MarketBarRange;
  interval: MarketBarInterval;
  candleCount: number;
  chartType: ChartTypeId;
  activeIndicators: IndicatorId[];
  indicatorSettings: Record<IndicatorId, IndicatorSettings>;
  timeScaleSync?: ChartTimeScaleSync;
}) {
  const { locale, t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRuntimeRef = useRef<{
    chart: IChartApi;
    candleSeries: ISeriesApi<"Candlestick">;
    priceLineSeries: ISeriesApi<"Line">;
    priceAreaSeries: ISeriesApi<"Area">;
    volumeSeries: ISeriesApi<"Histogram">;
    smaSeries: ISeriesApi<"Line">;
    emaSeries: ISeriesApi<"Line">;
    bollingerUpperSeries: ISeriesApi<"Line">;
    bollingerLowerSeries: ISeriesApi<"Line">;
    vwapSeries: ISeriesApi<"Line">;
  } | null>(null);
  const chartDataLifecycleRef = useRef<ChartDataLifecycleState>(EMPTY_CHART_DATA_LIFECYCLE);
  const initialLocaleRef = useRef(locale);
  const timeScaleSyncRef = useRef(timeScaleSync);
  const fullData = useMemo(
    () => generateSeries(marketBars, indicatorSettings),
    [indicatorSettings, marketBars],
  );
  const displayCandles = useMemo(
    () => chartType === "heikin-ashi" ? toHeikinAshiBars(fullData.candles) : fullData.candles,
    [chartType, fullData.candles],
  );
  const displayVolumes = useMemo(
    () => chartType === "heikin-ashi"
      ? fullData.volumes.map((point, index) => {
        const candle = displayCandles[index];
        return {
          ...point,
          color: candle && candle.close >= candle.open
            ? "rgba(0, 255, 161, .38)"
            : "rgba(252, 63, 66, .36)",
        };
      })
      : fullData.volumes,
    [chartType, displayCandles, fullData.volumes],
  );
  const latestCandle = displayCandles.at(-1);
  const priceLineColor = latestCandle && latestCandle.close < latestCandle.open
    ? "#fc3f42"
    : "#00ffa1";
  const dataIdentity = `${stock.ticker}:${range}:${interval}:${candleCount}`;

  useEffect(() => {
    timeScaleSyncRef.current = timeScaleSync;
  }, [timeScaleSync]);

  useEffect(() => {
    if (!containerRef.current) return;
    const host = containerRef.current;
    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      autoSize: true,
      localization: { locale: chartLocaleTag(initialLocaleRef.current) },
      layout: {
        attributionLogo: false,
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#8e8e93",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
        fontSize: 15,
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
        minimumWidth: SYNCHRONIZED_PRICE_SCALE_MIN_WIDTH,
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: "#242424",
        rightOffset: 3,
        barSpacing: 7,
        minBarSpacing: 3,
        timeVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#00ffa1",
      downColor: "#fc3f42",
      borderVisible: false,
      wickUpColor: "#00ffa1",
      wickDownColor: "#fc3f42",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      priceLineColor: "#00ffa1",
      priceLineWidth: 1,
      lastValueVisible: true,
      visible: true,
    });
    const priceLineSeries = chart.addSeries(LineSeries, {
      color: "#66a3ff",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      priceLineVisible: true,
      visible: false,
    });
    const priceAreaSeries = chart.addSeries(AreaSeries, {
      lineColor: "#66a3ff",
      topColor: "rgba(41, 98, 255, 0.34)",
      bottomColor: "rgba(41, 98, 255, 0.01)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      visible: false,
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
      color: DEFAULT_INDICATOR_SETTINGS.sma20.color,
      lineWidth: DEFAULT_INDICATOR_SETTINGS.sma20.lineWidth,
      lineStyle: getChartLineStyle(DEFAULT_INDICATOR_SETTINGS.sma20.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    const emaSeries = chart.addSeries(LineSeries, {
      color: DEFAULT_INDICATOR_SETTINGS.ema50.color,
      lineWidth: DEFAULT_INDICATOR_SETTINGS.ema50.lineWidth,
      lineStyle: getChartLineStyle(DEFAULT_INDICATOR_SETTINGS.ema50.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    const bollingerUpperSeries = chart.addSeries(LineSeries, {
      color: DEFAULT_INDICATOR_SETTINGS.bollinger.color,
      lineWidth: DEFAULT_INDICATOR_SETTINGS.bollinger.lineWidth,
      lineStyle: getChartLineStyle(DEFAULT_INDICATOR_SETTINGS.bollinger.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    const bollingerLowerSeries = chart.addSeries(LineSeries, {
      color: DEFAULT_INDICATOR_SETTINGS.bollinger.color,
      lineWidth: DEFAULT_INDICATOR_SETTINGS.bollinger.lineWidth,
      lineStyle: getChartLineStyle(DEFAULT_INDICATOR_SETTINGS.bollinger.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });
    const vwapSeries = chart.addSeries(LineSeries, {
      color: DEFAULT_INDICATOR_SETTINGS.vwap.color,
      lineWidth: DEFAULT_INDICATOR_SETTINGS.vwap.lineWidth,
      lineStyle: getChartLineStyle(DEFAULT_INDICATOR_SETTINGS.vwap.lineStyle),
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
    });

    chartDataLifecycleRef.current = EMPTY_CHART_DATA_LIFECYCLE;
    chartRuntimeRef.current = {
      chart,
      candleSeries,
      priceLineSeries,
      priceAreaSeries,
      volumeSeries,
      smaSeries,
      emaSeries,
      bollingerUpperSeries,
      bollingerLowerSeries,
      vwapSeries,
    };

    return () => {
      chartRuntimeRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const runtime = chartRuntimeRef.current;
    if (!runtime) return;
    const priceFormat = stock.currency === "$"
      ? { type: "price" as const, precision: 2, minMove: 0.01 }
      : { type: "price" as const, precision: 0, minMove: 1 };
    runtime.chart.applyOptions({
      localization: { locale: chartLocaleTag(locale) },
      timeScale: { timeVisible: marketBars.some((item) => item.time.includes("T")) },
    });
    runtime.candleSeries.applyOptions({
      priceFormat,
      priceLineColor,
      visible: chartType === "candles" || chartType === "heikin-ashi",
    });
    runtime.priceLineSeries.applyOptions({ priceFormat, visible: chartType === "line" });
    runtime.priceAreaSeries.applyOptions({ priceFormat, visible: chartType === "area" });
    runtime.smaSeries.applyOptions({
      color: indicatorSettings.sma20.color,
      lineWidth: indicatorSettings.sma20.lineWidth,
      lineStyle: getChartLineStyle(indicatorSettings.sma20.lineStyle),
      visible: activeIndicators.includes("sma20"),
    });
    runtime.emaSeries.applyOptions({
      color: indicatorSettings.ema50.color,
      lineWidth: indicatorSettings.ema50.lineWidth,
      lineStyle: getChartLineStyle(indicatorSettings.ema50.lineStyle),
      visible: activeIndicators.includes("ema50"),
    });
    const bollingerOptions = {
      color: indicatorSettings.bollinger.color,
      lineWidth: indicatorSettings.bollinger.lineWidth,
      lineStyle: getChartLineStyle(indicatorSettings.bollinger.lineStyle),
      visible: activeIndicators.includes("bollinger"),
    };
    runtime.bollingerUpperSeries.applyOptions(bollingerOptions);
    runtime.bollingerLowerSeries.applyOptions(bollingerOptions);
    runtime.vwapSeries.applyOptions({
      color: indicatorSettings.vwap.color,
      lineWidth: indicatorSettings.vwap.lineWidth,
      lineStyle: getChartLineStyle(indicatorSettings.vwap.lineStyle),
      visible: activeIndicators.includes("vwap"),
    });
  }, [activeIndicators, chartType, indicatorSettings, locale, marketBars, priceLineColor, stock.currency]);

  useEffect(() => {
    const runtime = chartRuntimeRef.current;
    if (!runtime) return;
    const timeScale = runtime.chart.timeScale();
    const updatePlan = planChartDataUpdate({
      previous: chartDataLifecycleRef.current,
      identity: dataIdentity,
      pointCount: fullData.candles.length,
      visibleLogicalRange: timeScale.getVisibleLogicalRange(),
    });
    const closeData = fullData.candles.map((point) => ({ time: point.time, value: point.close }));
    runtime.candleSeries.setData(displayCandles);
    runtime.priceLineSeries.setData(closeData);
    runtime.priceAreaSeries.setData(closeData);
    runtime.volumeSeries.setData(displayVolumes);
    runtime.smaSeries.setData(fullData.sma20);
    runtime.emaSeries.setData(fullData.ema50);
    runtime.bollingerUpperSeries.setData(fullData.bollingerUpper);
    runtime.bollingerLowerSeries.setData(fullData.bollingerLower);
    runtime.vwapSeries.setData(fullData.vwap);
    chartDataLifecycleRef.current = updatePlan.nextState;

    if (updatePlan.fitContent) timeScale.fitContent();
    else if (updatePlan.visibleLogicalRange) timeScale.setVisibleLogicalRange(updatePlan.visibleLogicalRange);
    timeScaleSyncRef.current?.publish(timeScale.getVisibleLogicalRange());
  }, [dataIdentity, displayCandles, displayVolumes, fullData]);

  useEffect(() => {
    const runtime = chartRuntimeRef.current;
    if (!runtime || !timeScaleSync) return;
    const timeScale = runtime.chart.timeScale();
    const publishVisibleRange = (logicalRange: Parameters<ChartTimeScaleSync["publish"]>[0]) => {
      timeScaleSync.publish(logicalRange);
    };
    timeScale.subscribeVisibleLogicalRangeChange(publishVisibleRange);
    timeScaleSync.publish(timeScale.getVisibleLogicalRange());
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(publishVisibleRange);
  }, [timeScaleSync]);

  return <div className="chart-canvas" ref={containerRef} aria-label={t("chart.priceAria", { symbol: stock.ticker })} />;
}

const illustrativePseudoRandom = (seed: number) => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

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
      const drift = 0.00078 + Math.sin(index / 13 + seed) * 0.0011 + (illustrativePseudoRandom(seed * 13 + index) - 0.48) * 0.012;
      const benchmarkDrift = 0.00048 + Math.sin(index / 17) * 0.0007 + (illustrativePseudoRandom(seed * 7 + index) - 0.49) * 0.007;
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
        fontSize: 15,
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
      const raw = (illustrativePseudoRandom(seed * 11 + index) - 0.38) * 9.5;
      return {
        time: date.toISOString().slice(0, 10) as Time,
        value: Number(raw.toFixed(2)),
        color: raw >= 0 ? "#00ffa1" : "#fc3f42",
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
        fontSize: 15,
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

function StrategyChartUnavailable({
  className,
  title,
  message,
}: {
  className: string;
  title: string;
  message: string;
}) {
  return <div className={`${className} empty-state`} role="status" aria-label={`${title} · ${message}`} data-chart-status="unavailable"><span>{message}</span></div>;
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
  "IPO": "metric.ipo",
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
  "Altman Zスコア": "metric.altmanZScore",
  "Piotroski Fスコア": "metric.piotroskiScore",
  "浮動株比率": "metric.freeFloatRatio",
  "浮動株数": "metric.floatShares",
  "発行済株式数": "metric.outstandingShares",
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
  "Provider最新値 · 株式数": "detail.note.providerShares",
  "Provider算出値 · スコア": "detail.note.providerScore",
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

function StockDetailEmptyState({ message }: { message: ReactNode }) {
  return <div className="stock-detail-empty">{message}</div>;
}

function formatAnalystTarget(value: number | undefined, locale: Locale) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
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
  if (status === "loading") return <div className="analyst-history-state" role="status"><LoadingIndicator label={t("detail.analyst.loading")} /></div>;
  if (status === "error") return <div className="analyst-history-state is-error" role="alert">{t("detail.analyst.error")}</div>;
  const rows = [...(history?.items ?? [])].sort((left, right) => right.eventTime.localeCompare(left.eventTime));
  if (rows.length === 0) return <div className="analyst-history-state">{t("detail.analyst.empty")}</div>;
  return (
    <div className="analyst-history-table-shell">
      <table className="analyst-rating-history-table">
        <thead><tr><th>{t("detail.analyst.table.date")}</th><th>{t("detail.analyst.table.firm")}</th><th>{t("detail.analyst.table.ratingPrevious")}</th><th>{t("detail.analyst.table.ratingCurrent")}</th><th>{t("detail.analyst.table.targetPrevious")}</th><th>{t("detail.analyst.table.targetCurrent")}</th><th>{t("detail.analyst.table.accuracy")}</th></tr></thead>
        <tbody>
          {rows.map((event) => {
            const previousTarget = event.adjustedPreviousPriceTarget ?? event.previousPriceTarget;
            const ratingCurrent = event.ratingCurrent ?? event.rating;
            const targetChangeTone = analystTargetChangeTone(event);
            const success = typeof event.overallSuccessRate === "number"
              ? `${(Math.abs(event.overallSuccessRate) <= 1 ? event.overallSuccessRate * 100 : event.overallSuccessRate).toFixed(1)}%`
              : "—";
            return (
              <tr key={event.eventId}>
                <td><strong>{event.sourceEventDate}</strong><small>{event.actionPriceTarget ?? event.action ?? t("detail.analyst.updated")}</small></td>
                <td><strong>{event.analystFirm ?? "—"}</strong><small>{event.analystName ?? "—"}</small></td>
                <td className="analyst-rating-cell analyst-rating-previous">{event.ratingPrior ?? "—"}</td>
                <td className={`analyst-rating-cell analyst-change-${analystRatingChangeTone(event)}`}>{ratingCurrent ?? "—"}</td>
                <td className="analyst-target-cell analyst-target-previous">{formatAnalystTarget(previousTarget, locale)}</td>
                <td className={`analyst-target-cell analyst-change-${targetChangeTone}`}>{formatAnalystTarget(event.effectivePriceTarget, locale)}</td>
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
  if (status === "loading") return <LoadingIndicator label={t("detail.empty.loading", { subject })} />;
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
  emptyMessage: ReactNode;
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
  financial_health: {
    eyebrow: "HEALTH & SHARE STRUCTURE",
    titleKey: "detail.section.financialHealth",
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

const FUNDAMENTAL_METRIC_GROUPS = traderConfig.ui.symbolDetail.fundamentalGroups.map((group) => ({
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

function CompanyProfileSection({
  profile,
  emptyMessage,
}: {
  profile: StockDetailViewModel["profile"];
  emptyMessage: ReactNode;
}) {
  const { locale, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const metrics = configuredStockDetailMetrics(
    profile.metrics,
    traderConfig.ui.symbolDetail.profileMetrics,
  );
  const description = profile.description?.trim() ?? "";
  const descriptionIsExpandable = description.length > 240;

  return (
    <section className="stock-detail-profile-card">
      <header className="stock-detail-section-heading">
        <div><span className="eyebrow">COMPANY PROFILE</span><h2>{t("detail.section.companyProfile")}</h2></div>
      </header>
      {description ? (
        <>
          <p className={descriptionIsExpandable && !expanded ? "clamped" : "expanded"}>{description}</p>
          {descriptionIsExpandable && (
            <button
              type="button"
              className="stock-detail-description-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {t(expanded ? "detail.profile.showLess" : "detail.profile.showMore")}
            </button>
          )}
        </>
      ) : metrics.length > 0 ? <p className="stock-detail-inline-empty">{emptyMessage}</p> : null}
      {metrics.length > 0 ? (
        <dl>
          {metrics.map((metric) => (
            <div key={metric.id}>
              <dt>{stockDetailMetricLabel(metric.label, t)}</dt>
              <dd>
                {metric.href ? (
                  <a href={metric.href} target="_blank" rel="noreferrer">{stockDetailMetricValue(metric, locale, t)}</a>
                ) : stockDetailMetricValue(metric, locale, t)}
              </dd>
            </div>
          ))}
        </dl>
      ) : !description ? <StockDetailEmptyState message={emptyMessage} /> : null}
      <div className="stock-detail-profile-source"><DetailSourceChip source={profile.source} /></div>
    </section>
  );
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
  emptyMessage: ReactNode;
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
  emptyMessage: ReactNode;
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
const STOCK_DETAIL_TABS = traderConfig.ui.symbolDetail.tabs.map((id) => ({
  id,
  labelKey: STOCK_DETAIL_TAB_LABEL_KEYS[id],
}));
const DEFAULT_STOCK_DETAIL_TAB = traderConfig.ui.symbolDetail.tabs[0];
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
  activeSection,
  onBack,
  onActiveSectionChange,
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
  activeSection: StockDetailTabId;
  onBack: () => void;
  onActiveSectionChange: (section: StockDetailTabId) => void;
  onToggleWatched: () => void;
}) {
  const { t } = useI18n();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const identity = detail.identity;
  const quote = detail.quote;
  const identityMeta = [identity?.exchange ?? stock.market, identity?.sector].filter(Boolean).join(" · ");
  const detailStatus = dataStatus === "loading"
    ? <LoadingIndicator label={t("detail.status.loading")} />
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
        {STOCK_DETAIL_TABS.map(({ id, labelKey }) => <button type="button" role="tab" id={`stock-detail-tab-${id}`} aria-controls={`stock-detail-panel-${id}`} aria-selected={activeSection === id} className={activeSection === id ? "active" : ""} key={id} onClick={() => {
          onActiveSectionChange(id);
        }}>{t(labelKey)}</button>)}
      </nav>
      <div className="stock-detail-body">
        <div className="stock-detail-content stock-detail-content-one-column">
          {activeSection === "financials" && <section className="stock-detail-tab-panel stock-detail-section" id="stock-detail-panel-financials" role="tabpanel" aria-labelledby="stock-detail-tab-financials">
            <header className="stock-detail-section-heading"><div><span className="eyebrow">FUNDAMENTALS & EARNINGS</span><h2>{t("detail.section.financials")}</h2></div></header>
            <CompanyProfileSection key={stock.ticker} profile={detail.profile} emptyMessage={detailEmptyMessage(workspaceStatus, "detail.subject.profile", t)} />
            <FundamentalMetricSections source={detail.fundamentals.source} context={detail.fundamentals.context} metrics={detail.fundamentals.metrics} emptyMessage={detailEmptyMessage(workspaceStatus, "detail.subject.fundamentals", t)} />
            <EarningsActualEstimateChart earnings={earnings} />
            <EarningsSection earnings={earnings} source={detail.earnings.source} emptyMessage={detailEmptyMessage(workspaceStatus, "detail.subject.earnings", t)} />
          </section>}

          {activeSection === "analyst" && <section className="stock-detail-tab-panel stock-detail-section" id="stock-detail-panel-analyst" role="tabpanel" aria-labelledby="stock-detail-tab-analyst">
            <header className="stock-detail-section-heading"><div><span className="eyebrow">ANALYST CONSENSUS</span><h2>{t("detail.section.analyst")}</h2></div></header>
            <AnalystTargetHistoryChart history={analystHistory} marketBars={targetPriceMarketBars} />
            <MetricSection eyebrow="TARGETS & RATINGS" title={t("detail.section.targetRatings")} source={detail.analyst.source} metrics={configuredStockDetailMetrics(detail.analyst.metrics, traderConfig.ui.symbolDetail.analystMetrics)} emptyMessage={detailEmptyMessage(workspaceStatus, "detail.subject.analyst", t)} />
            <section className="stock-detail-analyst-history" aria-label={t("detail.section.targetHistory")}>
              <header><div><span className="eyebrow">BENZINGA RATINGS</span><h2>{t("detail.section.targetHistory")}</h2></div><small>{analystHistory?.dateFrom ?? ""}{analystHistory?.dateTo ? ` — ${analystHistory.dateTo}` : ""}</small></header>
              <AnalystRatingHistoryTable history={analystHistory} status={analystHistoryStatus} />
            </section>
          </section>}

          {activeSection === "technicals" && <section className="stock-detail-tab-panel stock-detail-section" id="stock-detail-panel-technicals" role="tabpanel" aria-labelledby="stock-detail-tab-technicals">
            <header className="stock-detail-section-heading"><div><span className="eyebrow">MARKET & TECHNICALS</span><h2>{t("detail.section.technicals")}</h2></div></header>
            <TechnicalRatingsPanel summary={detail.technicalRatings} />
            <div className="stock-detail-card-grid two-columns">
              <MetricSection eyebrow="QUOTE" title={t("detail.section.marketSnapshot")} source={detail.market.source} context={detail.market.context} metrics={configuredStockDetailMetrics(detail.market.metrics, traderConfig.ui.symbolDetail.marketMetrics)} emptyMessage={detailEmptyMessage(workspaceStatus, "detail.subject.market", t)} />
              <MetricSection eyebrow="CALCULATED FROM OHLCV" title={t("detail.section.technicalMetrics")} source={detail.technicals.source} context={detail.technicals.context} metrics={configuredStockDetailMetrics(detail.technicals.metrics, traderConfig.ui.symbolDetail.technicalMetrics)} emptyMessage={detailEmptyMessage(barsStatus, "detail.subject.technicals", t)} />
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
    ? "オフセットと時間足別表示は現在の描画エンジンでは未対応です。"
    : "Offset and interval-specific visibility are not supported by the current renderer.";

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
              {indicator.id === "vwap" && <label><span>{indicatorText(locale, "anchorPeriod")}</span><select value={draft.anchor} onChange={(event) => setDraft((current) => ({ ...current, anchor: event.target.value as IndicatorSettings["anchor"] }))}>{["セッション", "週", "月", "四半期", "年"].map((item) => <option value={item} key={item}>{localizeIndicatorAnchor(locale, item)}</option>)}</select></label>}
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
  const fallbackStrategy = useMemo<StrategyRecord>(() => {
    const strategy = baseStrategies[0];
    return {
      ...strategy,
      origin: "built_in",
      version: 1,
      performance: {
        provenance: "illustrative_catalog",
        netReturn: strategy.netReturn,
        maxDrawdown: strategy.maxDrawdown,
        recoveryFactor: strategy.recoveryFactor,
        sharpe: strategy.sharpe,
        forwardReturn: strategy.forwardReturn,
        winRate: strategy.winRate,
        trades: strategy.trades,
        symbols: strategy.symbols,
        cash: strategy.cash,
      },
      createdAt: null,
      updatedAt: null,
    };
  }, [baseStrategies]);
  const [strategyRecords, setStrategyRecords] = useState<StrategyRecord[] | null>(null);
  const strategies = strategyRecords ?? [];
  const [strategyCatalogStatus, setStrategyCatalogStatus] = useState<"loading" | "ready" | "error">("loading");
  const [strategyMutationStatus, setStrategyMutationStatus] = useState<"idle" | "creating" | "duplicating" | "saving" | "deleting">("idle");
  const [strategyMutationError, setStrategyMutationError] = useState<"request" | "conflict" | null>(null);
  const [strategyRefreshVersion, setStrategyRefreshVersion] = useState(0);
  const strategyCatalogReadControllerRef = useRef<AbortController | null>(null);
  const strategyCatalogReadEpochRef = useRef(0);
  const [strategyMarketMarks, setStrategyMarketMarks] = useState<Readonly<Record<string, StrategyMarketMark>>>({});
  const [strategyStockModels, setStrategyStockModels] = useState<Readonly<Record<string, Stock>>>(() => (
    Object.fromEntries(STOCKS.map((item) => [item.ticker, stockIdentityPlaceholder(item)]))
  ));
  const [settingsName, setSettingsName] = useState("");
  const [settingsHeadline, setSettingsHeadline] = useState("");
  const [createName, setCreateName] = useState("");
  const [createHeadline, setCreateHeadline] = useState("");
  const [createCategory, setCreateCategory] = useState("");
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
  const [strategyDuration, setStrategyDuration] = useState<StrategyDuration>("1Y");
  const [strategySortKey, setStrategySortKey] = useState<StrategySortKey>("profit");
  const [strategySortDirection, setStrategySortDirection] = useState<"asc" | "desc">("desc");
  const [strategyQuery, setStrategyQuery] = useState("");
  const [strategyCategory, setStrategyCategory] = useState("すべて");
  const [strategyStatus, setStrategyStatus] = useState<"すべて" | "採用済み" | "未採用">("すべて");
  const [transactionTicker, setTransactionTicker] = useState("AAPL");
  const [transactionSide, setTransactionSide] = useState<PortfolioTransaction["side"]>("買付");
  const [transactionShares, setTransactionShares] = useState("10");
  const [transactionPrice, setTransactionPrice] = useState("");
  const activeStrategyDurationLabel = strategyDurationLabel(locale, strategyDuration);
  const selected = strategies.find((strategy) => strategy.id === selectedId) ?? strategies[0] ?? fallbackStrategy;
  const strategyCatalogReady = strategyRecords !== null;
  const selectedStrategyIsVisible = strategies.some((strategy) => strategy.id === selected.id);
  const transactions = transactionsByStrategy[selected.id] ?? [];
  useEffect(() => {
    selectedStrategyIdRef.current = selected.id;
  }, [selected.id]);
  const selectedCatalogIndex = Math.max(0, baseStrategies.findIndex((strategy) => strategy.id === selected.id));
  const illustrativeStrategyChartsAvailable = selected.origin === "built_in"
    && selected.performance.provenance === "illustrative_catalog";
  const samplePortfolioHoldings = useMemo(
    () => selected.origin === "built_in"
      ? samplePortfolioHoldingsForStrategy(selected.id)
      : Object.freeze([]),
    [selected.id, selected.origin],
  );
  const markedPortfolio = useMemo(
    () => markSamplePortfolio(samplePortfolioHoldings, strategyMarketMarks, selected.cash),
    [samplePortfolioHoldings, selected.cash, strategyMarketMarks],
  );
  const portfolioHoldings = markedPortfolio.holdings;
  const unrealizedGain = markedPortfolio.unrealizedGain ?? 0;
  const { cashValue, cards: strategySummaryCards } = buildStrategySummaryMetricRegistry({
    selected,
    selectedCatalogIndex,
    unrealizedGain,
    ...(markedPortfolio.holdingsValue === null
      ? {}
      : { holdingsMarketValue: markedPortfolio.holdingsValue }),
    translate: st,
  });
  const isStrategySummaryMetricAvailable = (id: string) => {
    if (selected.origin === "built_in") {
      if (id === "portfolio.value" || id === "portfolio.unrealizedGain") {
        return markedPortfolio.complete;
      }
      return true;
    }
    if (id === "portfolio.totalGain" || id === "portfolio.annualReturn") {
      return selected.performance.netReturn !== null;
    }
    if (id === "risk.sharpe") return selected.performance.sharpe !== null;
    if (id === "risk.maxDrawdown") return selected.performance.maxDrawdown !== null;
    return false;
  };
  const holdingRows = showSold && selected.origin === "built_in"
    ? [...portfolioHoldings, { ticker: "META", shares: 0, average: 478.2, currentPrice: null, value: 0, allocation: 0, daily: null, unrealized: 4832, beta: 1.22, rsi: 53.9, performance1M: 8.1, technicalRating: "買い" as const }]
    : portfolioHoldings;
  const durationFactor: Record<StrategyDuration, number> = { "1M": 0.12, "3M": 0.31, "6M": 0.58, "1Y": 1, "3Y": 1.68, "全期間": 2.14 };
  const performanceProvenanceLabel = (strategy: StrategyRecord) => {
    if (strategy.performance.provenance === "illustrative_catalog") return st("sample.badge");
    if (strategy.performance.provenance === "user_supplied") return st("sample.userSupplied");
    if (strategy.performance.provenance === "transaction_snapshot") return st("sample.transactionSnapshot");
    return st("sample.unavailable");
  };
  const metricsFor = (strategy: StrategyRecord) => {
    if (strategy.performance.provenance !== "illustrative_catalog") {
      return {
        profit: strategy.performance.netReturn,
        maxDrawdown: strategy.performance.maxDrawdown,
        recoveryFactor: strategy.performance.recoveryFactor,
        sharpe: strategy.performance.sharpe,
        winRate: strategy.performance.winRate,
      };
    }
    const factor = durationFactor[strategyDuration];
    const profit = strategy.performance.netReturn === null
      ? null
      : strategy.performance.netReturn * factor;
    const maxDrawdown = strategy.performance.maxDrawdown === null
      ? null
      : strategy.performance.maxDrawdown * Math.min(1.22, 0.38 + factor * 0.62);
    const recoveryFactor = profit === null || maxDrawdown === null
      ? null
      : Math.abs(maxDrawdown) > 0 ? profit / Math.abs(maxDrawdown) : 0;
    const sharpe = strategy.performance.sharpe === null
      ? null
      : strategy.performance.sharpe * (0.84 + Math.min(factor, 1.4) * 0.16);
    const winRate = strategy.performance.winRate === null
      ? null
      : 50 + (strategy.performance.winRate - 50) * (0.72 + Math.min(factor, 1.2) * 0.28);
    return { profit, maxDrawdown, recoveryFactor, sharpe, winRate };
  };
  const strategyStockFor = (ticker: string) => strategyStockModels[ticker]
    ?? tickerIdentityPlaceholder(ticker);
  const portfolioMoney = (value: number | null) => value === null
    ? "—"
    : `$${Math.round(value).toLocaleString("en-US")}`;
  const signedPortfolioMoney = (value: number | null) => value === null
    ? "—"
    : `${value >= 0 ? "+" : "-"}$${Math.abs(Math.round(value)).toLocaleString("en-US")}`;
  const portfolioPercent = (value: number | null, signed = false) => value === null
    ? "—"
    : `${signed && value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
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
  const profitableCount = listedStrategies.filter((strategy) => (metricsFor(strategy).profit ?? Number.NEGATIVE_INFINITY) > 0).length;
  const strategiesWithSharpe = listedStrategies.filter((strategy) => metricsFor(strategy).sharpe !== null);
  const averageSharpe = strategiesWithSharpe.length
    ? strategiesWithSharpe.reduce((sum, strategy) => sum + (metricsFor(strategy).sharpe ?? 0), 0) / strategiesWithSharpe.length
    : null;
  const bestStrategy = [...listedStrategies]
    .filter((strategy) => metricsFor(strategy).profit !== null)
    .sort((a, b) => (metricsFor(b).profit ?? Number.NEGATIVE_INFINITY) - (metricsFor(a).profit ?? Number.NEGATIVE_INFINITY))[0];

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
    const providerPrice = strategyMarketMarks[ticker]?.price
      ?? strategyStockModels[ticker]?.price;
    setTransactionTicker(ticker);
    setTransactionPrice(
      Number.isFinite(providerPrice) && (providerPrice ?? 0) > 0
        ? String(providerPrice)
        : "",
    );
    setDialog("transaction");
  };

  const upsertStrategyRecord = (strategy: StrategyApiRecord) => {
    const normalized = strategyRecordFromApi(strategy);
    setStrategyRecords((current) => {
      const records = current ?? [];
      const existingIndex = records.findIndex((item) => item.id === normalized.id);
      if (existingIndex < 0) return [normalized, ...records];
      return records.map((item) => item.id === normalized.id ? normalized : item);
    });
  };

  const invalidateStrategyCatalogRead = () => {
    strategyCatalogReadEpochRef.current += 1;
    strategyCatalogReadControllerRef.current?.abort();
    strategyCatalogReadControllerRef.current = null;
  };

  const refreshStrategyCatalog = () => {
    setStrategyCatalogStatus("loading");
    setStrategyMutationError(null);
    setStrategyRefreshVersion((current) => current + 1);
  };

  const markStrategyMutationFailure = (status: number) => {
    setStrategyMutationError(status === 409 ? "conflict" : "request");
  };

  const openStrategySettings = () => {
    setSettingsName(selected.name);
    setSettingsHeadline(selected.headline);
    setStrategyMutationError(null);
    setDialog("settings");
  };

  const openCreateStrategy = () => {
    setCreateName("");
    setCreateHeadline("");
    setCreateCategory("");
    setStrategyMutationError(null);
    setDialog("create");
  };

  useEffect(() => {
    const controller = new AbortController();
    strategyCatalogReadControllerRef.current?.abort();
    strategyCatalogReadControllerRef.current = controller;
    const requestEpoch = strategyCatalogReadEpochRef.current + 1;
    strategyCatalogReadEpochRef.current = requestEpoch;
    void fetch(`/api/v1/strategies?locale=${encodeURIComponent(locale)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("strategy catalog request failed");
        return response.json() as Promise<StrategiesResponse>;
      })
      .then((payload) => {
        if (controller.signal.aborted || strategyCatalogReadEpochRef.current !== requestEpoch) return;
        const visibleStrategies = payload.strategies.map(strategyRecordFromApi);
        setStrategyRecords(visibleStrategies);
        setSelectedId((current) => visibleStrategies.some((strategy) => strategy.id === current)
          ? current
          : visibleStrategies[0]?.id ?? DEFAULT_SAMPLE_STRATEGY_ID);
        setStrategyCatalogStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (strategyCatalogReadEpochRef.current !== requestEpoch) return;
        setStrategyCatalogStatus("error");
      });
    return () => {
      controller.abort();
      if (strategyCatalogReadControllerRef.current === controller) {
        strategyCatalogReadControllerRef.current = null;
      }
    };
  }, [locale, strategyRefreshVersion]);

  useEffect(() => {
    if (screen !== "detail") return;
    const controller = new AbortController();
    const symbols = [...STRATEGY_MARKET_SYMBOLS];
    const quoteRequest = fetch("/api/v1/watchlists/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols }),
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => response.ok
        ? response.json() as Promise<WatchlistQuotesResponse>
        : null)
      .catch(() => null);
    const barsRequest = Promise.all(symbols.map(async (symbol) => {
      try {
        const response = await fetch(
          `/api/v1/symbols/${encodeURIComponent(symbol)}/bars?range=5d&interval=1d&count=3`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) return [symbol, []] as const;
        const payload = await response.json() as MarketBarsResponse;
        return [
          symbol,
          payload.dataMode === "provider" ? payload.bars.items : [],
        ] as const;
      } catch {
        return [symbol, []] as const;
      }
    }));

    void Promise.all([quoteRequest, barsRequest]).then(([quoteResponse, barEntries]) => {
      if (controller.signal.aborted) return;
      const quoteItems = new Map(
        (quoteResponse?.dataMode === "provider" ? quoteResponse.items : [])
          .map((item) => [item.symbol, item] as const),
      );
      const barsBySymbol = new Map(barEntries);
      const nextMarks: Record<string, StrategyMarketMark> = {};
      const nextStocks: Record<string, Stock> = {};
      for (const symbol of symbols) {
        const item = quoteItems.get(symbol);
        const mark = strategyMarketMark(item?.quote ?? null, barsBySymbol.get(symbol) ?? []);
        if (!mark) continue;
        nextMarks[symbol] = mark;
        const staticStock = tickerIdentityPlaceholder(symbol);
        const quoteStock = item ? watchlistQuoteStock(item, staticStock) : null;
        const identityStock = item?.instrument
          ? instrumentPlaceholder(item.instrument)
          : staticStock;
        const changeValue = mark.changePercent === null || mark.changePercent <= -100
          ? 0
          : mark.price - mark.price / (1 + mark.changePercent / 100);
        nextStocks[symbol] = {
          ...(quoteStock ?? identityStock),
          price: mark.price,
          change: mark.changePercent ?? 0,
          changeValue,
        };
      }
      setStrategyMarketMarks(Object.freeze(nextMarks));
      setStrategyStockModels((current) => Object.freeze({ ...current, ...nextStocks }));
    });

    return () => controller.abort();
  }, [screen, strategyRefreshVersion]);

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
    if (
      !Number.isFinite(shares)
      || shares <= 0
      || !transactionPrice.trim()
      || !Number.isFinite(price)
      || price < 0
    ) {
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

    invalidateStrategyCatalogRead();
    setStrategyMutationError(null);
    setStrategyMutationStatus("saving");
    let conflict = false;
    try {
      const response = await fetch(
        `/api/v1/strategies/${encodeURIComponent(selected.id)}?locale=${encodeURIComponent(locale)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...changes,
            ...(selected.origin === "custom" ? { expectedVersion: selected.version } : {}),
          }),
        },
      );
      if (!response.ok) {
        conflict = response.status === 409;
        markStrategyMutationFailure(response.status);
        throw new Error("strategy save failed");
      }
      const payload = await response.json() as StrategyMutationResponse;
      upsertStrategyRecord(payload.strategy);
      setStrategyCatalogStatus("ready");
      setStrategyMutationStatus("idle");
      setDialog(null);
      onAction(st("toast.settingsSaved"));
    } catch {
      setStrategyMutationStatus("idle");
      onAction(st(conflict ? "toast.strategyConflict" : "toast.settingsSaveFailed"));
    }
  };

  const createStrategy = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = createName.trim();
    const headline = createHeadline.trim();
    const category = createCategory.trim();
    if (!name || !headline || name.length > 120 || headline.length > 500) return;

    invalidateStrategyCatalogRead();
    setStrategyMutationError(null);
    setStrategyMutationStatus("creating");
    try {
      const response = await fetch("/api/v1/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          headline,
          ...(category ? { category } : {}),
          family: "research",
          status: "research",
          sourceLabels: [],
        }),
      });
      if (!response.ok) {
        markStrategyMutationFailure(response.status);
        throw new Error("strategy create failed");
      }
      const payload = await response.json() as StrategyMutationResponse;
      upsertStrategyRecord(payload.strategy);
      selectPortfolio(payload.strategy.id);
      setScreen("detail");
      setDialog(null);
      setStrategyCatalogStatus("ready");
      setStrategyMutationStatus("idle");
      onAction(st("toast.portfolioCreated"));
    } catch {
      setStrategyMutationStatus("idle");
      onAction(st("toast.portfolioCreateFailed"));
    }
  };

  const duplicateSelectedStrategy = async () => {
    invalidateStrategyCatalogRead();
    setStrategyMutationError(null);
    setStrategyMutationStatus("duplicating");
    const duplicateName = st("duplicate.name", { name: selected.name }).slice(0, 120);
    const performance = {
      netReturn: selected.performance.netReturn,
      maxDrawdown: selected.performance.maxDrawdown,
      recoveryFactor: selected.performance.recoveryFactor,
      sharpe: selected.performance.sharpe,
      forwardReturn: selected.performance.forwardReturn,
      winRate: selected.performance.winRate,
      trades: selected.performance.trades,
      symbols: selected.performance.symbols,
      cash: selected.performance.cash,
    };
    try {
      const response = await fetch("/api/v1/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: duplicateName,
          headline: selected.headline,
          family: selected.family,
          status: selected.status,
          category: selected.category,
          sourceLabels: selected.sourceLabels,
          audit: selected.audit,
          ...(selected.performance.provenance === "user_supplied" ? { performance } : {}),
        }),
      });
      if (!response.ok) {
        markStrategyMutationFailure(response.status);
        throw new Error("strategy duplicate failed");
      }
      const payload = await response.json() as StrategyMutationResponse;
      upsertStrategyRecord(payload.strategy);
      selectPortfolio(payload.strategy.id);
      setDialog(null);
      setStrategyCatalogStatus("ready");
      setStrategyMutationStatus("idle");
      onAction(st("toast.portfolioDuplicated"));
    } catch {
      setStrategyMutationStatus("idle");
      onAction(st("toast.portfolioDuplicateFailed"));
    }
  };

  const deleteSelectedStrategy = async () => {
    if (strategies.length <= 1) {
      onAction(st("toast.lastStrategyRequired"));
      return;
    }
    const currentIndex = strategies.findIndex((strategy) => strategy.id === selected.id);
    const fallback = strategies[currentIndex + 1] ?? strategies[currentIndex - 1] ?? strategies[0];
    invalidateStrategyCatalogRead();
    setStrategyMutationError(null);
    setStrategyMutationStatus("deleting");
    let conflict = false;
    try {
      const versionQuery = selected.origin === "custom"
        ? `?expectedVersion=${encodeURIComponent(String(selected.version))}`
        : "";
      const response = await fetch(
        `/api/v1/strategies/${encodeURIComponent(selected.id)}${versionQuery}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        if (payload?.error?.code === "last_visible_strategy") {
          onAction(st("toast.lastStrategyRequired"));
          setStrategyMutationStatus("idle");
          return;
        }
        conflict = response.status === 409;
        markStrategyMutationFailure(response.status);
        throw new Error("strategy delete failed");
      }
      setStrategyRecords((current) => current?.filter((strategy) => strategy.id !== selected.id) ?? null);
      selectPortfolio(fallback.id);
      setTab("概要");
      setScreen("index");
      setDialog(null);
      setStrategyCatalogStatus("ready");
      setStrategyMutationStatus("idle");
      onAction(st("toast.portfolioDeleted"));
    } catch {
      setStrategyMutationStatus("idle");
      onAction(st(conflict ? "toast.strategyConflict" : "toast.portfolioDeleteFailed"));
    }
  };

  const strategyNotice = strategyMutationError === "conflict" ? (
    <div className="strategy-request-notice conflict" role="alert">
      <span><strong>{st("notice.conflictTitle")}</strong>{st("notice.conflictDescription")}</span>
      <button type="button" onClick={refreshStrategyCatalog}>{st("notice.reload")}</button>
    </div>
  ) : strategyMutationError === "request" || strategyCatalogStatus === "error" ? (
    <div className="strategy-request-notice error" role="alert">
      <span><strong>{st("notice.errorTitle")}</strong>{st("notice.errorDescription")}</span>
      <button type="button" onClick={refreshStrategyCatalog}>{st("notice.retry")}</button>
    </div>
  ) : strategyCatalogStatus === "loading" ? (
    <div className="strategy-request-notice loading" role="status">
      <LoadingIndicator label={st("notice.loading")} />
    </div>
  ) : null;

  if (screen === "index") {
    return (
      <section className="strategy-home-shell portfolio-index-shell strategy-report-shell" aria-label={st("index.aria")}>
        <header className="portfolio-index-header strategy-report-header">
          <div><h1>{st("index.title")}</h1></div>
          <div><button type="button" onClick={() => { refreshStrategyCatalog(); onAction(st("toast.strategyRefreshed")); }}><ClockCounterClockwise size={15} /> {st("action.refresh")}</button><button type="button" className="primary-action" disabled={!strategyCatalogReady || strategyMutationStatus !== "idle"} onClick={openCreateStrategy}><Plus size={16} /> {st("action.addStrategy")}</button></div>
        </header>
        <div className={`portfolio-index-content strategy-report-content ${strategyNotice ? "has-notice" : ""}`}>
          {strategyNotice}
          <section className="strategy-report-kpis" aria-label={st("summary.aria")}>
            <div><span>{st("summary.visible")}</span><strong>{listedStrategies.length}</strong></div>
            <div><span>{st("summary.profitable")}</span><strong>{profitableCount} / {listedStrategies.length}</strong><small>{st("summary.periodEvaluation", { period: activeStrategyDurationLabel })}</small></div>
            <div><span>{st("summary.bestProfit")}</span><strong className="positive">{bestStrategy ? `+${(metricsFor(bestStrategy).profit ?? 0).toFixed(1)}%` : "—"}</strong><small>{bestStrategy?.name ?? st("common.none")}</small></div>
            <div><span>{st("summary.averageSharpe")}</span><strong>{averageSharpe?.toFixed(2) ?? "—"}</strong></div>
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
                {listedStrategies.some((item) => item.performance.forwardReturn !== null) && <th>{st("table.custom")}</th>}
                <th aria-sort={strategySortKey === "winRate" ? (strategySortDirection === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => applyStrategySort("winRate")}>{st("table.winRate", { period: activeStrategyDurationLabel })} <CaretDown size={11} /></button></th>
              </tr></thead>
              <tbody>
                {listedStrategies.map((strategy) => {
                  const metric = metricsFor(strategy);
                  const riskTone = (score: number) => score >= 65 ? "high" : score >= 40 ? "medium" : "low";
                  return <tr key={strategy.id}>
                    <td><span className="candidate-date" title={strategy.candidateAt}>{strategy.candidateAt.split(" ")[0]}</span></td>
                    <td><span className="strategy-category" title={strategy.sourceLabels.join(" · ")}>{strategy.category}</span></td>
                    <td><button type="button" className="strategy-name-cell" title={strategy.headline} onClick={() => openPortfolio(strategy.id)}><span><strong>{strategy.name}</strong></span><span className="strategy-name-badges"><i className={`strategy-sample-badge ${strategy.performance.provenance}`}>{performanceProvenanceLabel(strategy)}</i>{strategy.status === "pinned" && <i className={`strategy-status ${strategy.status}`}>{st("filter.adopted")}</i>}<i>{st("table.symbolCount", { count: strategy.performance.symbols ?? "—" })}</i><i>{st("table.tradeCount", { count: strategy.performance.trades ?? "—" })}</i></span><CaretRight size={15} /></button></td>
                    <td className={metric.profit === null ? "" : metric.profit >= 0 ? "positive" : "negative-text"}><strong>{metric.profit === null ? "—" : `${metric.profit >= 0 ? "+" : ""}${metric.profit.toFixed(1)}%`}</strong></td>
                    <td className={metric.maxDrawdown === null ? "" : "negative-text"}><strong>{metric.maxDrawdown === null ? "—" : `${metric.maxDrawdown.toFixed(1)}%`}</strong></td>
                    <td><strong>{metric.recoveryFactor?.toFixed(2) ?? "—"}</strong></td>
                    <td><strong>{metric.sharpe?.toFixed(2) ?? "—"}</strong></td>
                    <td><div className="strategy-audit-cell" title={strategy.audit.verdict}>{strategy.audit.overfit === null && strategy.audit.leakage === null ? <span>—</span> : <span>{strategy.audit.overfit === null ? <i>{st("audit.overfitNotEvaluated")}</i> : <i className={riskTone(strategy.audit.overfit)}>{st("audit.overfit", { score: strategy.audit.overfit })}</i>}{strategy.audit.leakage === null ? <i>{st("audit.leakageNotEvaluated")}</i> : <i className={riskTone(strategy.audit.leakage)}>{st("audit.leakage", { score: strategy.audit.leakage })}</i>}</span>}</div></td>
                    {listedStrategies.some((item) => item.performance.forwardReturn !== null) && <td><div className="strategy-custom-cell"><strong className={strategy.performance.forwardReturn === null ? "" : strategy.forwardReturn >= 0 ? "positive" : "negative-text"}>{strategy.performance.forwardReturn === null ? "—" : `${strategy.forwardReturn >= 0 ? "+" : ""}${strategy.forwardReturn.toFixed(1)}%`}</strong><small>{strategy.performance.provenance === "illustrative_catalog" ? st("sample.illustrative") : performanceProvenanceLabel(strategy)}</small></div></td>}
                    <td><strong>{metric.winRate === null ? "—" : `${metric.winRate.toFixed(1)}%`}</strong></td>
                  </tr>;
                })}
              </tbody>
            </table>
            {listedStrategies.length === 0 && <div className="strategy-report-empty"><MagnifyingGlass size={24} /><strong>{st("empty.title")}</strong><span>{st("empty.description")}</span></div>}
          </div>
        </div>
        <footer className="strategy-status-bar"><span><span /> {strategyCatalogStatus === "loading" ? <LoadingIndicator /> : st("status.catalog", { status: strategyCatalogStatus === "ready" ? st("common.connected") : strategyCatalogStatus === "error" ? st("common.error") : "" })}</span></footer>
        {dialog === "create" && (
          <DialogShell title={st("create.title")} eyebrow={st("create.eyebrow")} onClose={() => setDialog(null)}>
            <form className="dialog-body dialog-form-grid" onSubmit={createStrategy}>
              <label><span>{st("settings.name")}</span><input value={createName} required maxLength={120} onChange={(event) => setCreateName(event.target.value)} autoFocus /></label>
              <label><span>{st("settings.description")}</span><textarea value={createHeadline} required maxLength={500} onChange={(event) => setCreateHeadline(event.target.value)} /></label>
              <label><span>{st("filter.category")}</span><input value={createCategory} maxLength={120} placeholder={st("create.categoryPlaceholder")} onChange={(event) => setCreateCategory(event.target.value)} /></label>
              {strategyMutationError && <small className="strategy-dialog-error" role="alert">{st(strategyMutationError === "conflict" ? "notice.conflictDescription" : "notice.errorDescription")}</small>}
              <footer className="dialog-actions form-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="submit" className="primary-action" disabled={strategyMutationStatus !== "idle" || !createName.trim() || !createHeadline.trim()}>{strategyMutationStatus === "creating" ? st("create.creating") : st("create.action")}</button></footer>
            </form>
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
          <button type="button" onClick={refreshStrategyCatalog}><ClockCounterClockwise size={16} /> {st("action.refresh")}</button>
          <button type="button" className="primary-action" onClick={() => openTransaction()}><Plus size={16} /> {st("detail.addTransaction")}</button>
          <div className="portfolio-menu-host" ref={portfolioMenuHostRef}><IconButton label={st("detail.portfolioMenu")} hasPopup="menu" expanded={portfolioMenuOpen} controls="portfolio-actions-menu" onClick={() => setPortfolioMenuOpen((value) => !value)}><DotsThree size={19} /></IconButton>{portfolioMenuOpen && <div id="portfolio-actions-menu" className="portfolio-menu" role="menu"><button type="button" disabled={strategyMutationStatus !== "idle"} onClick={() => { setPortfolioMenuOpen(false); openStrategySettings(); }}><Gear size={15} /> {st("detail.editStrategy")}</button><button type="button" disabled={strategyMutationStatus !== "idle"} onClick={() => { setPortfolioMenuOpen(false); void duplicateSelectedStrategy(); }}><Copy size={15} /> {strategyMutationStatus === "duplicating" ? st("duplicate.duplicating") : st("common.duplicate")}</button><button type="button" className="danger" disabled={strategies.length <= 1 || strategyMutationStatus !== "idle"} onClick={() => { setPortfolioMenuOpen(false); setStrategyMutationError(null); setDialog("delete"); }}><Trash size={15} /> {st("common.delete")}</button></div>}</div>
        </div>
      </header>
      <div className="portfolio-detail-scroll">
        {strategyNotice}
        <section className="portfolio-summary-cards" aria-label={st("portfolio.summaryAria")}>
          {traderConfig.ui.strategyDetail.summaryMetrics.map((id) => {
            const metric = strategySummaryCards[id];
            const available = isStrategySummaryMetricAvailable(id);
            return <div key={id} data-metric-id={id}><span>{metric.label}</span><strong className={available ? metric.tone : undefined}>{available ? metric.value : "—"}</strong><small className={available ? metric.tone : undefined}>{available ? metric.note : st("sample.unavailable")}</small></div>;
          })}
        </section>
        <nav className="portfolio-primary-tabs" role="tablist" aria-label={st("portfolio.viewAria")}>
          {(["概要", "保有銘柄", "取引"] as PortfolioTab[]).map((item) => <button type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{portfolioTabLabel(locale, item)}</button>)}
        </nav>

        {tab === "概要" && <div className="portfolio-tab-panel overview-panel" role="tabpanel">
          <section className="portfolio-main-card portfolio-change-card">
            <header><div><h2>{st("chart.portfolioTrend")}</h2>{illustrativeStrategyChartsAvailable ? <span><i className="legend-dot portfolio-dot" /> Portfolio <i className="legend-dot benchmark-dot" /> S&P 500</span> : <span>{st("sample.unavailable")}</span>}</div>{illustrativeStrategyChartsAvailable && <div className="portfolio-chart-controls"><div className="segmented-control">{(["資産額", "パフォーマンス"] as const).map((item) => <button type="button" className={chartMode === item ? "active" : ""} onClick={() => setChartMode(item)} key={item}>{portfolioChartModeLabel(locale, item)}</button>)}</div><div className="period-control">{(["1M", "3M", "6M", "YTD", "1Y", "ALL"] as const).map((item) => <button type="button" className={period === item ? "active" : ""} onClick={() => setPeriod(item)} key={item}>{item}</button>)}</div></div>}</header>
            {illustrativeStrategyChartsAvailable ? <PortfolioValueChart
              mode={chartMode}
              period={period}
              seed={selectedCatalogIndex + 2}
              ariaLabel={`${st("chart.portfolioTrend")} · ${portfolioChartModeLabel(locale, chartMode)}`}
            /> : <StrategyChartUnavailable className="portfolio-chart-canvas" title={st("chart.portfolioTrend")} message={st("chart.unavailable")} />}
          </section>
          <div className="portfolio-overview-grid">
            <section className="portfolio-main-card"><header><div><h2>{st("allocation.title")}</h2><span>{st("allocation.subtitle")}</span></div><ChartPieSlice size={18} /></header><div className="allocation-list">{portfolioHoldings.map((holding) => <button type="button" key={holding.ticker} onClick={() => onOpenChart(holding.ticker)}><span><i style={{ background: holding.daily !== null && holding.daily >= 0 ? "#2962ff" : "#8b7cff" }} />{holding.ticker}</span><span>{holding.allocation === null ? "—" : `${holding.allocation.toFixed(1)}%`}</span><strong>{portfolioMoney(holding.value)}</strong></button>)}</div></section>
            <section className="portfolio-main-card"><header><div><h2>{st("movers.title")}</h2><span>{st("movers.subtitle")}</span></div><ChartLineUp size={18} /></header><div className="movers-list">{[...portfolioHoldings].sort((a, b) => (b.daily ?? Number.NEGATIVE_INFINITY) - (a.daily ?? Number.NEGATIVE_INFINITY)).map((holding) => { const holdingStock = strategyStockFor(holding.ticker); return <button type="button" key={holding.ticker} onClick={() => onOpenChart(holding.ticker)}><CompanyLogo stock={holdingStock} /><span><strong>{holding.ticker}</strong><small>{holdingStock.name}</small></span><b className={holding.daily === null ? "" : holding.daily >= 0 ? "positive" : "negative-text"}>{portfolioPercent(holding.daily, true)}</b></button>; })}</div></section>
          </div>
          <section className="portfolio-main-card profitability-card" id="portfolio-profitability"><header><div><h2>{st("profitability.title")}</h2><span>{illustrativeStrategyChartsAvailable ? st("profitability.subtitle") : st("sample.unavailable")}</span></div>{illustrativeStrategyChartsAvailable && <div className="segmented-control">{(["TTM", "2026"] as const).map((item) => <button type="button" className={analysisPeriod === item ? "active" : ""} onClick={() => setAnalysisPeriod(item)} key={item}>{item}</button>)}</div>}</header>{illustrativeStrategyChartsAvailable ? <PortfolioProfitChart seed={selectedCatalogIndex + (analysisPeriod === "TTM" ? 4 : 8)} ariaLabel={st("profitability.title")} /> : <StrategyChartUnavailable className="portfolio-analysis-chart" title={st("profitability.title")} message={st("chart.unavailable")} />}</section>
          <section className="portfolio-main-card contribution-card"><header><div><h2>{st("contribution.title")}</h2><span>{st("contribution.subtitle")}</span></div></header>{portfolioHoldings.map((holding) => <button type="button" key={holding.ticker} onClick={() => onOpenChart(holding.ticker)}><span><strong>{holding.ticker}</strong><small>{holding.allocation === null ? "—" : st("contribution.allocation", { value: holding.allocation.toFixed(1) })}</small></span><span className="contribution-track"><i style={{ width: `${holding.unrealized === null ? 0 : Math.min(100, Math.abs(holding.unrealized) / 140)}%` }} /></span><b className={holding.unrealized === null ? "" : holding.unrealized >= 0 ? "positive" : "negative-text"}>{signedPortfolioMoney(holding.unrealized)}</b></button>)}</section>
        </div>}

        {tab === "保有銘柄" && <div className="portfolio-tab-panel holdings-panel" role="tabpanel">
          <div className="portfolio-table-title"><div><h2>{st("holdings.title")}</h2><span>{st("holdings.summary", { count: holdingRows.length, value: portfolioMoney(markedPortfolio.holdingsValue) })}</span></div><div><label className="toggle-label"><input type="checkbox" checked={showSold} onChange={(event) => setShowSold(event.target.checked)} />{st("holdings.showSold")}</label></div></div>
          <div className="portfolio-table-scroll holdings-table-scroll"><table className="holdings-data-table" aria-label={st("holdings.aria")}><thead><tr><th>{st("holdings.symbol")}</th><th>{st("holdings.shares")}</th><th>{st("holdings.averageCost")}</th><th>{st("holdings.currentPrice")}</th><th>{st("holdings.currentValue")}</th><th>{st("holdings.allocation")}</th><th>{st("holdings.unrealized")}</th><th>{st("holdings.daily")}</th><th>{st("holdings.marketCap")}</th><th>PER</th><th>{st("holdings.oneMonth")}</th><th>Beta</th><th>RSI 14</th><th>{st("holdings.technical")}</th><th aria-label={st("holdings.actions")} /></tr></thead><tbody>{holdingRows.map((holding) => { const stock = strategyStockFor(holding.ticker); const technicalTone = holding.technicalRating.includes("買い") ? "positive" : holding.technicalRating.includes("売り") ? "negative-text" : ""; return <tr key={holding.ticker}><td><button type="button" className="holding-symbol" onClick={() => onOpenChart(holding.ticker)}><CompanyLogo stock={stock} /><span><strong>{holding.ticker}</strong><small>{stock.name}</small></span></button></td><td>{holding.shares.toLocaleString("en-US")}</td><td>{formatPrice(stock, holding.average)}</td><td>{holding.currentPrice === null ? "—" : formatPrice(stock, holding.currentPrice)}</td><td>{portfolioMoney(holding.value)}</td><td>{holding.allocation === null ? "—" : `${holding.allocation.toFixed(1)}%`}</td><td className={holding.unrealized === null ? "" : holding.unrealized >= 0 ? "positive" : "negative-text"}>{signedPortfolioMoney(holding.unrealized)}</td><td className={holding.daily === null ? "" : holding.daily >= 0 ? "positive" : "negative-text"}>{portfolioPercent(holding.daily, true)}</td><td>{stock.marketCap}</td><td>{stock.pe}</td><td className={holding.performance1M >= 0 ? "positive" : "negative-text"}>{holding.performance1M >= 0 ? "+" : ""}{holding.performance1M.toFixed(1)}%</td><td>{holding.beta.toFixed(2)}</td><td>{holding.rsi.toFixed(1)}</td><td><span className={`technical-rating ${technicalTone}`}>{strategyTechnicalRatingLabel(locale, holding.technicalRating)}</span></td><td><IconButton label={st("holdings.transactionMenu", { symbol: holding.ticker })} onClick={() => openTransaction(holding.ticker)}><DotsThree size={17} /></IconButton></td></tr>; })}</tbody></table></div>
        </div>}

        {tab === "取引" && <div className="portfolio-tab-panel transactions-panel" role="tabpanel">
          <div className="portfolio-table-title"><div><h2>{st("transactions.title")}</h2><span>{transactionLoadStatus === "loading" ? <LoadingIndicator label={st("transactions.loading")} /> : st("common.count", { count: transactions.length })} · {transactionMutationStatus === "saving" ? st("transactions.saving") : transactionLoadStatus === "error" || transactionMutationStatus === "error" ? st("transactions.saveError") : st("transactions.savedToD1")}</span></div><div className="transaction-actions"><div className="segmented-control">{(["取引", "現金"] as const).map((item) => <button type="button" className={transactionTab === item ? "active" : ""} onClick={() => setTransactionTab(item)} key={item}>{portfolioTransactionTabLabel(locale, item)}</button>)}</div><button type="button" onClick={() => setDialog("import")}><DownloadSimple size={15} /> {st("transactions.import")}</button><button type="button" onClick={() => onAction(st("toast.transactionsExported"))}><UploadSimple size={15} /> {st("transactions.export")}</button><button type="button" className="primary-action" onClick={() => openTransaction()}><Plus size={15} /> {st("detail.addTransaction")}</button></div></div>
          {transactionTab === "取引" ? <div className="portfolio-table-scroll"><div className="transactions-table" role="table" aria-label={st("transactions.aria")}><div className="transactions-row transactions-head"><span>{st("transactions.date")}</span><span>{st("transactions.symbol")}</span><span>{st("transactions.type")}</span><span>{st("transactions.quantity")}</span><span>{st("transactions.price")}</span><span>{st("transactions.fee")}</span><span>{st("transactions.total")}</span><span /></div>{transactions.map((transaction) => <button type="button" className="transactions-row" key={transaction.id} onClick={() => openTransaction(transaction.ticker)}><span>{transaction.date}</span><span><b>{transaction.ticker}</b></span><span><i className={`transaction-side ${transaction.side}`}>{portfolioTransactionSideLabel(locale, transaction.side)}</i></span><span>{transaction.shares.toLocaleString("en-US")}</span><span>${transaction.price.toLocaleString("en-US")}</span><span>${transaction.fee.toFixed(2)}</span><span>${(transaction.shares * transaction.price).toLocaleString("en-US", { maximumFractionDigits: 0 })}</span><CaretRight size={14} /></button>)}</div></div> : <div className="cash-ledger"><Wallet size={26} /><h3>{st("transactions.cashBalance", { value: `$${cashValue.toLocaleString("en-US")}` })}</h3><p>{st("transactions.cashDescription")}</p><button type="button" onClick={() => { setTransactionSide("配当"); openTransaction(); }}>{st("transactions.addCash")}</button></div>}
        </div>}

      </div>
      <footer className="strategy-status-bar"><span><span /> {transactionLoadStatus === "loading" ? <LoadingIndicator /> : st("status.transactions", { status: transactionLoadStatus === "error" || transactionMutationStatus === "error" ? st("common.error") : st("common.connected") })}</span><span>{st("status.strategyDisclaimer")}</span></footer>

      {dialog === "transaction" && <DialogShell title={st("transaction.dialogTitle")} eyebrow={selected.name} onClose={() => setDialog(null)}><form className="dialog-body dialog-form-grid" onSubmit={submitTransaction}><label><span>{st("transaction.symbol")}</span><select value={transactionTicker} onChange={(event) => { const ticker = event.target.value; setTransactionTicker(ticker); const next = strategyMarketMarks[ticker]?.price ?? strategyStockModels[ticker]?.price; setTransactionPrice(Number.isFinite(next) && (next ?? 0) > 0 ? String(next) : ""); }}>{STOCKS.map((item) => <option value={item.ticker} key={item.ticker}>{item.ticker} · {item.name}</option>)}</select></label><label><span>{st("transaction.type")}</span><select value={transactionSide} onChange={(event) => setTransactionSide(event.target.value as PortfolioTransaction["side"])}><option value="買付">{st("transaction.buy")}</option><option value="売却">{st("transaction.sell")}</option><option value="配当">{st("transaction.dividend")}</option></select></label><label><span>{st("transaction.quantity")}</span><input type="number" min="0.01" step="0.01" value={transactionShares} onChange={(event) => setTransactionShares(event.target.value)} /></label><label><span>{st("transaction.price")}</span><input type="number" min="0" step="0.01" value={transactionPrice} onChange={(event) => setTransactionPrice(event.target.value)} /></label><footer className="dialog-actions form-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="submit" className="primary-action" disabled={transactionMutationStatus === "saving"}>{transactionMutationStatus === "saving" ? st("transaction.saving") : st("transaction.save")}</button></footer></form></DialogShell>}
      {dialog === "import" && <DialogShell title={st("import.title")} eyebrow="CSV IMPORT" onClose={() => setDialog(null)}><div className="dialog-body"><label className="file-drop"><UploadSimple size={24} /><strong>{st("import.dropCsv")}</strong><span>{st("import.description")}</span><input type="file" accept=".csv" /></label></div><footer className="dialog-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="button" className="primary-action" onClick={() => { setDialog(null); onAction(st("toast.transactionsImported", { count: 5 })); }}>{st("import.action")}</button></footer></DialogShell>}
      {dialog === "settings" && <DialogShell title={st("settings.title")} eyebrow="STRATEGY SETTINGS" onClose={() => setDialog(null)}><form className="dialog-body dialog-form-grid" onSubmit={saveStrategySettings}><label><span>{st("settings.name")}</span><input value={settingsName} required maxLength={120} onChange={(event) => setSettingsName(event.target.value)} autoFocus /></label><label><span>{st("settings.description")}</span><textarea value={settingsHeadline} required maxLength={500} onChange={(event) => setSettingsHeadline(event.target.value)} /></label>{strategyMutationError && <small className="strategy-dialog-error" role="alert">{st(strategyMutationError === "conflict" ? "notice.conflictDescription" : "notice.errorDescription")}</small>}<footer className="dialog-actions form-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="submit" className="primary-action" disabled={strategyMutationStatus !== "idle" || !settingsName.trim() || !settingsHeadline.trim()}>{strategyMutationStatus === "saving" ? st("settings.saving") : st("common.save")}</button></footer></form></DialogShell>}
      {dialog === "delete" && <DialogShell title={st("delete.title")} eyebrow={st("delete.confirm")} onClose={() => setDialog(null)}><div className="dialog-body confirm-copy"><Trash size={28} /><p>{st("delete.description", { name: selected.name })}</p>{strategyMutationError && <small className="strategy-dialog-error" role="alert">{st(strategyMutationError === "conflict" ? "notice.conflictDescription" : "notice.errorDescription")}</small>}</div><footer className="dialog-actions"><button type="button" onClick={() => setDialog(null)}>{st("common.cancel")}</button><button type="button" className="danger-action" disabled={strategyMutationStatus !== "idle" || strategies.length <= 1} onClick={() => { void deleteSelectedStrategy(); }}>{strategyMutationStatus === "deleting" ? st("delete.deleting") : st("common.delete")}</button></footer></DialogShell>}
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
  onReorder,
  persistenceStatus,
  afterHours,
  afterHoursEnabled,
}: {
  selectedTicker: string;
  onSelect: (ticker: string) => void;
  stocks: Stock[];
  onAdd: () => void;
  onCreate: () => void;
  onRename: (watchlistId: string) => void;
  onDeleteWatchlist: (watchlistId: string) => void;
  watchlists: readonly Watchlist[];
  activeWatchlistId: string;
  onSelectWatchlist: (watchlistId: string) => void;
  onDelete: (ticker: string) => void | Promise<void>;
  onReorder: (itemIds: readonly string[]) => void | Promise<void>;
  persistenceStatus: "loading" | "ready" | "saving" | "error";
  afterHours: Readonly<Record<string, SyntheticLatestClose>>;
  afterHoursEnabled: boolean;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<"lists" | "more" | null>(null);
  const [listActionsId, setListActionsId] = useState<string | null>(null);
  const [sort, setSort] = useState<"manual" | "ticker" | "change">("manual");
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<Readonly<{
    itemId: string;
    edge: WatchlistDropEdge;
  }> | null>(null);
  const [rowContextMenu, setRowContextMenu] = useState<{
    ticker: string;
    left: number;
    top: number;
  } | null>(null);
  const rowContextMenuRef = useRef<HTMLDivElement>(null);
  const rowContextActionRef = useRef<HTMLButtonElement>(null);
  const rowContextTriggerRef = useRef<HTMLElement | null>(null);
  const listsMenuHostRef = useRef<HTMLDivElement>(null);
  const moreMenuHostRef = useRef<HTMLDivElement>(null);
  const listsMenuBoundaries = useMemo(() => [listsMenuHostRef] as const, []);
  const moreMenuBoundaries = useMemo(() => [moreMenuHostRef] as const, []);
  const rowContextMenuBoundaries = useMemo(() => [rowContextMenuRef] as const, []);
  const activeWatchlist = watchlists.find((watchlist) => watchlist.id === activeWatchlistId) ?? watchlists[0];
  const sortedStocks = sort === "manual"
    ? stocks
    : [...stocks].sort((a, b) => sort === "ticker" ? a.ticker.localeCompare(b.ticker) : b.change - a.change);
  const activeItemBySymbol = useMemo(
    () => new Map(activeWatchlist?.items.map((item) => [item.symbol, item]) ?? []),
    [activeWatchlist],
  );

  const clearDragState = useCallback(() => {
    setDraggedItemId(null);
    setDropTarget(null);
  }, []);

  const completeDrop = useCallback((targetId: string, edge: WatchlistDropEdge) => {
    if (!activeWatchlist || !draggedItemId || persistenceStatus === "saving") {
      clearDragState();
      return;
    }
    const currentIds = activeWatchlist.items
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((item) => item.id);
    const itemIds = moveWatchlistItemIds(currentIds, draggedItemId, targetId, edge);
    clearDragState();
    setSort("manual");
    if (itemIds.some((itemId, index) => itemId !== currentIds[index])) void onReorder(itemIds);
  }, [activeWatchlist, clearDragState, draggedItemId, onReorder, persistenceStatus]);

  const moveWithKeyboard = useCallback((sourceId: string, direction: "up" | "down") => {
    if (!activeWatchlist || sort !== "manual" || persistenceStatus === "saving") return;
    const currentIds = activeWatchlist.items
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((item) => item.id);
    const sourceIndex = currentIds.indexOf(sourceId);
    const targetIndex = direction === "up" ? sourceIndex - 1 : sourceIndex + 1;
    const targetId = currentIds[targetIndex];
    if (sourceIndex < 0 || !targetId) return;
    void onReorder(moveWatchlistItemIds(
      currentIds,
      sourceId,
      targetId,
      direction === "up" ? "before" : "after",
    ));
  }, [activeWatchlist, onReorder, persistenceStatus, sort]);

  const openRowContextMenu = useCallback((ticker: string, trigger: HTMLElement, left: number, top: number) => {
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
    onDismiss: () => {
      setListActionsId(null);
      setMenu(null);
    },
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
    <div
      className="watchlist-panel"
      onKeyDownCapture={(event) => {
        if (
          !activeItemBySymbol.has(selectedTicker)
          || persistenceStatus === "saving"
          || event.defaultPrevented
          || !isWatchlistDeleteShortcut(event)
          || isEditableKeyboardTarget(event.target)
        ) return;
        event.preventDefault();
        setRowContextMenu(null);
        void onDelete(selectedTicker);
      }}
    >
      <div className="right-panel-heading">
        <div className="watch-menu-host" ref={listsMenuHostRef}><button type="button" className="panel-title-button" aria-haspopup="menu" aria-expanded={menu === "lists"} aria-controls="watchlist-selector-menu" onClick={() => { setListActionsId(null); setMenu((current) => current === "lists" ? null : "lists"); }}>
          {activeWatchlist?.name ?? t("watchlist.defaultName")} <CaretDown size={13} weight="bold" />
        </button>{menu === "lists" && <div id="watchlist-selector-menu" className="watch-popover watchlist-selector-menu" role="menu">{watchlists.map((watchlist) => <div className="watchlist-selector-row" role="none" key={watchlist.id}><button type="button" role="menuitemradio" aria-checked={activeWatchlist?.id === watchlist.id} className={`watchlist-selector-choice ${activeWatchlist?.id === watchlist.id ? "active" : ""}`} onClick={() => { onSelectWatchlist(watchlist.id); setListActionsId(null); setMenu(null); }}>{activeWatchlist?.id === watchlist.id && <Check size={13} />}{watchlist.name}</button><button type="button" role="menuitem" className="watchlist-selector-more" aria-label={t("watchlist.listActions", { name: watchlist.name })} aria-haspopup="menu" aria-expanded={listActionsId === watchlist.id} onClick={(event) => { event.stopPropagation(); setListActionsId((current) => current === watchlist.id ? null : watchlist.id); }}><DotsThree size={17} /></button>{listActionsId === watchlist.id && <div className="watchlist-selector-actions" role="menu" aria-label={t("watchlist.listActions", { name: watchlist.name })}><button type="button" role="menuitem" disabled={persistenceStatus === "saving"} onClick={() => { setListActionsId(null); setMenu(null); onRename(watchlist.id); }}><PencilLine size={13} />{t("watchlist.rename")}</button><button type="button" role="menuitem" className="watchlist-delete-action" disabled={watchlists.length <= 1 || persistenceStatus === "saving"} title={watchlists.length <= 1 ? t("watchlist.deleteLastRequired") : undefined} onClick={() => { setListActionsId(null); setMenu(null); onDeleteWatchlist(watchlist.id); }}><Trash size={13} />{t("watchlist.delete")}</button></div>}</div>)}<button type="button" role="menuitem" onClick={() => { setListActionsId(null); setMenu(null); onCreate(); }}><Plus size={13} />{t("watchlist.newList")}</button></div>}</div>
        <div className="heading-actions">
          <IconButton label={t("watchlist.addSymbol")} onClick={onAdd}><Plus size={17} /></IconButton>
          <div className="watch-menu-host" ref={moreMenuHostRef}><IconButton label={t("watchlist.more")} hasPopup="menu" expanded={menu === "more"} controls="watchlist-options-menu" onClick={() => setMenu((current) => current === "more" ? null : "more")}><DotsThree size={18} /></IconButton>{menu === "more" && <div id="watchlist-options-menu" className="watch-popover align-right" role="menu"><span>{t("watchlist.sort")}</span>{[["manual", "watchlist.sort.manual"], ["ticker", "watchlist.sort.ticker"], ["change", "watchlist.sort.change"]].map(([value, labelKey]) => <button type="button" className={sort === value ? "active" : ""} key={value} onClick={() => { clearDragState(); setSort(value as typeof sort); setMenu(null); }}>{sort === value && <Check size={13} />}{t(labelKey)}</button>)}<button type="button" role="menuitem" onClick={() => { setMenu(null); onCreate(); }}><Plus size={13} />{t("watchlist.newList")}</button></div>}</div>
        </div>
      </div>
      <div className="watchlist-columns">
        <span>{t("watchlist.symbol")}</span><span>{t("watchlist.current")}</span><span>{t("watchlist.change")}</span><span>{t("watchlist.afterHours")}</span>
      </div>
      <div className="watchlist-rows">
        {sortedStocks.map((item) => {
          const watchlistItem = activeItemBySymbol.get(item.ticker);
          const canDrag = Boolean(watchlistItem) && sort === "manual" && persistenceStatus !== "saving";
          const afterHoursItem = afterHoursEnabled ? afterHours[item.ticker] : undefined;
          const afterHoursClose = isFreshSyntheticLatestClose(afterHoursItem)
            ? afterHoursItem.close
            : undefined;
          const hasCurrentPrice = Number.isFinite(item.price) && item.price > 0;
          const hasCurrentChange = hasCurrentPrice && Number.isFinite(item.change);
          const hasAfterHoursPrice = typeof afterHoursClose === "number" && Number.isFinite(afterHoursClose) && afterHoursClose > 0;
          const afterHoursTone = !hasAfterHoursPrice
            ? "is-missing"
            : !hasCurrentPrice
              ? "is-neutral"
              : afterHoursClose > item.price
                ? "is-higher"
                : afterHoursClose < item.price ? "is-lower" : "is-equal";
          return (
            <div
              key={item.ticker}
              className={`watch-row ${selectedTicker === item.ticker ? "selected" : ""} ${canDrag ? "is-draggable" : ""} ${draggedItemId === watchlistItem?.id ? "is-dragging" : ""} ${dropTarget && dropTarget.itemId === watchlistItem?.id ? `is-drop-${dropTarget.edge}` : ""}`}
              role="group"
              tabIndex={0}
              draggable={canDrag}
              aria-current={selectedTicker === item.ticker ? "true" : undefined}
              aria-label={`${item.ticker} · ${item.name}${sort === "manual" ? `. ${t("watchlist.dragSymbol", { symbol: item.ticker })}` : ""}`}
              aria-keyshortcuts={sort === "manual" ? "ArrowUp ArrowDown" : undefined}
              aria-controls={rowContextMenu?.ticker === item.ticker ? "watchlist-row-context-menu" : undefined}
              title={sort === "manual" ? t("watchlist.dragSymbol", { symbol: item.ticker }) : undefined}
              onClick={() => onSelect(item.ticker)}
              onDragStart={(event) => {
                if (!watchlistItem || !canDrag) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", watchlistItem.id);
                event.dataTransfer.setDragImage(event.currentTarget, 24, event.currentTarget.clientHeight / 2);
                setDraggedItemId(watchlistItem.id);
                setDropTarget(null);
              }}
              onDragEnd={clearDragState}
              onDragOver={(event) => {
                if (!watchlistItem || !draggedItemId || draggedItemId === watchlistItem.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const bounds = event.currentTarget.getBoundingClientRect();
                setDropTarget({
                  itemId: watchlistItem.id,
                  edge: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
                });
              }}
              onDrop={(event) => {
                if (!watchlistItem || !draggedItemId || draggedItemId === watchlistItem.id) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                completeDrop(
                  watchlistItem.id,
                  event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
                );
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openRowContextMenu(item.ticker, event.currentTarget, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (
                  watchlistItem
                  && sort === "manual"
                  && (event.key === "ArrowUp" || event.key === "ArrowDown")
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  moveWithKeyboard(watchlistItem.id, event.key === "ArrowUp" ? "up" : "down");
                  return;
                }
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(item.ticker);
                  return;
                }
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  event.stopPropagation();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openRowContextMenu(item.ticker, event.currentTarget, bounds.left + 24, bounds.top + bounds.height - 4);
                }
              }}
            >
              <span className="watch-symbol">
                <CompanyLogo stock={item} />
                <span><b>{item.ticker}</b><small>{item.market}</small></span>
              </span>
              <span className="watch-price">{formatWatchlistPrice(item)}</span>
              <span className={hasCurrentChange ? (item.change >= 0 ? "positive" : "negative-text") : "muted-value"}>
                {hasCurrentChange ? `${item.change >= 0 ? "+" : ""}${item.change.toFixed(2)}%` : "-"}
              </span>
              <span className={`watch-after-hours ${afterHoursTone}`} title={afterHoursEnabled ? t("watchlist.afterHoursTooltip", { symbol: item.ticker }) : undefined}>
                {hasAfterHoursPrice ? formatSummaryAfterHoursPrice(afterHoursClose) : "-"}
              </span>
            </div>
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
  const chartTimeScaleSync = useMemo(() => createChartTimeScaleSync(), []);
  const [selectedTicker, setSelectedTicker] = useState("AAPL");
  const [stockModels, setStockModels] = useState<Record<string, Stock>>(() => Object.fromEntries(
    STOCKS.map((item) => [item.ticker, stockIdentityPlaceholder(item)]),
  ));
  const [workspace, setWorkspace] = useState<SymbolWorkspace | null>(null);
  const [marketBars, setMarketBars] = useState<readonly MarketBar[]>([]);
  const [marketBarsSymbol, setMarketBarsSymbol] = useState("");
  const [marketBarsProvenance, setMarketBarsProvenance] = useState<DataProvenance | undefined>();
  const [workspaceStatus, setWorkspaceStatus] = useState<MarketDataStatus>("loading");
  const [barsStatus, setBarsStatus] = useState<MarketDataStatus>("loading");
  const [analystHistoryResponse, setAnalystHistoryResponse] = useState<AnalystRatingHistoryResponse | null>(null);
  const [analystHistoryStatus, setAnalystHistoryStatus] = useState<AnalystHistoryStatus>("idle");
  const analystHistoryResponseRef = useRef<AnalystRatingHistoryResponse | null>(null);
  const [analystHistoryRefreshNonce, setAnalystHistoryRefreshNonce] = useState(0);
  const [dailyMarketBars, setDailyMarketBars] = useState<readonly MarketBar[]>([]);
  const [dailyMarketBarsSymbol, setDailyMarketBarsSymbol] = useState("");
  const [dailyMarketBarsProvenance, setDailyMarketBarsProvenance] = useState<DataProvenance | undefined>();
  const [dailyBarsStatus, setDailyBarsStatus] = useState<MarketDataStatus>("loading");
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
  const [stockDetailTabSelection, setStockDetailTabSelection] = useState<StockDetailTabSelection<StockDetailTabId>>({
    ticker: "AAPL",
    tab: DEFAULT_STOCK_DETAIL_TAB,
  });
  const activeStockDetailSection = resolveStockDetailTab(
    stockDetailTabSelection,
    selectedTicker,
    traderConfig.ui.symbolDetail.tabs,
    DEFAULT_STOCK_DETAIL_TAB,
  );
  const [workspaceSectionRefreshNonce, setWorkspaceSectionRefreshNonce] = useState(0);
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanelId | null>("watchlist");
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [rightPanelMaxWidth, setRightPanelMaxWidth] = useState(MAX_RIGHT_PANEL_WIDTH);
  const [watchlistSplitPercent, setWatchlistSplitPercent] = useState(DEFAULT_WATCHLIST_SPLIT_PERCENT);
  const [workspaceLayoutReady, setWorkspaceLayoutReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchIntent, setSearchIntent] = useState<InstrumentSearchIntent>("select");
  const [indicatorLibraryOpen, setIndicatorLibraryOpen] = useState(false);
  const [settingsIndicatorId, setSettingsIndicatorId] = useState<IndicatorId | null>(null);
  const [query, setQuery] = useState("");
  const [watchlists, setWatchlists] = useState<readonly Watchlist[] | null>(null);
  const [activeWatchlistId, setActiveWatchlistId] = useState("");
  const [watchlistStatus, setWatchlistStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [afterHoursBySymbol, setAfterHoursBySymbol] = useState<Readonly<Record<string, SyntheticLatestClose>>>({});
  const [marketSessionClock, setMarketSessionClock] = useState<number | null>(null);
  const [marketSessionObservations, setMarketSessionObservations] = useState<Readonly<Record<string, MarketSessionObservation>>>({});
  const [newWatchlistName, setNewWatchlistName] = useState("");
  const [renameWatchlistName, setRenameWatchlistName] = useState("");
  const [managedWatchlistId, setManagedWatchlistId] = useState("");
  const [interval, setInterval] = useState<MarketBarInterval>("1d");
  const [chartCandleCount, setChartCandleCount] = useState<number>(DEFAULT_CHART_CANDLE_COUNT);
  const [chartCandleCountDraft, setChartCandleCountDraft] = useState(String(DEFAULT_CHART_CANDLE_COUNT));
  const [localeDraft, setLocaleDraft] = useState<Locale>(locale);
  const [chartType, setChartType] = useState<ChartTypeId>("candles");
  const [userChartTemplates, setUserChartTemplates] = useState<ChartTemplate<IndicatorSettings>[]>([]);
  const [chartTemplatesReady, setChartTemplatesReady] = useState(false);
  const [templateEditor, setTemplateEditor] = useState<{ mode: "create" | "rename"; templateId?: string } | null>(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templateNameError, setTemplateNameError] = useState<ChartTemplateNameError | null>(null);
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
    onDismiss: () => {
      setToolbarMenu(null);
      setTemplateEditor(null);
      setTemplateNameError(null);
    },
    restoreFocusRef: templateMenuTriggerRef,
  });
  const [appDialog, setAppDialog] = useState<AppDialogId>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [showAllNews, setShowAllNews] = useState(false);
  const [chartPreferencesReady, setChartPreferencesReady] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const marketSessionObservationRef = useRef<Readonly<Record<string, MarketSessionObservation>>>({});
  const forceWatchlistQuoteSnapshotRef = useRef<(() => void) | null>(null);
  const forceChartBarsRefreshRef = useRef<(() => void) | null>(null);
  const forceDailyBarsRefreshRef = useRef<(() => void) | null>(null);
  const selectedTickerRef = useRef(selectedTicker);
  const workspaceRef = useRef<SymbolWorkspace | null>(workspace);
  const workspaceRequestCoordinator = useMemo(() => createLatestRequestCoordinator(), []);
  const liveQuoteByInstrumentRef = useRef(new Map<string, Quote>());
  useEffect(() => {
    selectedTickerRef.current = selectedTicker;
  }, [selectedTicker]);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);
  const mergeLiveQuote = useCallback((quote: Quote) => {
    const current = liveQuoteByInstrumentRef.current.get(quote.instrumentId);
    if (current && !isQuoteNewerThan(quote, current)) return;
    liveQuoteByInstrumentRef.current.set(quote.instrumentId, quote);
    setWorkspace((snapshot) => {
      const next = snapshot ? mergeLiveQuoteIntoWorkspace(snapshot, quote) : snapshot;
      workspaceRef.current = next;
      return next;
    });
  }, []);
  const observeMarketSession = useCallback((
    symbol: string,
    state: Quote["marketState"],
    ingestedAt: string,
  ) => {
    const observedAt = Date.parse(ingestedAt);
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol || !Number.isFinite(observedAt)) return;
    const current = marketSessionObservationRef.current[normalizedSymbol];
    const observation = Object.freeze({ state, observedAt });
    if (!shouldReplaceMarketSessionObservation(current, observation)) return;
    const next = Object.freeze({
      ...marketSessionObservationRef.current,
      [normalizedSymbol]: observation,
    });
    marketSessionObservationRef.current = next;
    setMarketSessionObservations(next);
    if (
      normalizedSymbol === selectedTickerRef.current
      && current
      && current.state !== state
    ) {
      forceChartBarsRefreshRef.current?.();
      forceDailyBarsRefreshRef.current?.();
    }
  }, []);
  const requestWorkspace = useCallback(async (
    symbol: string,
    refreshSection: WorkspaceRefreshSection | null = null,
  ) => {
    const canMergeSection = refreshSection !== null
      && workspaceRef.current?.instrument.symbol === symbol;
    const query = canMergeSection
      ? `?section=${encodeURIComponent(refreshSection)}&fresh=1`
      : refreshSection ? "?fresh=1" : "";
    const result = await workspaceRequestCoordinator.run(
      `${symbol}:${query || "initial"}`,
      async (signal) => {
        const response = await fetch(
          `/api/v1/symbols/${encodeURIComponent(symbol)}/workspace${query}`,
          { signal, cache: "no-store" },
        );
        if (!response.ok) throw new Error("workspace request failed");
        return response.json() as Promise<SymbolWorkspace>;
      },
    );
    if (result.status === "aborted" || !result.current) return;
    if (result.status === "error") {
      if (!canMergeSection) setWorkspaceStatus("error");
      return;
    }
    const snapshot = result.value;
    if (snapshot.instrument.symbol !== selectedTickerRef.current) return;
    const current = workspaceRef.current;
    const mergedSnapshot = canMergeSection && current && refreshSection
      ? mergeFreshWorkspaceSection(current, snapshot, refreshSection)
      : snapshot;
    const latestLiveQuote = liveQuoteByInstrumentRef.current.get(
      mergedSnapshot.instrument.instrumentId,
    );
    const liveSnapshot = latestLiveQuote
      ? mergeLiveQuoteIntoWorkspace(mergedSnapshot, latestLiveQuote)
      : mergedSnapshot;
    workspaceRef.current = liveSnapshot;
    setWorkspace(liveSnapshot);
    setWorkspaceStatus(liveSnapshot.dataMode);
    if (liveSnapshot.dataMode === "provider") {
      observeMarketSession(
        liveSnapshot.instrument.symbol,
        liveSnapshot.quote.marketState,
        liveSnapshot.quote.provenance.ingestedAt,
      );
      setStockModels((currentModels) => ({
        ...currentModels,
        [liveSnapshot.instrument.symbol]: workspaceStock(liveSnapshot),
      }));
    }
  }, [observeMarketSession, workspaceRequestCoordinator]);
  const stock = stockModels[selectedTicker] ?? tickerIdentityPlaceholder(selectedTicker);
  const activeWatchlist = watchlists?.find((watchlist) => watchlist.id === activeWatchlistId) ?? watchlists?.[0] ?? null;
  const managedWatchlist = watchlists?.find((watchlist) => watchlist.id === managedWatchlistId) ?? activeWatchlist;
  const watchedTickers = activeWatchlist
    ? activeWatchlist.items.map((item) => item.symbol)
    : watchlists === null ? ["AAPL", "NVDA", "MSFT", "TSLA"] : [];
  const watchedStocks = watchedTickers.map((ticker) => stockModels[ticker]).filter((item): item is Stock => Boolean(item));
  const quoteTickerKey = prioritizedWatchlistQuoteSymbols(
    watchedTickers,
    selectedTicker,
    WATCHLIST_QUOTES_MAX_SYMBOLS,
  )
    .join("\u0000");
  const marketDataSurfaceVisible = primaryView !== "strategy";
  const afterHoursTickers = Array.from(new Set([...watchedTickers, selectedTicker]))
    .slice(0, WATCHLIST_AFTER_HOURS_MAX_SYMBOLS);
  const afterHoursEnabled = shouldUseAfterHoursPrices(
    afterHoursTickers.flatMap((ticker) => {
      const observation = marketSessionObservations[ticker];
      return observation ? [observation] : [];
    }),
    marketSessionClock === null ? undefined : new Date(marketSessionClock),
  );
  const afterHoursTickerKey = afterHoursEnabled ? afterHoursTickers.join("\u0000") : "";
  const searchView = resolveInstrumentSearchView(searchStatus, searchResults.length);
  const watched = watchedTickers.includes(selectedTicker);
  const researchDataStatus: MarketDataStatus = workspaceStatus === "error" || dailyBarsStatus === "error"
    ? "error"
    : workspaceStatus === "loading" || dailyBarsStatus === "loading"
      ? "loading"
      : workspaceStatus === "provider" && dailyBarsStatus === "provider" ? "provider" : "fixture";
  const detailWorkspace = workspaceStatus === "provider"
    && workspace?.dataMode === "provider"
    && workspace.instrument.symbol === selectedTicker
    ? workspace
    : null;
  const detailMarketBars = useMemo<readonly MarketBar[]>(
    () => barsStatus === "provider" && marketBarsSymbol === selectedTicker ? marketBars : [],
    [barsStatus, marketBars, marketBarsSymbol, selectedTicker],
  );
  const detailBarsProvenance = barsStatus === "provider" && marketBarsSymbol === selectedTicker
    ? marketBarsProvenance
    : undefined;
  const detailDailyMarketBars = useMemo<readonly MarketBar[]>(
    () => dailyBarsStatus === "provider" && dailyMarketBarsSymbol === selectedTicker ? dailyMarketBars : [],
    [dailyBarsStatus, dailyMarketBars, dailyMarketBarsSymbol, selectedTicker],
  );
  const detailDailyBarsProvenance = dailyBarsStatus === "provider"
    && dailyMarketBarsSymbol === selectedTicker
    ? dailyMarketBarsProvenance
    : undefined;
  const stockDetailViewModel = useMemo(
    () => buildStockDetailViewModel(detailWorkspace, detailDailyMarketBars, detailDailyBarsProvenance),
    [detailDailyBarsProvenance, detailDailyMarketBars, detailWorkspace],
  );
  const stockIntelligence = useMemo(
    () => {
      const intelligence = getStockIntelligence(
        stock,
        detailWorkspace,
        dailyBarsStatus === "provider" ? detailDailyMarketBars : [],
        locale,
      );
      if (!detailWorkspace) {
        if (workspaceStatus === "loading") {
          return { ...intelligence, dataFreshness: t("status.fetching") };
        }
        if (workspaceStatus === "error" || workspaceStatus === "fixture") {
          return { ...intelligence, dataFreshness: t("status.connectionError") };
        }
        return intelligence;
      }
      if (dailyBarsStatus === "provider") return intelligence;
      return {
        ...intelligence,
        dataFreshness: t(dailyBarsStatus === "loading" ? "status.fetching" : "status.connectionError"),
      };
    },
    [dailyBarsStatus, detailDailyMarketBars, detailWorkspace, locale, stock, t, workspaceStatus],
  );
  const visibleNews = useMemo(() => {
    if (
      workspaceStatus === "provider"
      && workspace?.dataMode === "provider"
      && workspace.instrument.symbol === stock.ticker
    ) {
      return workspace.news.map((item) => ({
        time: new Date(item.publishedAt).toLocaleString(numberLocale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        title: item.title,
        summary: item.summary || "",
        source: item.publisher,
        tag: t("sidebar.news"),
        url: item.url,
      }));
    }
    return [];
  }, [numberLocale, stock.ticker, t, workspace, workspaceStatus]);
  const selectedAnalystHistory = analystHistoryResponse?.dataMode === "provider"
    && analystHistoryResponse.instrument.symbol === selectedTicker
    ? analystHistoryResponse.history
    : null;
  const shouldLoadAnalystHistory = primaryView === "stock-detail"
    && activeStockDetailSection === "analyst";
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

  const applyChartTemplate = useCallback((template: ChartTemplate<IndicatorSettings>) => {
    setActiveIndicators([...template.activeIndicators]);
    setHiddenIndicators([...template.hiddenIndicators]);
    setIndicatorSettings((current) => {
      const next = { ...current };
      template.activeIndicators.forEach((indicatorId) => {
        const saved = template.indicatorSettings[indicatorId];
        if (!saved || typeof saved !== "object") return;
        next[indicatorId] = {
          ...current[indicatorId],
          ...saved,
          visibility: {
            ...current[indicatorId].visibility,
            ...(saved.visibility ?? {}),
          },
        };
      });
      return next;
    });
    setToolbarMenu(null);
    setTemplateEditor(null);
    setTemplateNameError(null);
    showToast(t("toolbar.templateApplied", { name: template.name }));
  }, [showToast, t]);

  const applyBuiltInChartTemplate = useCallback((
    id: string,
    name: string,
    indicatorIds: readonly IndicatorId[],
  ) => {
    applyChartTemplate(createChartTemplate({
      id,
      name,
      activeIndicators: [...indicatorIds],
      hiddenIndicators: [],
      indicatorSettings: Object.fromEntries(indicatorIds.map((indicatorId) => [
        indicatorId,
        DEFAULT_INDICATOR_SETTINGS[indicatorId],
      ])),
    }));
  }, [applyChartTemplate]);

  const openTemplateEditor = useCallback((mode: "create" | "rename", template?: ChartTemplate<IndicatorSettings>) => {
    setTemplateEditor({ mode, templateId: template?.id });
    setTemplateNameDraft(template?.name ?? "");
    setTemplateNameError(null);
  }, []);

  const saveTemplateEditor = useCallback(() => {
    if (!templateEditor) return;
    const builtInNames = [
      { id: "builtin-trend", name: t("toolbar.trendTemplate") },
      { id: "builtin-volatility", name: t("toolbar.volatilityTemplate") },
      { id: "builtin-clean", name: t("toolbar.noIndicators") },
    ];
    const error = validateChartTemplateName(
      templateNameDraft,
      [...builtInNames, ...userChartTemplates],
      templateEditor.templateId,
    );
    if (error) {
      setTemplateNameError(error);
      return;
    }
    const name = normalizeChartTemplateName(templateNameDraft);
    if (templateEditor.mode === "create") {
      const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const template = createChartTemplate({
        id,
        name,
        activeIndicators,
        hiddenIndicators,
        indicatorSettings,
      });
      setUserChartTemplates((current) => [...current, template]);
      showToast(t("toolbar.templateCreated", { name }));
    } else {
      setUserChartTemplates((current) => current.map((template) => (
        template.id === templateEditor.templateId ? { ...template, name } : template
      )));
      showToast(t("toolbar.templateRenamed", { name }));
    }
    setTemplateEditor(null);
    setTemplateNameDraft("");
    setTemplateNameError(null);
  }, [activeIndicators, hiddenIndicators, indicatorSettings, showToast, t, templateEditor, templateNameDraft, userChartTemplates]);

  const deleteChartTemplate = useCallback((template: ChartTemplate<IndicatorSettings>) => {
    setUserChartTemplates((current) => current.filter((item) => item.id !== template.id));
    if (templateEditor?.templateId === template.id) setTemplateEditor(null);
    showToast(t("toolbar.templateDeleted", { name: template.name }));
  }, [showToast, t, templateEditor?.templateId]);

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
    const nextSelectedTicker = nextWatchlistSymbolAfterRemoval(
      activeWatchlist.items,
      ticker,
    );
    setWatchlistStatus("saving");
    try {
      const response = await fetch(`/api/v1/watchlists/${encodeURIComponent(activeWatchlist.id)}/items/${encodeURIComponent(existing.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("watchlist delete request failed");
      setWatchlists((current) => current?.map((watchlist) => watchlist.id !== activeWatchlist.id
        ? watchlist
        : { ...watchlist, items: watchlist.items.filter((item) => item.id !== existing.id) }) ?? current);
      if (selectedTickerRef.current === ticker && nextSelectedTicker) {
        selectedTickerRef.current = nextSelectedTicker;
        setSelectedTicker(nextSelectedTicker);
      }
      setWatchlistStatus("ready");
      showToast(t("watchlist.removeSuccess", { symbol: ticker, name: activeWatchlist.name }));
    } catch {
      setWatchlistStatus("error");
      showToast(t("watchlist.removeError", { symbol: ticker }));
    }
  }, [activeWatchlist, showToast, t]);

  const reorderWatchlistItems = useCallback(async (itemIds: readonly string[]) => {
    if (!activeWatchlist || watchlistStatus === "saving") return;
    const currentItems = activeWatchlist.items.slice().sort((left, right) => left.position - right.position);
    if (
      itemIds.length !== currentItems.length
      || itemIds.some((itemId) => !currentItems.some((item) => item.id === itemId))
    ) {
      setWatchlistStatus("error");
      showToast(t("watchlist.reorderError"));
      return;
    }

    const itemById = new Map(currentItems.map((item) => [item.id, item]));
    const optimisticItems = itemIds.map((itemId, position) => ({
      ...itemById.get(itemId)!,
      position,
    }));
    const watchlistId = activeWatchlist.id;
    setWatchlists((current) => current?.map((watchlist) => watchlist.id === watchlistId
      ? { ...watchlist, items: optimisticItems }
      : watchlist) ?? current);
    setWatchlistStatus("saving");
    try {
      const response = await fetch(`/api/v1/watchlists/${encodeURIComponent(watchlistId)}/items/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds }),
      });
      if (!response.ok) throw new Error("watchlist reorder request failed");
      const payload = await response.json() as WatchlistMutationResponse;
      setWatchlists((current) => current?.map((watchlist) => watchlist.id === payload.watchlist.id
        ? payload.watchlist
        : watchlist) ?? current);
      setWatchlistStatus("ready");
      showToast(t("watchlist.reorderSuccess"));
    } catch {
      setWatchlists((current) => current?.map((watchlist) => watchlist.id === watchlistId
        ? { ...watchlist, items: currentItems }
        : watchlist) ?? current);
      setWatchlistStatus("error");
      showToast(t("watchlist.reorderError"));
    }
  }, [activeWatchlist, showToast, t, watchlistStatus]);

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
        providerId: "trader-ui",
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
    setStockDetailTabSelection({ ticker: selectedTicker, tab: DEFAULT_STOCK_DETAIL_TAB });
    setPrimaryView("stock-detail");
    setToolbarMenu(null);
  }, [selectedTicker]);

  const selectStockDetailSection = useCallback((section: StockDetailTabId) => {
    setStockDetailTabSelection({ ticker: selectedTicker, tab: section });
    if (section === "financials" || section === "analyst") {
      setWorkspaceSectionRefreshNonce((current) => current + 1);
    }
    if (section === "analyst") {
      setAnalystHistoryRefreshNonce((current) => current + 1);
    }
  }, [selectedTicker]);

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

  const beginRightPanelResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightPanelWidth;
    const handleMove = (moveEvent: PointerEvent) => {
      setRightPanelWidth(clampRightPanelWidth(startWidth + startX - moveEvent.clientX, rightPanelMaxWidth));
    };
    const finish = () => {
      document.documentElement.classList.remove("is-resizing-panel");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    document.documentElement.classList.add("is-resizing-panel");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  }, [rightPanelMaxWidth, rightPanelWidth]);

  const resizeRightPanelWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setRightPanelWidth((current) => {
      if (event.key === "Home") return clampRightPanelWidth(Number.NEGATIVE_INFINITY, rightPanelMaxWidth);
      if (event.key === "End") return clampRightPanelWidth(Number.POSITIVE_INFINITY, rightPanelMaxWidth);
      return clampRightPanelWidth(current + (event.key === "ArrowLeft" ? 16 : -16), rightPanelMaxWidth);
    });
  }, [rightPanelMaxWidth]);

  const beginWatchlistSplitResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds || bounds.height <= 0) return;
    const handleMove = (moveEvent: PointerEvent) => {
      const next = ((moveEvent.clientY - bounds.top) / bounds.height) * 100;
      setWatchlistSplitPercent(clampWatchlistSplitPercent(next));
    };
    const finish = () => {
      document.documentElement.classList.remove("is-resizing-panel");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    document.documentElement.classList.add("is-resizing-panel");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  }, []);

  const resizeWatchlistSplitWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setWatchlistSplitPercent((current) => {
      if (event.key === "Home") return clampWatchlistSplitPercent(Number.NEGATIVE_INFINITY);
      if (event.key === "End") return clampWatchlistSplitPercent(Number.POSITIVE_INFINITY);
      return clampWatchlistSplitPercent(current + (event.key === "ArrowDown" ? 2 : -2));
    });
  }, []);

  const selectWatchlist = useCallback((watchlistId: string) => {
    setActiveWatchlistId(watchlistId);
    window.localStorage.setItem("trader.active-watchlist.v1", watchlistId);
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

  const openWatchlistRename = useCallback((watchlistId: string) => {
    const targetWatchlist = watchlists?.find((watchlist) => watchlist.id === watchlistId) ?? null;
    if (!targetWatchlist) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    setManagedWatchlistId(targetWatchlist.id);
    setRenameWatchlistName(targetWatchlist.name);
    setAppDialog("watchlist-rename");
  }, [showToast, t, watchlists]);

  const renameActiveWatchlist = useCallback(async () => {
    if (!managedWatchlist) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    const name = renameWatchlistName.trim();
    if (!name || name.length > 60 || name === managedWatchlist.name) return;

    setWatchlistStatus("saving");
    try {
      const response = await fetch(`/api/v1/watchlists/${encodeURIComponent(managedWatchlist.id)}`, {
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
      setManagedWatchlistId("");
      setAppDialog(null);
      setWatchlistStatus("ready");
      showToast(t("watchlist.renameSuccess", { name: payload.watchlist.name }));
    } catch (error) {
      setWatchlistStatus("error");
      showToast(t(error instanceof Error && error.message === "watchlist_name_exists"
        ? "watchlist.renameDuplicate"
        : "watchlist.renameError"));
    }
  }, [managedWatchlist, renameWatchlistName, showToast, t]);

  const openWatchlistDelete = useCallback((watchlistId: string) => {
    const targetWatchlist = watchlists?.find((watchlist) => watchlist.id === watchlistId) ?? null;
    if (!targetWatchlist || !watchlists) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    if (watchlists.length <= 1) {
      showToast(t("watchlist.deleteLastRequired"));
      return;
    }
    setManagedWatchlistId(targetWatchlist.id);
    setAppDialog("watchlist-delete");
  }, [showToast, t, watchlists]);

  const deleteActiveWatchlist = useCallback(async () => {
    if (!managedWatchlist || !watchlists) {
      setWatchlistStatus("error");
      showToast(t("watchlist.loadError"));
      return;
    }
    if (watchlists.length <= 1) {
      setAppDialog(null);
      showToast(t("watchlist.deleteLastRequired"));
      return;
    }

    const deletingWatchlist = managedWatchlist;
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
      if (deletingWatchlist.id === activeWatchlistId) selectWatchlist(nextWatchlist.id);
      setManagedWatchlistId("");
      setAppDialog(null);
      setWatchlistStatus("ready");
      showToast(t("watchlist.deleteSuccess", { name: deletingWatchlist.name }));
    } catch (error) {
      const lastWatchlistRequired = error instanceof Error && error.message === "last_watchlist_required";
      setWatchlistStatus(lastWatchlistRequired ? "ready" : "error");
      showToast(t(lastWatchlistRequired ? "watchlist.deleteLastRequired" : "watchlist.deleteError"));
    }
  }, [activeWatchlistId, managedWatchlist, selectWatchlist, showToast, t, watchlists]);

  useEffect(() => {
    const updateMarketSessionClock = () => {
      const observedAt = Date.now();
      setMarketSessionClock(observedAt);
      // Clear the backing values at the opening boundary itself. Waiting for
      // the derived ticker-key effect leaves hosted tabs vulnerable to a late
      // provider response or a throttled effect cleanup briefly restoring a
      // pre-open value after 09:30 New York.
      if (isNominalUsRegularSession(new Date(observedAt))) {
        setAfterHoursBySymbol((current) => (
          Object.keys(current).length === 0 ? current : Object.freeze({})
        ));
      }
    };
    let boundaryTimer: number | undefined;
    const scheduleBoundary = () => {
      if (boundaryTimer !== undefined) window.clearTimeout(boundaryTimer);
      const delay = millisecondsUntilNextUsSessionBoundary(new Date());
      boundaryTimer = window.setTimeout(() => {
        boundaryTimer = undefined;
        updateMarketSessionClock();
        if (!document.hidden) {
          forceWatchlistQuoteSnapshotRef.current?.();
          forceChartBarsRefreshRef.current?.();
          forceDailyBarsRefreshRef.current?.();
        }
        scheduleBoundary();
      }, delay + 25);
    };
    const recheckVisibleSession = () => {
      updateMarketSessionClock();
      if (!document.hidden) {
        forceWatchlistQuoteSnapshotRef.current?.();
        forceChartBarsRefreshRef.current?.();
        forceDailyBarsRefreshRef.current?.();
      }
      scheduleBoundary();
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) recheckVisibleSession();
    };
    updateMarketSessionClock();
    scheduleBoundary();
    const timer = window.setInterval(updateMarketSessionClock, MARKET_SESSION_CLOCK_REFRESH_MS);
    window.addEventListener("focus", recheckVisibleSession);
    window.addEventListener("pageshow", recheckVisibleSession);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      if (boundaryTimer !== undefined) window.clearTimeout(boundaryTimer);
      window.removeEventListener("focus", recheckVisibleSession);
      window.removeEventListener("pageshow", recheckVisibleSession);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/watchlists", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("watchlists request failed");
        return response.json() as Promise<WatchlistsResponse>;
      })
      .then((payload) => {
        setWatchlists(payload.watchlists);
        const remembered = window.localStorage.getItem("trader.active-watchlist.v1");
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
    const symbols = quoteTickerKey
      ? quoteTickerKey.split("\u0000").slice(0, WATCHLIST_QUOTES_MAX_SYMBOLS)
      : [];
    if (symbols.length === 0) return;
    const symbolSet = new Set(symbols);
    const controller = new AbortController();
    let disposed = false;
    let requestInFlight = false;
    let forceRefreshPending = false;
    let lastRefreshStartedAt = 0;
    let refreshTimer: number | undefined;
    let sessionStateTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let streamReadyTimer: number | undefined;
    let flushTimer: number | undefined;
    let eventSource: EventSource | undefined;
    let longPollController: AbortController | undefined;
    let longPollRetryTimer: number | undefined;
    let streamConnected = false;
    let streamSupported: boolean | undefined;
    let longPollSupported = false;
    let providerQuotesEnabled = false;
    let reconnectDelay = 1_000;
    let longPollRetryDelay = 1_000;
    let longPollGeneration = 0;
    const pendingQuotes = new Map<string, Quote>();
    const latestAsOf = new Map<string, string>();
    const latestQuotes = new Map<string, Quote>();
    const resolvedSymbols = new Set<string>();

    const scheduleNext = () => {
      if (
        disposed
        || document.hidden
        || refreshTimer !== undefined
        || (streamConnected && resolvedSymbols.size >= symbols.length)
      ) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        refresh();
      }, WATCHLIST_QUOTE_REFRESH_MS);
    };

    const flushQuotes = () => {
      flushTimer = undefined;
      if (disposed || pendingQuotes.size === 0) return;
      const updates = new Map(pendingQuotes);
      pendingQuotes.clear();
      setStockModels((current) => {
        const next = { ...current };
        for (const [symbol, quote] of updates) {
          const merged = watchlistStreamQuoteStock(quote, next[symbol]);
          if (merged) next[symbol] = merged;
        }
        return next;
      });
    };

    const queueQuote = (symbol: string, quote: Quote) => {
      if (!providerQuotesEnabled || !symbolSet.has(symbol)) return;
      resolvedSymbols.add(symbol);
      const previousAsOf = latestAsOf.get(symbol);
      if (!isNewerWatchlistQuote(quote, previousAsOf)) return;
      latestAsOf.set(symbol, quote.provenance.asOf);
      latestQuotes.set(symbol, quote);
      observeMarketSession(symbol, quote.marketState, quote.provenance.ingestedAt);
      mergeLiveQuote(quote);
      pendingQuotes.set(symbol, quote);
      if (flushTimer === undefined) flushTimer = window.setTimeout(flushQuotes, 100);
    };

    function refresh(force = false) {
      if (disposed || document.hidden) return;
      if (requestInFlight) {
        if (force) forceRefreshPending = true;
        return;
      }
      if (force) forceRefreshPending = false;
      const startedAt = Date.now();
      if (!force && startedAt - lastRefreshStartedAt < WATCHLIST_QUOTE_REFRESH_MS - 1_000) {
        scheduleNext();
        return;
      }
      lastRefreshStartedAt = startedAt;
      const requestStartedAt = new Date(startedAt);
      requestInFlight = true;
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
          providerQuotesEnabled = response.dataMode === "provider";
          streamSupported = providerQuotesEnabled && response.streamSupported === true;
          longPollSupported = providerQuotesEnabled
            && response.longPollSupported === true
            && !streamSupported;
          if (!streamSupported) {
            if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
            disconnectStream();
          } else {
            connectStream();
          }
          if (longPollSupported) startQuoteLongPoll();
          else disconnectQuoteLongPoll();
          if (!providerQuotesEnabled) return;
          const requestStayedInsideTheSameNominalSession =
            didMarketDataRequestStayInNominalSession(requestStartedAt, new Date());
          // A quote snapshot begun before 09:30 or 16:00 belongs to the old
          // session. Discard the entire response; the boundary callback has
          // queued a forced snapshot whose price and state are both current.
          if (!requestStayedInsideTheSameNominalSession) return;
          for (const item of response.items) {
            if (item.quote) {
              const previousAsOf = latestAsOf.get(item.symbol);
              if (isNewerWatchlistQuote(item.quote, previousAsOf)) {
                latestQuotes.set(item.symbol, item.quote);
              }
              observeMarketSession(
                item.symbol,
                item.quote.marketState,
                item.quote.provenance.ingestedAt,
              );
            }
          }
          for (const item of response.items) {
            if (item.quote) mergeLiveQuote(item.quote);
          }
          setStockModels((current) => {
            const next = { ...current };
            for (const item of response.items) {
              if (!item.quote) continue;
              resolvedSymbols.add(item.symbol);
              const previousAsOf = latestAsOf.get(item.symbol);
              if (!isNewerWatchlistQuote(item.quote, previousAsOf)) continue;
              latestAsOf.set(item.symbol, item.quote.provenance.asOf);
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
          requestInFlight = false;
          if (forceRefreshPending && !disposed && !document.hidden) {
            forceRefreshPending = false;
            refresh(true);
            return;
          }
          scheduleNext();
        });
    }

    const disconnectQuoteLongPoll = () => {
      longPollGeneration += 1;
      longPollController?.abort("quote long poll stopped");
      longPollController = undefined;
      if (longPollRetryTimer !== undefined) window.clearTimeout(longPollRetryTimer);
      longPollRetryTimer = undefined;
    };

    const quoteLongPollCursors = () => Object.fromEntries(
      symbols.flatMap((symbol) => {
        const quote = latestQuotes.get(symbol);
        return quote
          ? [[symbol, { asOf: quote.provenance.asOf, price: quote.price }] as const]
          : [];
      }),
    );

    const scheduleQuoteLongPoll = (delay: number) => {
      if (
        disposed
        || document.hidden
        || !longPollSupported
        || longPollController
        || longPollRetryTimer !== undefined
      ) return;
      longPollRetryTimer = window.setTimeout(() => {
        longPollRetryTimer = undefined;
        startQuoteLongPoll();
      }, Math.max(0, delay));
    };

    const startQuoteLongPoll = () => {
      if (
        disposed
        || document.hidden
        || !longPollSupported
        || longPollController
      ) return;
      const generation = longPollGeneration;
      const pollController = new AbortController();
      longPollController = pollController;
      void fetch("/api/v1/watchlists/quotes/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols, cursors: quoteLongPollCursors() }),
        signal: pollController.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("watchlist quote long poll failed");
          return response.json() as Promise<WatchlistQuotesResponse>;
        })
        .then((response) => {
          if (
            disposed
            || generation !== longPollGeneration
            || response.schemaVersion !== WATCHLIST_QUOTES_SCHEMA_VERSION
            || response.dataMode !== "provider"
            || !Array.isArray(response.items)
          ) return;
          for (const item of response.items) {
            if (!item.quote || !symbolSet.has(item.symbol)) continue;
            const parsed = parseWatchlistQuoteStreamMessage(JSON.stringify({
              schemaVersion: WATCHLIST_QUOTE_STREAM_SCHEMA_VERSION,
              type: "quote",
              symbol: item.symbol,
              quote: item.quote,
            }));
            if (!parsed) continue;
            const current = latestQuotes.get(parsed.symbol);
            if (
              current?.price === parsed.quote.price
              && current.provenance.asOf === parsed.quote.provenance.asOf
            ) continue;
            queueQuote(parsed.symbol, parsed.quote);
          }
          longPollRetryDelay = 1_000;
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (pollController.signal.aborted) return;
          longPollRetryDelay = Math.min(30_000, longPollRetryDelay * 2);
        })
        .finally(() => {
          if (longPollController === pollController) longPollController = undefined;
          if (disposed || generation !== longPollGeneration) return;
          scheduleQuoteLongPoll(longPollRetryDelay === 1_000 ? 0 : longPollRetryDelay);
        });
    };

    const scheduleSessionStateRefresh = () => {
      if (disposed || document.hidden) return;
      if (!isNominalUsRegularSession(new Date())) {
        if (sessionStateTimer !== undefined) window.clearTimeout(sessionStateTimer);
        sessionStateTimer = undefined;
        return;
      }
      if (sessionStateTimer !== undefined) return;
      sessionStateTimer = window.setTimeout(() => {
        sessionStateTimer = undefined;
        if (disposed || document.hidden || !isNominalUsRegularSession(new Date())) return;
        refresh();
        scheduleSessionStateRefresh();
      }, WATCHLIST_SESSION_STATE_REFRESH_MS);
    };

    const disconnectStream = () => {
      streamConnected = false;
      if (streamReadyTimer !== undefined) window.clearTimeout(streamReadyTimer);
      streamReadyTimer = undefined;
      eventSource?.close();
      eventSource = undefined;
    };

    const connectStream = () => {
      if (
        disposed
        || document.hidden
        || streamSupported !== true
        || eventSource
        || typeof EventSource === "undefined"
      ) return;
      const query = new URLSearchParams({ symbols: symbols.join(",") });
      const source = new EventSource(`/api/v1/watchlists/quotes/stream?${query}`);
      eventSource = source;
      source.onmessage = (event) => {
        if (disposed || eventSource !== source) return;
        const message = parseWatchlistQuoteStreamMessage(event.data);
        if (!message) return;
        streamConnected = true;
        reconnectDelay = 1_000;
        if (streamReadyTimer !== undefined) window.clearTimeout(streamReadyTimer);
        streamReadyTimer = undefined;
        queueQuote(message.symbol, message.quote);
        if (resolvedSymbols.size >= symbols.length && refreshTimer !== undefined) {
          window.clearTimeout(refreshTimer);
          refreshTimer = undefined;
        }
      };
      const handleStreamFailure = () => {
        if (disposed || eventSource !== source) return;
        disconnectStream();
        refresh();
        if (streamSupported !== true) {
          scheduleNext();
          return;
        }
        if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = undefined;
          connectStream();
        }, reconnectDelay);
        reconnectDelay = Math.min(30_000, reconnectDelay * 2);
      };
      source.onerror = handleStreamFailure;
      streamReadyTimer = window.setTimeout(() => {
        streamReadyTimer = undefined;
        if (disposed || eventSource !== source || streamConnected) return;
        handleStreamFailure();
      }, 10_000);
    };

    const refreshNow = () => {
      if (disposed || document.hidden) return;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
      // Focus, pageshow, and exact market boundaries always require a fresh
      // provider session even if the price SSE has not emitted a new trade.
      refresh(true);
      if (streamSupported === true) connectStream();
      if (longPollSupported) startQuoteLongPoll();
      scheduleSessionStateRefresh();
    };

    forceWatchlistQuoteSnapshotRef.current = refreshNow;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
        if (sessionStateTimer !== undefined) window.clearTimeout(sessionStateTimer);
        if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
        refreshTimer = undefined;
        sessionStateTimer = undefined;
        reconnectTimer = undefined;
        disconnectStream();
        disconnectQuoteLongPoll();
        return;
      }
      refreshNow();
    };

    refresh();
    scheduleSessionStateRefresh();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    window.addEventListener("pageshow", refreshNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      controller.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (sessionStateTimer !== undefined) window.clearTimeout(sessionStateTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (streamReadyTimer !== undefined) window.clearTimeout(streamReadyTimer);
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      disconnectStream();
      disconnectQuoteLongPoll();
      if (forceWatchlistQuoteSnapshotRef.current === refreshNow) {
        forceWatchlistQuoteSnapshotRef.current = null;
      }
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      window.removeEventListener("pageshow", refreshNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [mergeLiveQuote, observeMarketSession, quoteTickerKey]);

  useEffect(() => {
    const symbols = afterHoursTickerKey
      ? afterHoursTickerKey.split("\u0000")
      : [];
    if (symbols.length === 0) {
      queueMicrotask(() => setAfterHoursBySymbol({}));
      return;
    }
    const symbolSet = new Set(symbols);
    const controller = new AbortController();
    let disposed = false;
    let requestInFlight = false;
    let refreshTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let streamReadyTimer: number | undefined;
    let streamLivenessTimer: number | undefined;
    let flushTimer: number | undefined;
    let freshnessTimer: number | undefined;
    let eventSource: EventSource | undefined;
    let webSocket: WebSocket | undefined;
    let longPollController: AbortController | undefined;
    let longPollRetryTimer: number | undefined;
    let activeStreamTransport: "websocket" | "sse" | undefined;
    let streamConnected = false;
    let streamSupported: boolean | undefined;
    let streamTransport: "websocket" | "sse" | undefined;
    let longPollSupported = false;
    let longPollRetryDelay = 1_000;
    let longPollGeneration = 0;
    let reconnectDelay = 1_000;
    let reconnectNotBefore = 0;
    const pendingCloses = new Map<string, SyntheticLatestClose>();
    const latestCloses = new Map<string, SyntheticLatestClose>();

    function scheduleFreshnessPrune() {
      if (disposed) return;
      if (freshnessTimer !== undefined) window.clearTimeout(freshnessTimer);
      freshnessTimer = undefined;
      const nextExpiration = Math.min(...[...latestCloses.values()].flatMap((item) => {
        if (!item.updatedAt) return [];
        const updatedAt = Date.parse(item.updatedAt);
        return Number.isFinite(updatedAt)
          ? [updatedAt + SYNTHETIC_LATEST_CLOSE_MAX_AGE_MS + 1]
          : [];
      }));
      if (!Number.isFinite(nextExpiration)) return;
      freshnessTimer = window.setTimeout(() => {
        freshnessTimer = undefined;
        pruneExpiredCloses();
      }, Math.max(1, Math.min(2_147_483_647, nextExpiration - Date.now())));
    }

    function pruneExpiredCloses() {
      if (disposed) return;
      const observedAt = Date.now();
      for (const [symbol, item] of pendingCloses) {
        if (!isFreshSyntheticLatestClose(item, observedAt)) pendingCloses.delete(symbol);
      }
      for (const [symbol, item] of latestCloses) {
        if (!isFreshSyntheticLatestClose(item, observedAt)) latestCloses.delete(symbol);
      }
      setAfterHoursBySymbol((current) => pruneStaleAfterHoursCloses(current, observedAt));
      scheduleFreshnessPrune();
    }

    function clearClose(symbol: string) {
      pendingCloses.delete(symbol);
      latestCloses.delete(symbol);
      setAfterHoursBySymbol((current) => {
        if (!(symbol in current)) return current;
        const next = { ...current };
        delete next[symbol];
        return next;
      });
      scheduleFreshnessPrune();
    }

    queueMicrotask(() => {
      if (disposed) return;
      setAfterHoursBySymbol((current) => {
        const observedAt = Date.now();
        const next = Object.fromEntries(
          Object.entries(current).filter(([symbol, item]) => (
            symbolSet.has(symbol) && isFreshSyntheticLatestClose(item, observedAt)
          )),
        );
        for (const [symbol, item] of Object.entries(next)) latestCloses.set(symbol, item);
        scheduleFreshnessPrune();
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
    });

    const scheduleNext = () => {
      if (disposed || document.hidden || refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        refresh();
      }, WATCHLIST_AFTER_HOURS_REFRESH_MS);
    };

    const flushCloses = () => {
      flushTimer = undefined;
      if (disposed || pendingCloses.size === 0) return;
      const updates = new Map(pendingCloses);
      pendingCloses.clear();
      setAfterHoursBySymbol((current) => {
        const next = { ...current };
        for (const [symbol, item] of updates) {
          if (
            isFreshSyntheticLatestClose(item)
            && isNewerAfterHoursClose(item, current[symbol]?.updatedAt)
          ) next[symbol] = item;
        }
        return next;
      });
      scheduleFreshnessPrune();
    };

    const queueClose = (item: SyntheticLatestClose) => {
      if (!symbolSet.has(item.symbol)) return false;
      const previous = latestCloses.get(item.symbol);
      if (item.close === null && item.updatedAt === null) {
        if (isFreshSyntheticLatestClose(previous)) return true;
        clearClose(item.symbol);
        return true;
      }
      if (!isFreshSyntheticLatestClose(item)) {
        if (isFreshSyntheticLatestClose(previous)) return true;
        clearClose(item.symbol);
        return true;
      }
      const previousUpdatedAt = previous?.updatedAt;
      if (!isNewerAfterHoursClose(item, previousUpdatedAt)) return false;
      latestCloses.set(item.symbol, item);
      pendingCloses.set(item.symbol, item);
      if (flushTimer === undefined) flushTimer = window.setTimeout(flushCloses, 100);
      scheduleFreshnessPrune();
      return true;
    };

    function refresh() {
      if (disposed || document.hidden || requestInFlight) return;
      requestInFlight = true;
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
          if (disposed) return;
          const nextTransport = response.streamTransport;
          streamSupported = response.streamSupported === true
            && nextTransport !== undefined;
          if (
            activeStreamTransport
            && nextTransport
            && activeStreamTransport !== nextTransport
          ) disconnectStream();
          streamTransport = nextTransport;
          longPollSupported = response.longPollSupported === true
            && !streamSupported;
          if (!streamSupported) {
            if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
            reconnectNotBefore = 0;
            disconnectStream();
          } else {
            connectStream();
          }
          for (const item of response.items) queueClose(item);
          if (longPollSupported) startLongPoll();
          else disconnectLongPoll();
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // A transient failure may retain only a still-fresh last value. The
          // independent expiry timer removes it at the five-minute boundary.
          pruneExpiredCloses();
        })
        .finally(() => {
          requestInFlight = false;
          scheduleNext();
        });
    }

    const disconnectLongPoll = () => {
      longPollGeneration += 1;
      longPollController?.abort("long poll stopped");
      longPollController = undefined;
      if (longPollRetryTimer !== undefined) window.clearTimeout(longPollRetryTimer);
      longPollRetryTimer = undefined;
    };

    const longPollCursors = (): readonly WatchlistAfterHoursPollCursor[] => {
      const observedAt = Date.now();
      return symbols.flatMap((symbol) => {
        const item = latestCloses.get(symbol);
        if (
          !isFreshSyntheticLatestClose(item, observedAt)
          || item.close === null
          || item.updatedAt === null
        ) return [];
        return [Object.freeze({
          symbol,
          sourceSymbol: item.sourceSymbol,
          close: item.close,
          updatedAt: item.updatedAt,
        })];
      });
    };

    const scheduleLongPoll = (delay: number) => {
      if (
        disposed
        || document.hidden
        || !longPollSupported
        || longPollController
        || longPollRetryTimer !== undefined
      ) return;
      longPollRetryTimer = window.setTimeout(() => {
        longPollRetryTimer = undefined;
        startLongPoll();
      }, Math.max(0, delay));
    };

    const startLongPoll = () => {
      if (
        disposed
        || document.hidden
        || !longPollSupported
        || longPollController
      ) return;
      const generation = longPollGeneration;
      const pollController = new AbortController();
      longPollController = pollController;
      void fetch("/api/v1/watchlists/after-hours/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols, cursors: longPollCursors() }),
        signal: pollController.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("after-hours long poll failed");
          return response.json() as Promise<WatchlistAfterHoursPollResponse>;
        })
        .then((response) => {
          if (
            disposed
            || generation !== longPollGeneration
            || response.schemaVersion !== WATCHLIST_AFTER_HOURS_POLL_SCHEMA_VERSION
            || !Array.isArray(response.items)
          ) return;
          for (const item of response.items) {
            const parsed = parseWatchlistAfterHoursStreamMessage(JSON.stringify({
              schemaVersion: WATCHLIST_AFTER_HOURS_STREAM_SCHEMA_VERSION,
              type: "quote",
              item,
            }));
            if (parsed) queueClose(parsed.item);
          }
          longPollRetryDelay = 1_000;
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (pollController.signal.aborted) return;
          longPollRetryDelay = Math.min(30_000, longPollRetryDelay * 2);
        })
        .finally(() => {
          if (longPollController === pollController) longPollController = undefined;
          if (disposed || generation !== longPollGeneration) return;
          scheduleLongPoll(longPollRetryDelay === 1_000 ? 0 : longPollRetryDelay);
        });
    };

    const disconnectStream = () => {
      streamConnected = false;
      if (streamReadyTimer !== undefined) window.clearTimeout(streamReadyTimer);
      if (streamLivenessTimer !== undefined) window.clearTimeout(streamLivenessTimer);
      streamReadyTimer = undefined;
      streamLivenessTimer = undefined;
      eventSource?.close();
      eventSource = undefined;
      if (webSocket) {
        const socket = webSocket;
        webSocket = undefined;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "stream ended");
      }
      activeStreamTransport = undefined;
    };

    const connectStream = () => {
      if (
        disposed
        || document.hidden
        || streamSupported !== true
        || eventSource
        || webSocket
        || reconnectTimer !== undefined
        || Date.now() < reconnectNotBefore
      ) return;
      const query = new URLSearchParams({ symbols: symbols.join(",") });
      const markPresent = (
        message: ReturnType<typeof parseWatchlistAfterHoursStreamMessage>,
      ) => {
        if (!message || !queueClose(message.item)) return false;
        if (!isFreshSyntheticLatestClose(message.item)) return false;
        streamConnected = true;
        reconnectDelay = 1_000;
        reconnectNotBefore = 0;
        if (streamReadyTimer !== undefined) window.clearTimeout(streamReadyTimer);
        streamReadyTimer = undefined;
        return true;
      };
      let failureHandled = false;
      const handleStreamFailure = () => {
        if (disposed || failureHandled) return;
        failureHandled = true;
        disconnectStream();
        if (streamSupported === false) {
          reconnectNotBefore = 0;
        } else {
          if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
          const delay = reconnectDelay;
          reconnectNotBefore = Date.now() + delay;
          const reconnectAfterBackoff = () => {
            if (disposed) return;
            const remaining = reconnectNotBefore - Date.now();
            if (remaining > 0) {
              reconnectTimer = window.setTimeout(reconnectAfterBackoff, remaining);
              return;
            }
            reconnectTimer = undefined;
            reconnectNotBefore = 0;
            connectStream();
          };
          reconnectTimer = window.setTimeout(reconnectAfterBackoff, delay);
          reconnectDelay = Math.min(30_000, reconnectDelay * 2);
        }
        // One failed transport gets one immediate snapshot. Resetting the
        // normal poll timer prevents a nearly-due poll from duplicating it,
        // while the reconnect gate keeps the snapshot response from skipping
        // the WebSocket backoff.
        if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
        refresh();
      };

      if (streamTransport === "websocket" && typeof WebSocket !== "undefined") {
        const socketUrl = new URL(
          `/api/v1/watchlists/after-hours/stream?${query}`,
          window.location.href,
        );
        socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
        let socket: WebSocket;
        try {
          socket = new WebSocket(socketUrl);
        } catch {
          handleStreamFailure();
          return;
        }
        webSocket = socket;
        activeStreamTransport = "websocket";
        const resetLivenessTimer = () => {
          if (streamLivenessTimer !== undefined) {
            window.clearTimeout(streamLivenessTimer);
          }
          streamLivenessTimer = window.setTimeout(() => {
            streamLivenessTimer = undefined;
            if (disposed || webSocket !== socket) return;
            handleStreamFailure();
          }, WATCHLIST_AFTER_HOURS_LIVENESS_TIMEOUT_MS);
        };
        socket.onopen = () => {
          if (disposed || webSocket !== socket) return;
          resetLivenessTimer();
        };
        socket.onmessage = (event) => {
          if (disposed || webSocket !== socket || typeof event.data !== "string") return;
          const message = parseWatchlistAfterHoursStreamMessage(event.data);
          if (markPresent(message)) resetLivenessTimer();
        };
        const handleSocketFailure = () => {
          if (disposed || webSocket !== socket) return;
          handleStreamFailure();
        };
        socket.onerror = handleSocketFailure;
        socket.onclose = handleSocketFailure;
        streamReadyTimer = window.setTimeout(() => {
          streamReadyTimer = undefined;
          if (disposed || webSocket !== socket || streamConnected) return;
          handleStreamFailure();
        }, WATCHLIST_AFTER_HOURS_PRESENT_TIMEOUT_MS);
        return;
      }

      if (streamTransport !== "sse" || typeof EventSource === "undefined") return;
      const source = new EventSource(`/api/v1/watchlists/after-hours/stream?${query}`);
      eventSource = source;
      activeStreamTransport = "sse";
      source.onmessage = (event) => {
        if (disposed || eventSource !== source) return;
        markPresent(parseWatchlistAfterHoursStreamMessage(event.data));
      };
      const handleEventSourceFailure = () => {
        if (disposed || eventSource !== source) return;
        handleStreamFailure();
      };
      source.onerror = handleEventSourceFailure;
      streamReadyTimer = window.setTimeout(() => {
        streamReadyTimer = undefined;
        if (disposed || eventSource !== source || streamConnected) return;
        handleEventSourceFailure();
      }, WATCHLIST_AFTER_HOURS_PRESENT_TIMEOUT_MS);
    };

    const refreshNow = () => {
      if (disposed || document.hidden) return;
      pruneExpiredCloses();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
      refresh();
      if (streamSupported === true) connectStream();
      if (longPollSupported) startLongPoll();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
        if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
        refreshTimer = undefined;
        reconnectTimer = undefined;
        reconnectNotBefore = 0;
        disconnectStream();
        disconnectLongPoll();
        return;
      }
      refreshNow();
    };

    refresh();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      controller.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (streamReadyTimer !== undefined) window.clearTimeout(streamReadyTimer);
      if (streamLivenessTimer !== undefined) window.clearTimeout(streamLivenessTimer);
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      if (freshnessTimer !== undefined) window.clearTimeout(freshnessTimer);
      disconnectStream();
      disconnectLongPoll();
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [afterHoursTickerKey]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = window.localStorage.getItem("trader.chart-preferences.v1");
        if (raw) {
          const saved = JSON.parse(raw) as Record<string, unknown>;
          const savedInterval = CHART_INTERVAL_OPTIONS.find((option) => option.interval === saved.interval)?.interval;
          if (savedInterval) setInterval(savedInterval);
          const savedCandleCount = parseChartCandleCount(saved.candleCount);
          if (savedCandleCount !== null) setChartCandleCount(savedCandleCount);
          const savedChartType = resolveChartTypeId(saved.chartType);
          if (savedChartType) setChartType(savedChartType);
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
        window.localStorage.removeItem("trader.chart-preferences.v1");
      } finally {
        if (!cancelled) setChartPreferencesReady(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!chartPreferencesReady) return;
    window.localStorage.setItem("trader.chart-preferences.v1", JSON.stringify({
      schemaVersion: "trader.chart-preferences.v1",
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
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const templates = parseChartTemplates(window.localStorage.getItem(CHART_TEMPLATE_STORAGE_KEY));
      setUserChartTemplates(templates as ChartTemplate<IndicatorSettings>[]);
      setChartTemplatesReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!chartTemplatesReady) return;
    window.localStorage.setItem(CHART_TEMPLATE_STORAGE_KEY, serializeChartTemplates(userChartTemplates));
  }, [chartTemplatesReady, userChartTemplates]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const saved = parseWorkspaceLayoutPreferences(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY));
      const maximum = rightPanelMaxForViewport(window.innerWidth);
      setRightPanelMaxWidth(maximum);
      setRightPanelWidth(clampRightPanelWidth(saved.rightPanelWidth, maximum));
      setWatchlistSplitPercent(saved.watchlistSplitPercent);
      setWorkspaceLayoutReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleViewportResize = () => {
      const maximum = rightPanelMaxForViewport(window.innerWidth);
      setRightPanelMaxWidth(maximum);
      setRightPanelWidth((current) => clampRightPanelWidth(current, maximum));
    };
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, []);

  useEffect(() => {
    if (!workspaceLayoutReady) return;
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, serializeWorkspaceLayoutPreferences({
      rightPanelWidth,
      watchlistSplitPercent,
    }));
  }, [rightPanelWidth, watchlistSplitPercent, workspaceLayoutReady]);

  useEffect(() => {
    queueMicrotask(() => {
      if (selectedTickerRef.current === selectedTicker) {
        setWorkspaceStatus("loading");
        workspaceRef.current = null;
        setWorkspace(null);
      }
    });
    void requestWorkspace(selectedTicker);
  }, [requestWorkspace, selectedTicker]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setStockDetailTabSelection((current) => canonicalStockDetailTabSelection(
          current,
          selectedTicker,
          traderConfig.ui.symbolDetail.tabs,
          DEFAULT_STOCK_DETAIL_TAB,
        ));
      }
    });
    return () => { cancelled = true; };
  }, [selectedTicker]);

  useEffect(() => {
    if (
      primaryView !== "stock-detail"
      || (activeStockDetailSection !== "financials" && activeStockDetailSection !== "analyst")
    ) return;
    void requestWorkspace(selectedTicker, activeStockDetailSection);
  }, [activeStockDetailSection, primaryView, requestWorkspace, selectedTicker, workspaceSectionRefreshNonce]);

  useEffect(() => {
    if (primaryView !== "chart" || utilityPanel !== "news" || focusMode) return;
    void requestWorkspace(selectedTicker, "news");
  }, [focusMode, primaryView, requestWorkspace, selectedTicker, utilityPanel]);

  useEffect(
    () => () => workspaceRequestCoordinator.abort(),
    [workspaceRequestCoordinator],
  );

  useEffect(() => {
    if (!marketDataSurfaceVisible) return;
    let disposed = false;
    let requestInFlight = false;
    let forceRefreshPending = false;
    let latestRequestGeneration = 0;
    let hasSuccessfulSnapshot = false;
    let refreshTimer: number | undefined;
    let activeController: AbortController | undefined;
    queueMicrotask(() => {
      if (!disposed) {
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
      fresh: "1",
    });
    const requestUrl = `/api/v1/symbols/${encodeURIComponent(selectedTicker)}/bars?${params}`;

    const clearRefreshTimer = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    };

    const scheduleNext = () => {
      if (disposed || document.hidden || refreshTimer !== undefined) return;
      const delay = marketBarsRefreshDelay(
        interval,
        marketSessionObservationRef.current[selectedTicker],
        new Date(),
      );
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        refresh();
      }, delay);
    };

    function refresh(force = false) {
      if (disposed || document.hidden) return;
      if (requestInFlight) {
        if (force) {
          forceRefreshPending = true;
          latestRequestGeneration = advanceMarketDataRequestGeneration(
            latestRequestGeneration,
          );
        }
        return;
      }
      if (force) forceRefreshPending = false;
      const requestGeneration = advanceMarketDataRequestGeneration(
        latestRequestGeneration,
      );
      latestRequestGeneration = requestGeneration;
      requestInFlight = true;
      const requestController = new AbortController();
      activeController = requestController;
      void fetch(requestUrl, {
        signal: requestController.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("bars request failed");
          return response.json() as Promise<MarketBarsResponse>;
        })
        .then((snapshot) => {
          if (
            disposed
            || !isCurrentMarketDataRequestGeneration(
              requestGeneration,
              latestRequestGeneration,
            )
            || snapshot.instrument.symbol !== selectedTicker
          ) return;
          hasSuccessfulSnapshot = true;
          setMarketBars(snapshot.bars.items);
          setMarketBarsSymbol(snapshot.instrument.symbol);
          setMarketBarsProvenance(snapshot.bars.provenance);
          setBarsStatus(snapshot.dataMode);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!isCurrentMarketDataRequestGeneration(
            requestGeneration,
            latestRequestGeneration,
          )) return;
          if (!hasSuccessfulSnapshot) setBarsStatus("error");
        })
        .finally(() => {
          if (activeController === requestController) activeController = undefined;
          requestInFlight = false;
          if (disposed) return;
          if (forceRefreshPending && !document.hidden) {
            forceRefreshPending = false;
            refresh(true);
            return;
          }
          scheduleNext();
        });
    }

    const refreshNow = () => {
      if (disposed || document.hidden) return;
      clearRefreshTimer();
      refresh(true);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearRefreshTimer();
        activeController?.abort();
      } else {
        refreshNow();
      }
    };

    forceChartBarsRefreshRef.current = refreshNow;
    refresh(true);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      clearRefreshTimer();
      activeController?.abort();
      if (forceChartBarsRefreshRef.current === refreshNow) {
        forceChartBarsRefreshRef.current = null;
      }
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [chartCandleCount, interval, marketDataSurfaceVisible, selectedTicker]);

  useEffect(() => {
    if (!shouldLoadAnalystHistory) return;
    let disposed = false;
    let activeController: AbortController | undefined;
    let refreshTimer: number | undefined;
    const hasCurrentHistory = () => (
      analystHistoryResponseRef.current?.dataMode === "provider"
      && analystHistoryResponseRef.current.instrument.symbol === selectedTicker
    );
    queueMicrotask(() => {
      if (!disposed && !hasCurrentHistory()) {
        setAnalystHistoryStatus("loading");
        analystHistoryResponseRef.current = null;
        setAnalystHistoryResponse(null);
      }
    });

    const clearRefreshTimer = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    };
    const scheduleNext = () => {
      if (disposed || document.hidden || refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, ANALYST_HISTORY_REFRESH_MS);
    };
    async function refresh() {
      if (disposed || document.hidden) return;
      clearRefreshTimer();
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const today = new Date();
      const dateTo = today.toISOString().slice(0, 10);
      const dateFrom = `${today.getUTCFullYear() - 2}-01-01`;
      const params = new URLSearchParams({
        pagesize: "1000",
        fresh: "1",
        "parameters[date_from]": dateFrom,
        "parameters[date_to]": dateTo,
        "parameters[tickers]": selectedTicker,
      });
      try {
        const response = await fetch(
          `/api/v1/symbols/${encodeURIComponent(selectedTicker)}/analyst-ratings?${params}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) throw new Error("analyst rating history request failed");
        const snapshot = await response.json() as AnalystRatingHistoryResponse;
        if (
          disposed
          || controller.signal.aborted
          || snapshot.dataMode !== "provider"
          || snapshot.instrument.symbol !== selectedTickerRef.current
        ) {
          if (!disposed && !controller.signal.aborted && snapshot.dataMode !== "provider") {
            analystHistoryResponseRef.current = null;
            setAnalystHistoryResponse(null);
            setAnalystHistoryStatus("error");
          }
          return;
        }
        analystHistoryResponseRef.current = snapshot;
        setAnalystHistoryResponse(snapshot);
        setAnalystHistoryStatus("ready");
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!disposed) setAnalystHistoryStatus(hasCurrentHistory() ? "ready" : "error");
      } finally {
        if (activeController === controller) activeController = undefined;
        scheduleNext();
      }
    }
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearRefreshTimer();
        activeController?.abort();
        return;
      }
      void refresh();
    };
    void refresh();
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      clearRefreshTimer();
      activeController?.abort();
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [analystHistoryRefreshNonce, selectedTicker, shouldLoadAnalystHistory]);

  useEffect(() => {
    if (!marketDataSurfaceVisible) return;
    let disposed = false;
    let requestInFlight = false;
    let forceRefreshPending = false;
    let latestRequestGeneration = 0;
    let hasSuccessfulSnapshot = false;
    let refreshTimer: number | undefined;
    let activeController: AbortController | undefined;
    const params = new URLSearchParams({
      range: CHART_RANGE,
      interval: "1d",
      count: String(DEFAULT_CHART_CANDLE_COUNT),
      fresh: "1",
    });
    queueMicrotask(() => {
      if (!disposed) {
        setDailyBarsStatus("loading");
        setDailyMarketBars([]);
        setDailyMarketBarsSymbol("");
        setDailyMarketBarsProvenance(undefined);
      }
    });
    const requestUrl = `/api/v1/symbols/${encodeURIComponent(selectedTicker)}/bars?${params}`;

    const clearRefreshTimer = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    };

    const scheduleNext = () => {
      if (disposed || document.hidden || refreshTimer !== undefined) return;
      const delay = marketBarsRefreshDelay(
        "1d",
        marketSessionObservationRef.current[selectedTicker],
        new Date(),
      );
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        refresh();
      }, delay);
    };

    function refresh(force = false) {
      if (disposed || document.hidden) return;
      if (requestInFlight) {
        if (force) {
          forceRefreshPending = true;
          latestRequestGeneration = advanceMarketDataRequestGeneration(
            latestRequestGeneration,
          );
        }
        return;
      }
      if (force) forceRefreshPending = false;
      const requestGeneration = advanceMarketDataRequestGeneration(
        latestRequestGeneration,
      );
      latestRequestGeneration = requestGeneration;
      requestInFlight = true;
      const requestController = new AbortController();
      activeController = requestController;
      void fetch(requestUrl, {
        signal: requestController.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("daily bars request failed");
          return response.json() as Promise<MarketBarsResponse>;
        })
        .then((response) => {
          if (
            disposed
            || !isCurrentMarketDataRequestGeneration(
              requestGeneration,
              latestRequestGeneration,
            )
            || response.instrument.symbol !== selectedTicker
          ) return;
          hasSuccessfulSnapshot = true;
          setDailyMarketBars(response.bars.items);
          setDailyMarketBarsSymbol(response.instrument.symbol);
          setDailyMarketBarsProvenance(response.bars.provenance);
          setDailyBarsStatus(response.dataMode);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!isCurrentMarketDataRequestGeneration(
            requestGeneration,
            latestRequestGeneration,
          )) return;
          if (!hasSuccessfulSnapshot) {
            setDailyMarketBars([]);
            setDailyMarketBarsSymbol("");
            setDailyMarketBarsProvenance(undefined);
            setDailyBarsStatus("error");
          }
        })
        .finally(() => {
          if (activeController === requestController) activeController = undefined;
          requestInFlight = false;
          if (disposed) return;
          if (forceRefreshPending && !document.hidden) {
            forceRefreshPending = false;
            refresh(true);
            return;
          }
          scheduleNext();
        });
    }

    const refreshNow = () => {
      if (disposed || document.hidden) return;
      clearRefreshTimer();
      refresh(true);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearRefreshTimer();
        activeController?.abort();
      } else {
        refreshNow();
      }
    };

    forceDailyBarsRefreshRef.current = refreshNow;
    refresh(true);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      clearRefreshTimer();
      activeController?.abort();
      if (forceDailyBarsRefreshRef.current === refreshNow) {
        forceDailyBarsRefreshRef.current = null;
      }
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [marketDataSurfaceVisible, selectedTicker]);

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
        <div className="brand-lockup workspace-brand-lockup" aria-label={TRADER_BRAND.name}>
          <Image className="brand-logo" src={TRADER_BRAND.logoPath} alt="" width={28} height={28} unoptimized aria-hidden="true" />
          <strong>{TRADER_BRAND.wordmark}</strong>
        </div>
        <button type="button" role="tab" aria-selected={primaryView !== "strategy"} className={primaryView !== "strategy" ? "active" : ""} onClick={() => setPrimaryView("chart")}><ChartBar size={15} /> {t("nav.chart")}</button>
        <button type="button" role="tab" aria-label={t("nav.strategies")} aria-selected={primaryView === "strategy"} className={primaryView === "strategy" ? "active" : ""} onClick={() => setPrimaryView("strategy")}><Lightning size={15} /> {t("nav.strategies")}</button>
        <span />
        <span className="workspace-nav-spacer" />
        <IconButton className="workspace-settings-button" label={t("nav.settings")} onClick={openWorkspaceSettings}><Gear size={18} /></IconButton>
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
          <div className="toolbar-popover-host hide-narrow" ref={chartTypeMenuHostRef}>
            <button ref={chartTypeMenuTriggerRef} type="button" className="toolbar-button" aria-haspopup="menu" aria-expanded={toolbarMenu === "chart-type"} aria-controls="chart-type-menu" onClick={() => setToolbarMenu((current) => current === "chart-type" ? null : "chart-type")}>
              <ChartBar size={17} />
              {t(chartType === "candles" ? "toolbar.candlestick" : chartType === "heikin-ashi" ? "toolbar.heikinAshi" : chartType === "line" ? "toolbar.line" : "toolbar.area")}
              <CaretDown size={12} />
            </button>
            {toolbarMenu === "chart-type" && (
              <div id="chart-type-menu" className="toolbar-popover chart-type-menu" role="menu">
                {([
                  ["candles", "toolbar.candlestick"],
                  ["heikin-ashi", "toolbar.heikinAshi"],
                  ["line", "toolbar.line"],
                  ["area", "toolbar.area"],
                ] as const).map(([item, labelKey]) => (
                  <button type="button" className={chartType === item ? "active" : ""} key={item} onClick={() => { setChartType(item); setToolbarMenu(null); }}>
                    {chartType === item && <Check size={13} />}{t(labelKey)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className={`toolbar-button hide-narrow ${indicatorLibraryOpen ? "selected" : ""}`} onClick={() => setIndicatorLibraryOpen(true)}><FunctionIcon size={17} /> {t("toolbar.indicators")}</button>
          <div className="toolbar-popover-host hide-mid" ref={templateMenuHostRef}>
            <button ref={templateMenuTriggerRef} type="button" className="toolbar-button" aria-haspopup="menu" aria-expanded={toolbarMenu === "templates"} aria-controls="indicator-template-menu" onClick={() => {
              setToolbarMenu((current) => {
                const next = current === "templates" ? null : "templates";
                if (next === null) {
                  setTemplateEditor(null);
                  setTemplateNameError(null);
                }
                return next;
              });
            }}><Rows size={17} /> {t("toolbar.templates")}</button>
            {toolbarMenu === "templates" && (
              <div id="indicator-template-menu" className="toolbar-popover template-menu" role="menu">
                <span>{t("toolbar.builtInTemplates")}</span>
                <button className="template-option" type="button" onClick={() => applyBuiltInChartTemplate("builtin-trend", t("toolbar.trendTemplate"), ["sma20", "ema50", "rsi14"])}>{t("toolbar.trendTemplate")}<small>{t("toolbar.trendTemplateHelp")}</small></button>
                <button className="template-option" type="button" onClick={() => applyBuiltInChartTemplate("builtin-volatility", t("toolbar.volatilityTemplate"), ["bollinger", "atr14", "macd"])}>{t("toolbar.volatilityTemplate")}<small>{t("toolbar.volatilityTemplateHelp")}</small></button>
                <button className="template-option" type="button" onClick={() => applyBuiltInChartTemplate("builtin-clean", t("toolbar.noIndicators"), [])}>{t("toolbar.noIndicators")}<small>{t("toolbar.noIndicatorsHelp")}</small></button>
                {userChartTemplates.length > 0 && <span>{t("toolbar.userTemplates")}</span>}
                {userChartTemplates.map((template) => (
                  <div className="template-row" key={template.id}>
                    <button type="button" onClick={() => applyChartTemplate(template)}>{template.name}<small>{t("toolbar.indicatorCount", { count: template.activeIndicators.length })}</small></button>
                    <span className="template-row-actions">
                      <button type="button" aria-label={t("toolbar.renameTemplate", { name: template.name })} onClick={() => openTemplateEditor("rename", template)}><PencilLine size={14} /></button>
                      <button type="button" aria-label={t("toolbar.deleteTemplate", { name: template.name })} onClick={() => deleteChartTemplate(template)}><Trash size={14} /></button>
                    </span>
                  </div>
                ))}
                {templateEditor ? (
                  <form className="template-editor" onSubmit={(event) => { event.preventDefault(); saveTemplateEditor(); }}>
                    <label htmlFor="template-name-input">{t(templateEditor.mode === "create" ? "toolbar.newTemplateName" : "toolbar.renameTemplateName")}</label>
                    <input id="template-name-input" value={templateNameDraft} maxLength={MAX_CHART_TEMPLATE_NAME_LENGTH} aria-invalid={templateNameError !== null} onChange={(event) => { setTemplateNameDraft(event.target.value); setTemplateNameError(null); }} autoFocus />
                    {templateNameError && <small role="alert">{t(templateNameError === "empty" ? "toolbar.templateNameEmpty" : templateNameError === "too-long" ? "toolbar.templateNameTooLong" : "toolbar.templateNameDuplicate", { max: MAX_CHART_TEMPLATE_NAME_LENGTH })}</small>}
                    <div>
                      <button type="button" onClick={() => { setTemplateEditor(null); setTemplateNameError(null); }}>{t("common.cancel")}</button>
                      <button type="submit" className="template-save">{t("common.save")}</button>
                    </div>
                  </form>
                ) : (
                  <button className="template-create" type="button" onClick={() => openTemplateEditor("create")}><Plus size={14} /> {t("toolbar.saveCurrentTemplate")}</button>
                )}
              </div>
            )}
          </div>
        </> : primaryView === "strategy" ? <>
          <div className="strategy-toolbar-title"><Lightning size={18} weight="fill" /><span><strong>{t("toolbar.strategyReport")}</strong><small>{t("toolbar.strategySubtitle")}</small></span></div>
        </> : <>
          <button type="button" className="symbol-search-trigger" onClick={openInstrumentSearch}><MagnifyingGlass size={17} /><span><b>{stock.ticker}</b><small>{stock.name}</small></span><span className="shortcut-key">⌘ F</span></button>
          <div className="toolbar-divider" />
          <div className="strategy-toolbar-title stock-detail-toolbar-title"><ChartLineUp size={18} /><span><strong>{t("toolbar.symbolDetails")}</strong><small>{t("toolbar.symbolDetailsSubtitle")}</small></span></div>
          <button type="button" className="toolbar-button hide-mid" onClick={() => setPrimaryView("chart")}><ChartBar size={17} /> {t("toolbar.openChart")}</button>
        </>}
        <div className="toolbar-spacer" />
      </header>

      {primaryView === "chart" ? <div
        className={`workspace-grid ${utilityPanel && !focusMode ? "" : "utility-closed"} ${focusMode ? "focus-mode" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelWidth}px`,
          "--watchlist-split-percent": `${watchlistSplitPercent}%`,
        } as React.CSSProperties}
      >
        <section className="chart-area">
          <div className="chart-commandbar">
            <button type="button" className="chart-symbol-button" onClick={openInstrumentSearch}>
              <CompanyLogo stock={stock} eager />
              <span><b>{stock.ticker}</b><small>{stock.market}</small></span>
              <CaretDown size={12} />
            </button>
            <div className="quote-summary">
              <strong>{formatPrice(stock)}</strong>
              {Number.isFinite(stock.price) && stock.price > 0
                && Number.isFinite(stock.change)
                && Number.isFinite(stock.changeValue) ? (
                  <span className={stock.change >= 0 ? "positive" : "negative-text"}>
                    {stock.changeValue >= 0 ? "+" : ""}{stock.changeValue.toFixed(stock.currency === "$" ? 2 : 1)} ({stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)}%)
                  </span>
                ) : <span>—</span>}
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
              <PriceChart stock={stock} marketBars={detailMarketBars} range={CHART_RANGE} interval={interval} candleCount={chartCandleCount} chartType={chartType} activeIndicators={visibleIndicatorIds} indicatorSettings={indicatorSettings} timeScaleSync={chartTimeScaleSync} />
              {barsStatus === "loading" && <div className="chart-data-state" role="status"><LoadingIndicator label={t("chart.historyLoading")} /></div>}
              {barsStatus === "error" && <div className="chart-data-state is-error" role="alert"><span>{t("chart.historyError")}</span><button type="button" onClick={() => forceChartBarsRefreshRef.current?.()}>{t("common.retry")}</button></div>}
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
            <SubIndicatorPanes bars={detailMarketBars} indicators={subIndicatorSpecs} dataIdentity={`${stock.ticker}:${CHART_RANGE}:${interval}:${chartCandleCount}`} timeScaleSync={chartTimeScaleSync} />
          </div>
        </section>

        <aside className={`right-panel utility-panel ${utilityPanel && !focusMode ? "is-open" : ""}`}>
          {utilityPanel && !focusMode && <div
            className="right-panel-resizer"
            role="separator"
            aria-label={t("layout.resizeRightPanel")}
            aria-orientation="vertical"
            aria-valuemin={MIN_RIGHT_PANEL_WIDTH}
            aria-valuemax={rightPanelMaxWidth}
            aria-valuenow={rightPanelWidth}
            tabIndex={0}
            onPointerDown={beginRightPanelResize}
            onKeyDown={resizeRightPanelWithKeyboard}
          />}
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
                onReorder={reorderWatchlistItems}
                persistenceStatus={watchlistStatus}
                afterHours={afterHoursBySymbol}
                afterHoursEnabled={afterHoursEnabled}
              />
              <div
                className="watchlist-split-resizer"
                role="separator"
                aria-label={t("layout.resizeWatchlistSummary")}
                aria-orientation="horizontal"
                aria-valuemin={MIN_WATCHLIST_SPLIT_PERCENT}
                aria-valuemax={MAX_WATCHLIST_SPLIT_PERCENT}
                aria-valuenow={watchlistSplitPercent}
                tabIndex={0}
                onPointerDown={beginWatchlistSplitResize}
                onKeyDown={resizeWatchlistSplitWithKeyboard}
              />
              <div className="stock-summary-scroll" aria-label={t("summary.ariaLabel", { symbol: stock.ticker })}>
                <SymbolSummaryHost
                  stock={stock}
                  intelligence={stockIntelligence}
                  afterHours={afterHoursEnabled ? afterHoursBySymbol[stock.ticker] : undefined}
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
              {(showAllNews ? visibleNews : visibleNews.slice(0, 3)).map((item, index) => (
                <a className="right-news-row" href={item.url} target="_blank" rel="noopener noreferrer" key={`${item.title}-${index}`}>
                  <span>{item.time} · {item.source}</span>
                  <strong>{item.title}</strong>
                  {item.summary && <small>{item.summary}</small>}
                </a>
              ))}
              {visibleNews.length === 0 && (
                <div className="empty-state">
                  {workspaceStatus === "loading" ? <LoadingIndicator /> : t(workspaceStatus === "provider"
                      ? "news.empty"
                      : "status.connectionError")}
                </div>
              )}
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

      </div> : primaryView === "stock-detail" ? <StockDetailPage stock={stock} targetPriceMarketBars={detailDailyMarketBars} earnings={detailWorkspace?.earnings ?? []} analystHistory={selectedAnalystHistory} analystHistoryStatus={analystHistoryStatus} detail={stockDetailViewModel} dataStatus={researchDataStatus} workspaceStatus={workspaceStatus} barsStatus={dailyBarsStatus} watched={watched} activeSection={activeStockDetailSection} onBack={() => setPrimaryView("chart")} onActiveSectionChange={selectStockDetailSection} onToggleWatched={() => toggleWatched(stock.ticker)} /> : <StrategyHome onOpenChart={openChartFromStrategy} onAction={showToast} />}

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
              {searchView === "loading" && <div className="empty-state" role="status"><LoadingIndicator label={t(query.trim() ? "search.loadingQuery" : "search.loadingCandidates")} /></div>}
              {searchView === "empty" && <div className="empty-state">{t("search.empty")}</div>}
              {searchView === "error" && <div className="empty-state search-error-state" role="alert"><span>{t("search.retryHint")}</span><button type="button" onClick={() => { setSearchResults([]); setSearchStatus("loading"); setSearchRetryNonce((value) => value + 1); }}>{t("common.retry")}</button></div>}
            </div>
          </section>
        </div>
      )}

      {appDialog === "settings" && <DialogShell title={t("settings.workspace.title")} eyebrow={t("settings.workspace.eyebrow")} onClose={() => setAppDialog(null)}><div className="dialog-body settings-list"><label><span><strong>{t("settings.candles.title")}</strong><small>{t("settings.candles.help", { min: MIN_CHART_CANDLE_COUNT.toLocaleString(numberLocale), max: MAX_CHART_CANDLE_COUNT.toLocaleString(numberLocale) })}</small></span><input type="number" inputMode="numeric" min={MIN_CHART_CANDLE_COUNT} max={MAX_CHART_CANDLE_COUNT} step={1} value={chartCandleCountDraft} aria-label={t("settings.candles.title")} aria-invalid={parseChartCandleCount(chartCandleCountDraft) === null} onChange={(event) => setChartCandleCountDraft(event.target.value)} /></label><label><span><strong>{t("settings.priceGrid.title")}</strong><small>{t("settings.priceGrid.help")}</small></span><input type="checkbox" defaultChecked /></label><label><span><strong>{t("settings.watermark.title")}</strong><small>{t("settings.watermark.help")}</small></span><input type="checkbox" defaultChecked /></label><label><span><strong>{t("settings.extendedHours.title")}</strong><small>{t("settings.extendedHours.help")}</small></span><input type="checkbox" /></label><label><span><strong>{t("settings.language.title")}</strong><small>{t("settings.language.description")} {t("settings.language.storageNote")}</small></span><select value={localeDraft} aria-label={t("settings.language.title")} onChange={(event) => setLocaleDraft(event.target.value as Locale)}>{supportedLocales.map((option) => <option key={option.code} value={option.code}>{option.nativeLabel}{option.code === "en" ? ` · ${t("settings.language.default")}` : ""}</option>)}</select></label></div><footer className="dialog-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.cancel")}</button><button type="button" className="primary-action" onClick={applyWorkspaceSettings}>{t("common.apply")}</button></footer></DialogShell>}

      {appDialog === "snapshot" && <DialogShell title={t("snapshot.title")} eyebrow={`${stock.ticker} · ${localizedIntervalLabel(interval, locale)}`} onClose={() => setAppDialog(null)} wide><div className="dialog-body snapshot-dialog"><div className="snapshot-preview"><PriceChart stock={stock} marketBars={detailMarketBars} range={CHART_RANGE} interval={interval} candleCount={chartCandleCount} chartType={chartType} activeIndicators={visibleIndicatorIds} indicatorSettings={indicatorSettings} /></div><div className="snapshot-meta"><span>1280 × 720</span><span>Trader watermark</span><span>{barsStatus === "provider" ? `${detailBarsProvenance?.providerId ?? "Provider"} data` : "Fixture data"}</span></div></div><footer className="dialog-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.close")}</button><button type="button" className="primary-action" onClick={() => { setAppDialog(null); showToast(t("snapshot.prepared")); }}><DownloadSimple size={15} /> {t("snapshot.save")}</button></footer></DialogShell>}

      {appDialog === "watchlist-create" && <DialogShell title={t("watchlist.createDialogTitle")} eyebrow={t("watchlist.createDialogEyebrow")} onClose={() => setAppDialog(null)}><form className="dialog-body dialog-form-grid" onSubmit={(event) => { event.preventDefault(); void createWatchlist(); }}><label><span>{t("watchlist.name")}</span><input value={newWatchlistName} maxLength={60} onChange={(event) => setNewWatchlistName(event.target.value)} placeholder={t("watchlist.namePlaceholder")} autoFocus /></label><p className="dialog-helper-copy">{t("watchlist.createHelp")}</p><footer className="dialog-actions form-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.cancel")}</button><button type="submit" className="primary-action" disabled={!newWatchlistName.trim() || watchlistStatus === "saving"}>{t(watchlistStatus === "saving" ? "watchlist.creating" : "common.create")}</button></footer></form></DialogShell>}

      {appDialog === "watchlist-rename" && managedWatchlist && <DialogShell title={t("watchlist.renameDialogTitle")} eyebrow={t("watchlist.renameDialogEyebrow")} onClose={() => setAppDialog(null)}><form className="dialog-body dialog-form-grid" onSubmit={(event) => { event.preventDefault(); void renameActiveWatchlist(); }}><label><span>{t("watchlist.name")}</span><input value={renameWatchlistName} maxLength={60} aria-invalid={!renameWatchlistName.trim() || renameWatchlistName.trim().length > 60} onChange={(event) => setRenameWatchlistName(event.target.value)} placeholder={t("watchlist.namePlaceholder")} autoFocus /></label><p className="dialog-helper-copy">{t("watchlist.renameHelp")}</p><footer className="dialog-actions form-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.cancel")}</button><button type="submit" className="primary-action" disabled={!renameWatchlistName.trim() || renameWatchlistName.trim().length > 60 || renameWatchlistName.trim() === managedWatchlist.name || watchlistStatus === "saving"}>{t(watchlistStatus === "saving" ? "watchlist.renaming" : "common.save")}</button></footer></form></DialogShell>}

      {appDialog === "watchlist-delete" && managedWatchlist && <DialogShell title={t("watchlist.deleteDialogTitle")} eyebrow={t("watchlist.deleteDialogEyebrow")} onClose={() => setAppDialog(null)}><div className="dialog-body confirm-copy"><Trash size={28} /><p>{t("watchlist.deleteHelp", { name: managedWatchlist.name })}</p></div><footer className="dialog-actions"><button type="button" onClick={() => setAppDialog(null)}>{t("common.cancel")}</button><button type="button" className="danger-action" disabled={watchlistStatus === "saving" || !watchlists || watchlists.length <= 1} onClick={() => void deleteActiveWatchlist()}>{t(watchlistStatus === "saving" ? "watchlist.deleting" : "common.delete")}</button></footer></DialogShell>}

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
