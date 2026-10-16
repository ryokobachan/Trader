import type {
  DataProvenance,
  MarketBar,
  SymbolWorkspace,
} from "@/app/platform/provider-contracts";
import {
  computeIndicatorSeries,
  latestIndicatorValue,
  latestWilderRsiValue,
} from "@/app/features/chart-indicators/indicator-calculations";
import type { StockDetailMetricId } from "./ids";
import {
  buildStockDetailTechnicalRatings,
  normalizeTechnicalRatingBars,
  type TechnicalRatingSummary,
} from "./technical-ratings";

export type StockDetailMetric = Readonly<{
  id: StockDetailMetricId;
  label: string;
  value: string;
  note?: string;
  tone?: "positive" | "negative";
  href?: string;
}>;

export type StockDetailSource = Readonly<{
  label: string;
  asOf?: string;
  sourceId?: string;
  isStale?: boolean;
}>;

export type StockDetailSection = Readonly<{
  source: StockDetailSource;
  metrics: readonly StockDetailMetric[];
  context?: string;
}>;

export type StockDetailEarningsRow = Readonly<{
  reportDate: string;
  fiscalDateEnding?: string;
  metrics: readonly StockDetailMetric[];
}>;

export type StockDetailViewModel = Readonly<{
  identity: Readonly<{
    symbol: string;
    name: string;
    exchange: string;
    sector?: string;
  }> | null;
  quote: Readonly<{
    price: number;
    change: number;
    changePercent: number;
    marketState: string;
    source: StockDetailSource;
  }> | null;
  profile: StockDetailSection & Readonly<{ description?: string; descriptionLanguage?: "ja" | "en"; descriptionSource?: StockDetailSource }>;
  market: StockDetailSection;
  fundamentals: StockDetailSection;
  earnings: Readonly<{
    source: StockDetailSource;
    rows: readonly StockDetailEarningsRow[];
  }>;
  analyst: StockDetailSection;
  technicals: StockDetailSection;
  technicalRatings: TechnicalRatingSummary;
  warnings: readonly string[];
}>;

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const compactCurrencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const STOCK_DETAIL_METRIC_LABELS = {
  "profile.exchange": "上場市場",
  "profile.assetType": "証券種別",
  "profile.sector": "セクター",
  "profile.industry": "業種",
  "profile.location": "所在地",
  "profile.employees": "従業員",
  "profile.website": "Webサイト",
  "profile.marketCap": "時価総額",
  "profile.ipoDate": "IPO",
  "profile.beta": "ベータ",
  "market.currentPrice": "現在値",
  "market.previousClose": "前日終値",
  "market.open": "始値",
  "market.high": "高値",
  "market.low": "安値",
  "market.volume": "出来高",
  "market.marketCap": "時価総額",
  "market.delaySeconds": "公称遅延",
  "fundamentals.researchAndDevelopment": "研究開発費",
  "fundamentals.sellingGeneralAndAdministrative": "販売費・一般管理費",
  "fundamentals.totalLiabilities": "負債合計",
  "fundamentals.investingCashFlow": "投資CF",
  "fundamentals.financingCashFlow": "財務CF",
  "fundamentals.revenue": "売上高",
  "fundamentals.revenueGrowth": "売上高成長率",
  "fundamentals.grossProfit": "粗利益",
  "fundamentals.operatingIncome": "営業利益",
  "fundamentals.ebitda": "EBITDA",
  "fundamentals.netIncome": "純利益",
  "fundamentals.eps": "EPS",
  "fundamentals.epsGrowth": "EPS成長率",
  "fundamentals.enterpriseValue": "企業価値（EV）",
  "fundamentals.trailingPe": "実績PER",
  "fundamentals.forwardPe": "予想PER",
  "fundamentals.pegRatio": "PEG",
  "fundamentals.priceToBook": "P / B",
  "fundamentals.priceToSales": "P / S",
  "fundamentals.priceToFreeCashFlow": "P / FCF",
  "fundamentals.enterpriseValueToRevenue": "EV / 売上高",
  "fundamentals.enterpriseValueToEbitda": "EV / EBITDA",
  "fundamentals.earningsYield": "利益利回り",
  "fundamentals.roe": "ROE",
  "fundamentals.roa": "ROA",
  "fundamentals.roic": "ROIC",
  "fundamentals.grossMargin": "粗利率",
  "fundamentals.operatingMargin": "営業利益率",
  "fundamentals.ebitdaMargin": "EBITDAマージン",
  "fundamentals.netMargin": "純利益率",
  "fundamentals.freeCashFlowMargin": "FCFマージン",
  "fundamentals.assetTurnover": "総資産回転率",
  "fundamentals.interestCoverage": "インタレスト・カバレッジ",
  "fundamentals.altmanZScore": "Altman Zスコア",
  "fundamentals.piotroskiScore": "Piotroski Fスコア",
  "fundamentals.freeFloatRatio": "浮動株比率",
  "fundamentals.floatShares": "浮動株数",
  "fundamentals.outstandingShares": "発行済株式数",
  "fundamentals.cashAndShortTermInvestments": "現金・短期投資",
  "fundamentals.totalAssets": "総資産",
  "fundamentals.totalDebt": "有利子負債",
  "fundamentals.netDebt": "ネットデット",
  "fundamentals.shareholdersEquity": "株主資本",
  "fundamentals.debtToEquity": "D / E",
  "fundamentals.currentRatio": "流動比率",
  "fundamentals.quickRatio": "当座比率",
  "fundamentals.cashRatio": "現金比率",
  "fundamentals.operatingCashFlow": "営業CF",
  "fundamentals.capitalExpenditure": "設備投資",
  "fundamentals.freeCashFlow": "フリーCF",
  "fundamentals.freeCashFlowYield": "FCF利回り",
  "fundamentals.dividendYield": "配当利回り",
  "fundamentals.dividendPerShare": "1株配当",
  "fundamentals.payoutRatio": "配当性向",
  "fundamentals.revenuePerShare": "1株売上高",
  "fundamentals.bookValuePerShare": "1株簿価",
  "fundamentals.operatingCashFlowPerShare": "1株営業CF",
  "fundamentals.freeCashFlowPerShare": "1株FCF",
  "earnings.epsActual": "EPS実績",
  "earnings.epsEstimate": "EPS予想",
  "earnings.revenueActual": "売上高実績",
  "earnings.revenueEstimate": "売上高予想",
  "analyst.targetConsensus": "目標価格・平均",
  "analyst.targetMedian": "目標価格・中央値",
  "analyst.targetLow": "目標価格・下限",
  "analyst.targetHigh": "目標価格・上限",
  "analyst.analystCount": "アナリスト数",
  "analyst.strongBuy": "強い買い",
  "analyst.buy": "買い",
  "analyst.hold": "中立",
  "analyst.sell": "売り",
  "analyst.strongSell": "強い売り",
  "analyst.forwardEps": "予想EPS",
  "analyst.forwardRevenue": "予想売上高",
  "analyst.targetUpside": "平均目標への乖離",
  "technical.periodRange": "取得期間レンジ",
  "technical.periodReturn": "取得期間リターン",
  "technical.vwap": "期間VWAP",
  "technical.sma20": "SMA 20",
  "technical.averageVolume20": "平均出来高 20",
  "technical.ema50": "EMA 50",
  "technical.rsi14": "RSI 14",
  "technical.atr14": "ATR 14",
  "technical.realizedVolatility30": "実現ボラティリティ 30",
} as const satisfies Readonly<Record<StockDetailMetricId, string>>;

