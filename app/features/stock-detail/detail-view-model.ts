import type {
  DataProvenance,
  MarketBar,
  SymbolWorkspace,
} from "../../platform/provider-contracts";

export type StockDetailMetric = Readonly<{
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
  profile: StockDetailSection & Readonly<{ description?: string }>;
  market: StockDetailSection;
  fundamentals: StockDetailSection;
  earnings: Readonly<{
    source: StockDetailSource;
    rows: readonly StockDetailEarningsRow[];
  }>;
  analyst: StockDetailSection;
  technicals: StockDetailSection;
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
  label: string,
  value: number | undefined,
  formatter: (input: number) => string,
  options: Omit<StockDetailMetric, "label" | "value"> = {},
): StockDetailMetric | null {
  if (!isFiniteNumber(value)) return null;
  return { label, value: formatter(value), ...options };
}

function present<T>(items: readonly (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}

function providerName(providerId: string) {
  const normalized = providerId.trim().toLowerCase();
  if (normalized.includes("benzinga")) return "Benzinga";
  if (normalized.includes("yahoo")) return "Yahoo Finance";
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

function normalizeBars(bars: readonly MarketBar[]) {
  return bars.filter((bar) => (
    isFiniteNumber(bar.open)
    && isFiniteNumber(bar.high)
    && isFiniteNumber(bar.low)
    && isFiniteNumber(bar.close)
    && isFiniteNumber(bar.volume)
    && bar.high >= bar.low
    && bar.volume >= 0
  ));
}

function average(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Calculate only indicators supported by the supplied OHLCV observations. */
export function buildStockDetailTechnicalMetrics(
  bars: readonly MarketBar[],
): readonly StockDetailMetric[] {
  const validBars = normalizeBars(bars);
  if (validBars.length === 0) return [];

  const closes = validBars.map((bar) => bar.close);
  const latest = validBars.at(-1)!;
  const periodLow = Math.min(...validBars.map((bar) => bar.low));
  const periodHigh = Math.max(...validBars.map((bar) => bar.high));
  const metrics: (StockDetailMetric | null)[] = [
    {
      label: "取得期間レンジ",
      value: `${formatCurrency(periodLow)} — ${formatCurrency(periodHigh)}`,
      note: `${validBars.length.toLocaleString("ja-JP")}本のOHLCV`,
    },
  ];

  if (validBars.length >= 2 && closes[0] !== 0) {
    const periodReturn = latest.close / closes[0] - 1;
    metrics.push({
      label: "取得期間リターン",
      value: formatPercent(periodReturn),
      tone: periodReturn >= 0 ? "positive" : "negative",
    });
  }

  const totalVolume = validBars.reduce((sum, bar) => sum + bar.volume, 0);
  if (totalVolume > 0) {
    const weightedTypicalPrice = validBars.reduce(
      (sum, bar) => sum + ((bar.high + bar.low + bar.close) / 3) * bar.volume,
      0,
    );
    metrics.push({
      label: "期間VWAP",
      value: formatCurrency(weightedTypicalPrice / totalVolume),
      note: "取得OHLCV全期間",
    });
  }

  if (validBars.length >= 20) {
    metrics.push({
      label: "SMA 20",
      value: formatCurrency(average(closes.slice(-20))),
      note: "終値・日足20本",
    });
    metrics.push({
      label: "平均出来高 20",
      value: formatCompactNumber(average(validBars.slice(-20).map((bar) => bar.volume))),
      note: "日足20本",
    });
  }

  if (validBars.length >= 50) {
    const multiplier = 2 / 51;
    const ema50 = closes.reduce(
      (current, close, index) => index === 0
        ? close
        : close * multiplier + current * (1 - multiplier),
      closes[0],
    );
    metrics.push({ label: "EMA 50", value: formatCurrency(ema50), note: "終値・日足50本以上" });
  }

  if (validBars.length >= 15) {
    const recent = closes.slice(-15);
    const changes = recent.slice(1).map((close, index) => close - recent[index]);
    const averageGain = average(changes.map((change) => Math.max(0, change)));
    const averageLoss = average(changes.map((change) => Math.max(0, -change)));
    const rsi = averageGain === 0 && averageLoss === 0
      ? 50
      : averageLoss === 0
        ? 100
        : 100 - 100 / (1 + averageGain / averageLoss);
    metrics.push({ label: "RSI 14", value: rsi.toFixed(1), note: "終値・日足14期間" });

    const atrWindow = validBars.slice(-15);
    const trueRanges = atrWindow.slice(1).map((bar, index) => {
      const previousClose = atrWindow[index].close;
      return Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previousClose),
        Math.abs(bar.low - previousClose),
      );
    });
    metrics.push({ label: "ATR 14", value: formatCurrency(average(trueRanges)), note: "日足14期間" });
  }

  if (validBars.length >= 31) {
    const recentCloses = closes.slice(-31);
    const returns = recentCloses.slice(1).map((close, index) => close / recentCloses[index] - 1);
    const mean = average(returns);
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    metrics.push({
      label: "実現ボラティリティ 30",
      value: formatUnsignedPercent(Math.sqrt(variance) * Math.sqrt(252)),
      note: "日次リターン・年率換算",
    });
  }

  return present(metrics);
}

export function buildStockDetailViewModel(
  workspace: SymbolWorkspace | null,
  bars: readonly MarketBar[],
  barsProvenance?: DataProvenance,
): StockDetailViewModel {
  const selected = workspace?.selectedProviders;
  const profile = workspace?.profile;
  const fundamentals = workspace?.fundamentals;
  const analyst = workspace?.analyst;
  const instrument = workspace?.instrument;
  const quote = workspace?.quote;

  const profileMetrics: (StockDetailMetric | null)[] = [];
  if (instrument) {
    profileMetrics.push(
      { label: "上場市場", value: instrument.exchange },
      { label: "証券種別", value: instrument.assetType === "adr" ? "ADR" : "普通株" },
    );
  }
  const sector = profile?.sector ?? instrument?.sector;
  const industry = profile?.industry ?? instrument?.industry;
  if (sector) profileMetrics.push({ label: "セクター", value: sector });
  if (industry) profileMetrics.push({ label: "業種", value: industry });
  const location = [profile?.city, profile?.country].filter(Boolean).join(" · ");
  if (location) profileMetrics.push({ label: "所在地", value: location });
  profileMetrics.push(
    metric("従業員", profile?.employees, (value) => `${value.toLocaleString("ja-JP")}人`),
    profile?.website
      ? { label: "Webサイト", value: profile.website, href: profile.website }
      : null,
    profile?.ipoDate ? { label: "IPO", value: profile.ipoDate } : null,
    metric("ベータ", profile?.beta, (value) => value.toFixed(2)),
  );

  const marketMetrics = quote ? present<StockDetailMetric>([
    metric("現在値", quote.price, formatCurrency),
    metric("前日終値", quote.previousClose, formatCurrency),
    metric("始値", quote.open, formatCurrency),
    metric("高値", quote.high, formatCurrency),
    metric("安値", quote.low, formatCurrency),
    metric("出来高", quote.volume, formatCompactNumber),
    metric("時価総額", quote.marketCap, formatCompactCurrency),
    metric("公称遅延", quote.delaySeconds, (value) => `${value.toLocaleString("ja-JP")}秒`),
  ]) : [];

  const fundamentalCurrencyNote = "Provider最新値 · USD";
  const fundamentalPercentNote = "Provider最新値 · %";
  const fundamentalRatioNote = "Provider最新値 · 倍率";
  const fundamentalPerShareNote = "Provider最新値 · USD / 株";
  const fundamentalMetrics = fundamentals ? present<StockDetailMetric>([
    metric("売上高", fundamentals.revenue, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("売上高成長率", fundamentals.revenueGrowth, formatPercent, {
      tone: isFiniteNumber(fundamentals.revenueGrowth) && fundamentals.revenueGrowth < 0 ? "negative" : "positive",
      note: fundamentalPercentNote,
    }),
    metric("粗利益", fundamentals.grossProfit, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("営業利益", fundamentals.operatingIncome, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("EBITDA", fundamentals.ebitda, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("純利益", fundamentals.netIncome, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("EPS", fundamentals.eps, formatCurrency, { note: fundamentalPerShareNote }),
    metric("EPS成長率", fundamentals.epsGrowth, formatPercent, {
      tone: isFiniteNumber(fundamentals.epsGrowth) && fundamentals.epsGrowth < 0 ? "negative" : "positive",
      note: fundamentalPercentNote,
    }),
    metric("企業価値（EV）", fundamentals.enterpriseValue, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("実績PER", fundamentals.trailingPe, formatMultiple, { note: fundamentalRatioNote }),
    metric("予想PER", fundamentals.forwardPe, formatMultiple, { note: fundamentalRatioNote }),
    metric("PEG", fundamentals.pegRatio, formatMultiple, { note: fundamentalRatioNote }),
    metric("P / B", fundamentals.priceToBook, formatMultiple, { note: fundamentalRatioNote }),
    metric("P / S", fundamentals.priceToSales, formatMultiple, { note: fundamentalRatioNote }),
    metric("P / FCF", fundamentals.priceToFreeCashFlow, formatMultiple, { note: fundamentalRatioNote }),
    metric("EV / 売上高", fundamentals.enterpriseValueToRevenue, formatMultiple, { note: fundamentalRatioNote }),
    metric("EV / EBITDA", fundamentals.enterpriseValueToEbitda, formatMultiple, { note: fundamentalRatioNote }),
    metric("利益利回り", fundamentals.earningsYield, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("ROE", fundamentals.roe, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("ROA", fundamentals.roa, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("ROIC", fundamentals.roic, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("粗利率", fundamentals.grossMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("営業利益率", fundamentals.operatingMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("EBITDAマージン", fundamentals.ebitdaMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("純利益率", fundamentals.netMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("FCFマージン", fundamentals.freeCashFlowMargin, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("総資産回転率", fundamentals.assetTurnover, formatMultiple, { note: fundamentalRatioNote }),
    metric("インタレスト・カバレッジ", fundamentals.interestCoverage, formatMultiple, { note: fundamentalRatioNote }),
    metric("現金・短期投資", fundamentals.cashAndShortTermInvestments, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("総資産", fundamentals.totalAssets, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("有利子負債", fundamentals.totalDebt, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("ネットデット", fundamentals.netDebt, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("株主資本", fundamentals.shareholdersEquity, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("D / E", fundamentals.debtToEquity, formatMultiple, { note: fundamentalRatioNote }),
    metric("流動比率", fundamentals.currentRatio, formatMultiple, { note: fundamentalRatioNote }),
    metric("当座比率", fundamentals.quickRatio, formatMultiple, { note: fundamentalRatioNote }),
    metric("現金比率", fundamentals.cashRatio, formatMultiple, { note: fundamentalRatioNote }),
    metric("営業CF", fundamentals.operatingCashFlow, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("設備投資", fundamentals.capitalExpenditure, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("フリーCF", fundamentals.freeCashFlow, formatCompactCurrency, { note: fundamentalCurrencyNote }),
    metric("FCF利回り", fundamentals.freeCashFlowYield, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("配当利回り", fundamentals.dividendYield, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("1株配当", fundamentals.dividendPerShare, formatCurrency, { note: fundamentalPerShareNote }),
    metric("配当性向", fundamentals.payoutRatio, formatUnsignedPercent, { note: fundamentalPercentNote }),
    metric("1株売上高", fundamentals.revenuePerShare, formatCurrency, { note: fundamentalPerShareNote }),
    metric("1株簿価", fundamentals.bookValuePerShare, formatCurrency, { note: fundamentalPerShareNote }),
    metric("1株営業CF", fundamentals.operatingCashFlowPerShare, formatCurrency, { note: fundamentalPerShareNote }),
    metric("1株FCF", fundamentals.freeCashFlowPerShare, formatCurrency, { note: fundamentalPerShareNote }),
  ]) : [];

  const earningsRows = (workspace?.earnings ?? []).map((event) => ({
    reportDate: event.reportDate,
    fiscalDateEnding: event.fiscalDateEnding,
    metrics: present<StockDetailMetric>([
      metric("EPS実績", event.epsActual, formatCurrency),
      metric("EPS予想", event.epsEstimate, formatCurrency),
      metric("売上高実績", event.revenueActual, formatCompactCurrency),
      metric("売上高予想", event.revenueEstimate, formatCompactCurrency),
    ]),
  }));

  const analystMetrics = analyst ? present<StockDetailMetric>([
    metric("目標価格・平均", analyst.targetConsensus, formatCurrency),
    metric("目標価格・中央値", analyst.targetMedian, formatCurrency),
    metric("目標価格・下限", analyst.targetLow, formatCurrency),
    metric("目標価格・上限", analyst.targetHigh, formatCurrency),
    metric("アナリスト数", analyst.analystCount, (value) => `${value.toLocaleString("ja-JP")}名`),
    metric("強い買い", analyst.strongBuy, (value) => value.toLocaleString("ja-JP")),
    metric("買い", analyst.buy, (value) => value.toLocaleString("ja-JP")),
    metric("中立", analyst.hold, (value) => value.toLocaleString("ja-JP")),
    metric("売り", analyst.sell, (value) => value.toLocaleString("ja-JP")),
    metric("強い売り", analyst.strongSell, (value) => value.toLocaleString("ja-JP")),
    metric("予想EPS", analyst.forwardEps, formatCurrency),
    metric("予想売上高", analyst.forwardRevenue, formatCompactCurrency),
    analyst.targetConsensus !== undefined && quote?.price
      ? {
          label: "平均目標への乖離",
          value: formatPercent(analyst.targetConsensus / quote.price - 1),
          tone: analyst.targetConsensus >= quote.price ? "positive" : "negative",
        }
      : null,
  ]) : [];

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
      metrics: present(profileMetrics),
      source: sourceFrom([profile?.provenance, instrument?.provenance], selected?.profile ?? selected?.fundamentals ?? selected?.instrument),
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
      context: bars.length > 0 ? `${bars.length.toLocaleString("ja-JP")}本` : undefined,
    },
    warnings: workspace?.warnings ?? [],
  };
}