function identifiedMetric(
  id: StockDetailMetricId,
  value: Omit<StockDetailMetric, "id" | "label">,
): StockDetailMetric {
  return { id, label: STOCK_DETAIL_METRIC_LABELS[id], ...value };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatCurrency(value: number) {
  return currencyFormatter.format(value);
}

function formatCompactCurrency(value: number) {
  return compactCurrencyFormatter.format(value);
}

function formatCompactNumber(value: number) {
  return compactNumberFormatter.format(value);
}

function formatPercent(value: number, digits = 1) {
  const normalized = value * 100;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(digits)}%`;
}

function formatUnsignedPercent(value: number, digits = 1) {
  const normalized = value * 100;
  return `${normalized.toFixed(digits)}%`;
}

function formatMultiple(value: number) {
  return `${value.toFixed(2)}x`;
}

function metric(
  id: StockDetailMetricId,
  value: number | undefined,
  formatter: (input: number) => string,
  options: Omit<StockDetailMetric, "id" | "label" | "value"> = {},
): StockDetailMetric | null {
  if (!isFiniteNumber(value)) return null;
  return identifiedMetric(id, { value: formatter(value), ...options });
}

function present<T>(items: readonly (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}

function providerName(providerId: string) {
  const normalized = providerId.trim().toLowerCase();
  if (normalized.includes("google-finance") && normalized.includes("benzinga")) {
    return "Google Finance + Benzinga";
  }
  if (normalized.includes("google-finance")) return "Google Finance";
  if (normalized.includes("tipranks") && normalized.includes("benzinga")) return "TipRanks + Benzinga";
  if (normalized.includes("tipranks")) return "TipRanks";
  if (normalized.includes("benzinga")) return "Benzinga";
  if (normalized === "yahoo-japan") return "Yahoo!ファイナンス（日本）";
  if (normalized.includes("yahoo")) return "Yahoo Finance";
  if (normalized.includes("tradingview")) return "TradingView";
  if (normalized === "stockanalysis") return "Stock Analysis";
  if (normalized === "fmp" || normalized.includes("financial-modeling-prep")) return "FMP";
  if (normalized === "mock") return "Mock Provider";
  return providerId.trim();
}

/** Format a configured provider chain while retaining its primary/fallback order. */
export function formatStockDetailProviderChain(providerChain?: string) {
  if (!providerChain?.trim()) return "Provider未選択";
  const providers = providerChain
    .split(/\s*(?:->|→|>|\||,|\+)\s*/)
    .filter(Boolean)
    .map(providerName);
  return providers
    .map((provider, index) => index === 0 ? provider : `${provider} (fallback)`)
    .join(" → ");
}

function sourceFrom(
  provenances: readonly (DataProvenance | undefined)[],
  selectedProvider?: string,
): StockDetailSource {
  const available = provenances.filter((item): item is DataProvenance => Boolean(item));
  const providerLabels = [...new Set(available.map((item) => providerName(item.providerId)))];
  const first = available[0];
  return {
    label: providerLabels.length > 0
      ? providerLabels.join(" / ")
      : formatStockDetailProviderChain(selectedProvider),
    asOf: first?.asOf,
    sourceId: first?.sourceId,
    isStale: available.some((item) => item.isStale),
  };
}

function quoteMarketState(value: SymbolWorkspace["quote"]["marketState"]) {
  const labels = {
    pre_market: "プレマーケット",
    regular: "取引中",
    after_hours: "時間外取引",
    closed: "取引時間外",
  } as const;
  return labels[value];
}

function average(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Calculate only indicators supported by the supplied OHLCV observations. */
export function buildStockDetailTechnicalMetrics(
  bars: readonly MarketBar[],
): readonly StockDetailMetric[] {
  const validBars = normalizeTechnicalRatingBars(bars);
  if (validBars.length === 0) return [];

  const closes = validBars.map((bar) => bar.close);
  const latest = validBars.at(-1)!;
  const periodLow = Math.min(...validBars.map((bar) => bar.low));
  const periodHigh = Math.max(...validBars.map((bar) => bar.high));
  const metrics: (StockDetailMetric | null)[] = [
    identifiedMetric("technical.periodRange", {
      value: `${formatCurrency(periodLow)} — ${formatCurrency(periodHigh)}`,
      note: `${validBars.length.toLocaleString("ja-JP")}本のOHLCV`,
    }),
  ];

  if (validBars.length >= 2 && closes[0] !== 0) {
    const periodReturn = latest.close / closes[0] - 1;
    metrics.push(identifiedMetric("technical.periodReturn", {
      value: formatPercent(periodReturn),
      tone: periodReturn >= 0 ? "positive" : "negative",
    }));
  }

  const totalVolume = validBars.reduce((sum, bar) => sum + bar.volume, 0);
  if (totalVolume > 0) {
    const weightedTypicalPrice = validBars.reduce(
      (sum, bar) => sum + ((bar.high + bar.low + bar.close) / 3) * bar.volume,
      0,
    );
    metrics.push(identifiedMetric("technical.vwap", {
      value: formatCurrency(weightedTypicalPrice / totalVolume),
      note: "取得OHLCV全期間",
    }));
  }

  if (validBars.length >= 20) {
    metrics.push(identifiedMetric("technical.sma20", {
      value: formatCurrency(average(closes.slice(-20))),
      note: "終値・日足20本",
    }));
    metrics.push(identifiedMetric("technical.averageVolume20", {
      value: formatCompactNumber(average(validBars.slice(-20).map((bar) => bar.volume))),
      note: "日足20本",
    }));
  }

  if (validBars.length >= 50) {
    const ema50 = latestIndicatorValue(computeIndicatorSeries(validBars, {
      id: "ema50",
      length: 50,
      source: "終値",
    }), "ema");
    if (ema50 !== undefined) {
      metrics.push(identifiedMetric("technical.ema50", { value: formatCurrency(ema50), note: "終値・日足50本以上" }));
    }
  }

  if (validBars.length >= 15) {
    const rsi = latestWilderRsiValue(validBars, { length: 14, source: "終値" });
    if (rsi !== undefined) {
      metrics.push(identifiedMetric("technical.rsi14", { value: rsi.toFixed(1), note: "終値・日足14期間" }));
    }

    const atr = latestIndicatorValue(computeIndicatorSeries(validBars, {
      id: "atr14",
      length: 14,
    }), "atr");
    if (atr !== undefined) {
      metrics.push(identifiedMetric("technical.atr14", { value: formatCurrency(atr), note: "Wilder平滑・日足14期間" }));
    }
  }

  if (validBars.length >= 31) {
    const recentCloses = closes.slice(-31);
    const returns = recentCloses.slice(1).map((close, index) => close / recentCloses[index] - 1);
    const mean = average(returns);
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    metrics.push(identifiedMetric("technical.realizedVolatility30", {
      value: formatUnsignedPercent(Math.sqrt(variance) * Math.sqrt(252)),
      note: "日次リターン・年率換算",
    }));
  }

  return present(metrics);
}

export function buildStockDetailViewModel(
  workspace: SymbolWorkspace | null,
  bars: readonly MarketBar[],
  barsProvenance?: DataProvenance,
  locale: "en" | "ja" = "en",
): StockDetailViewModel {
  const selected = workspace?.selectedProviders;
  const rawProfile = workspace?.profile;
  const localizedProfile = locale === "ja" ? rawProfile?.localized?.ja : undefined;
  const profile = rawProfile && localizedProfile ? { ...rawProfile, ...localizedProfile } : rawProfile;
  const fundamentals = workspace?.fundamentals;
  const analyst = workspace?.analyst;
  const instrument = workspace?.instrument;
  const quote = workspace?.quote;

  const profileMetrics: (StockDetailMetric | null)[] = [];
  if (instrument) {
    profileMetrics.push(
      identifiedMetric("profile.exchange", { value: instrument.exchange }),
      identifiedMetric("profile.assetType", { value: instrument.assetType === "adr" ? "ADR" : "普通株" }),
    );
  }
  const sector = profile?.sector ?? instrument?.sector;
  const industry = profile?.industry ?? instrument?.industry;
  if (sector) profileMetrics.push(identifiedMetric("profile.sector", { value: sector }));
  if (industry) profileMetrics.push(identifiedMetric("profile.industry", { value: industry }));
  const location = [profile?.city, profile?.country].filter(Boolean).join(" · ");
  if (location) profileMetrics.push(identifiedMetric("profile.location", { value: location }));
  profileMetrics.push(
    metric("profile.employees", profile?.employees, (value) => `${value.toLocaleString("ja-JP")}人`),
    metric("profile.marketCap", quote?.marketCap ?? profile?.marketCap, formatCompactCurrency),
    profile?.ipoDate ? identifiedMetric("profile.ipoDate", { value: profile.ipoDate }) : null,
    metric("profile.beta", profile?.beta, (value) => value.toFixed(2)),
  );

  const marketMetrics = quote ? present<StockDetailMetric>([
    metric("market.currentPrice", quote.price, formatCurrency),
    metric("market.previousClose", quote.previousClose, formatCurrency),
    metric("market.open", quote.open, formatCurrency),
    metric("market.high", quote.high, formatCurrency),
    metric("market.low", quote.low, formatCurrency),
    metric("market.volume", quote.volume, formatCompactNumber),
    metric("market.marketCap", quote.marketCap, formatCompactCurrency),
    metric("market.delaySeconds", quote.delaySeconds, (value) => `${value.toLocaleString("ja-JP")}秒`),
  ]) : [];

  const fundamentalCurrencyNote = "Provider最新値 · USD";
  const fundamentalPercentNote = "Provider最新値 · %";
  const fundamentalRatioNote = "Provider最新値 · 倍率";
  const fundamentalPerShareNote = "Provider最新値 · USD / 株";
  const fundamentalShareCountNote = "Provider最新値 · 株式数";
  const providerScoreNote = "Provider算出値 · スコア";
  const fundamentalMetrics = fundamentals ? present<StockDetailMetric>([
    metric("fundamentals.researchAndDevelopment", fundamentals.researchAndDevelopment, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.sellingGeneralAndAdministrative", fundamentals.sellingGeneralAndAdministrative, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.totalLiabilities", fundamentals.totalLiabilities, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.investingCashFlow", fundamentals.investingCashFlow, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.financingCashFlow", fundamentals.financingCashFlow, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.revenue", fundamentals.revenue, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.revenueGrowth", fundamentals.revenueGrowth, formatPercent, {
      tone: isFiniteNumber(fundamentals.revenueGrowth) && fundamentals.revenueGrowth < 0 ? "negative" : "positive",
      note: fundamentalPercentNote,
    }),
    metric("fundamentals.grossProfit", fundamentals.grossProfit, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.operatingIncome", fundamentals.operatingIncome, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.ebitda", fundamentals.ebitda, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.netIncome", fundamentals.netIncome, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.eps", fundamentals.eps, formatCurrency, { note: fundamentalPerShareNote }),
    metric("fundamentals.epsGrowth", fundamentals.epsGrowth, formatPercent, {
      tone: isFiniteNumber(fundamentals.epsGrowth) && fundamentals.epsGrowth < 0 ? "negative" : "positive",
      note: fundamentalPercentNote,
    }),
    metric("fundamentals.enterpriseValue", fundamentals.enterpriseValue, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.trailingPe", fundamentals.trailingPe, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.forwardPe", fundamentals.forwardPe, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.pegRatio", fundamentals.pegRatio, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.priceToBook", fundamentals.priceToBook, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.priceToSales", fundamentals.priceToSales, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.priceToFreeCashFlow", fundamentals.priceToFreeCashFlow, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.enterpriseValueToRevenue", fundamentals.enterpriseValueToRevenue, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.enterpriseValueToEbitda", fundamentals.enterpriseValueToEbitda, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.earningsYield", fundamentals.earningsYield, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.roe", fundamentals.roe, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.roa", fundamentals.roa, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.roic", fundamentals.roic, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.grossMargin", fundamentals.grossMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.operatingMargin", fundamentals.operatingMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.ebitdaMargin", fundamentals.ebitdaMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.netMargin", fundamentals.netMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.freeCashFlowMargin", fundamentals.freeCashFlowMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.assetTurnover", fundamentals.assetTurnover, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.interestCoverage", fundamentals.interestCoverage, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.piotroskiScore", fundamentals.financialHealth?.piotroskiScore, (value) => `${value.toFixed(0)} / 9`, { note: fundamentals.financialHealth?.piotroskiScorePeriod ?? providerScoreNote }),
    metric("fundamentals.altmanZScore", fundamentals.financialHealth?.altmanZScore, (value) => value.toFixed(2), { note: fundamentals.financialHealth?.altmanZScorePeriod ?? providerScoreNote }),
    metric("fundamentals.freeFloatRatio", fundamentals.shareStructure?.freeFloatRatio, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.floatShares", fundamentals.shareStructure?.floatShares, formatCompactNumber, { note: fundamentalShareCountNote }),
    metric("fundamentals.outstandingShares", fundamentals.shareStructure?.outstandingShares, formatCompactNumber, { note: fundamentalShareCountNote }),
    metric("fundamentals.cashAndShortTermInvestments", fundamentals.cashAndShortTermInvestments, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.totalAssets", fundamentals.totalAssets, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.totalDebt", fundamentals.totalDebt, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.netDebt", fundamentals.netDebt, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.shareholdersEquity", fundamentals.shareholdersEquity, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.debtToEquity", fundamentals.debtToEquity, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.currentRatio", fundamentals.currentRatio, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.quickRatio", fundamentals.quickRatio, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.cashRatio", fundamentals.cashRatio, formatMultiple, { note: fundamentalRatioNote }),
    metric("fundamentals.operatingCashFlow", fundamentals.operatingCashFlow, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.capitalExpenditure", fundamentals.capitalExpenditure, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.freeCashFlow", fundamentals.freeCashFlow, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("fundamentals.freeCashFlowYield", fundamentals.freeCashFlowYield, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.dividendYield", fundamentals.dividendYield, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.dividendPerShare", fundamentals.dividendPerShare, formatCurrency, { note: fundamentalPerShareNote }),
    metric("fundamentals.payoutRatio", fundamentals.payoutRatio, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("fundamentals.revenuePerShare", fundamentals.revenuePerShare, formatCurrency, { note: fundamentalPerShareNote }),
    metric("fundamentals.bookValuePerShare", fundamentals.bookValuePerShare, formatCurrency, { note: fundamentalPerShareNote }),
    metric("fundamentals.operatingCashFlowPerShare", fundamentals.operatingCashFlowPerShare, formatCurrency, { note: fundamentalPerShareNote }),
    metric("fundamentals.freeCashFlowPerShare", fundamentals.freeCashFlowPerShare, formatCurrency, { note: fundamentalPerShareNote }),
  ]) : [];

  const earningsRows = (workspace?.earnings ?? []).map((event) => ({
    reportDate: event.reportDate,
    fiscalDateEnding: event.fiscalDateEnding,
    metrics: present<StockDetailMetric>([
      metric("earnings.epsActual", event.epsActual, formatCurrency),
      metric("earnings.epsEstimate", event.epsEstimate, formatCurrency),
      metric("earnings.revenueActual", event.revenueActual, formatCompactCurrency),
      metric("earnings.revenueEstimate", event.revenueEstimate, formatCompactCurrency),
    ]),
  }));

  const analystMetrics = analyst ? present<StockDetailMetric>([
    metric("analyst.targetConsensus", analyst.targetConsensus, formatCurrency),
    metric("analyst.targetMedian", analyst.targetMedian, formatCurrency),
    metric("analyst.targetLow", analyst.targetLow, formatCurrency),
    metric("analyst.targetHigh", analyst.targetHigh, formatCurrency),
    metric("analyst.analystCount", analyst.ratingCount ?? analyst.analystCount, (value) => `${value.toLocaleString("ja-JP")}名`),
    metric("analyst.strongBuy", analyst.strongBuy, (value) => value.toLocaleString("ja-JP")),
    metric("analyst.buy", analyst.buy, (value) => value.toLocaleString("ja-JP")),
    metric("analyst.hold", analyst.hold, (value) => value.toLocaleString("ja-JP")),
    metric("analyst.sell", analyst.sell, (value) => value.toLocaleString("ja-JP")),
    metric("analyst.strongSell", analyst.strongSell, (value) => value.toLocaleString("ja-JP")),
    metric("analyst.forwardEps", analyst.forwardEps, formatCurrency),
    metric("analyst.forwardRevenue", analyst.forwardRevenue, formatCompactCurrency),
    analyst.targetConsensus !== undefined && quote?.price
      ? identifiedMetric("analyst.targetUpside", {
          value: formatPercent(analyst.targetConsensus / quote.price - 1),
          tone: analyst.targetConsensus >= quote.price ? "positive" : "negative",
        })
      : null,
  ]) : [];

  const technicalRatings = buildStockDetailTechnicalRatings(bars);

  return {
    identity: instrument ? {
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      sector,
    } : null,
    quote: quote ? {
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      marketState: quoteMarketState(quote.marketState),
      source: sourceFrom([quote.provenance], selected?.market),
    } : null,
    profile: {
      description: profile?.description,
      descriptionLanguage: profile?.description && /[ぁ-んァ-ヶ一-龯]/u.test(profile.description) ? "ja" : "en",
      descriptionSource: sourceFrom([localizedProfile?.description
        ? localizedProfile.descriptionProvenance ?? localizedProfile.provenance
        : rawProfile?.provenance], selected?.profile),
      metrics: present(profileMetrics),
      source: sourceFrom([rawProfile?.provenance, localizedProfile?.provenance, instrument?.provenance], selected?.profile ?? selected?.fundamentals ?? selected?.instrument),
    },
    market: {
      metrics: marketMetrics,
      source: sourceFrom([quote?.provenance], selected?.market),
      context: quote ? quoteMarketState(quote.marketState) : undefined,
    },
    fundamentals: {
      metrics: fundamentalMetrics,
      source: sourceFrom([fundamentals?.provenance], selected?.fundamentals),
      context: fundamentals?.period,
    },
    earnings: {
      rows: earningsRows,
      source: sourceFrom(
        (workspace?.earnings ?? []).map((event) => event.provenance),
        selected?.earnings ?? selected?.fundamentals,
      ),
    },
    analyst: {
      metrics: analystMetrics,
      source: sourceFrom([analyst?.provenance], selected?.analyst),
    },
    technicals: {
      metrics: buildStockDetailTechnicalMetrics(bars),
      source: sourceFrom([barsProvenance], selected?.market),
      context: technicalRatings.barCount > 0 ? `${technicalRatings.barCount.toLocaleString("ja-JP")}本` : undefined,
    },
    technicalRatings,
    warnings: workspace?.warnings ?? [],
  };
}
