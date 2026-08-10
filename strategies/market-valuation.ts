import type { MarketBar, Quote } from "@/app/platform/provider-contracts";
import type { SamplePortfolioHolding } from "./sample-portfolio";

export type StrategyMarketMark = Readonly<{
  price: number;
  changePercent: number | null;
  asOf: string;
  source: "regular_quote" | "completed_daily_close";
}>;

export type StrategyMarketMarkOptions = Readonly<{
  observedAt?: Date;
}>;

export type MarkedSamplePortfolioHolding = Readonly<
  Omit<SamplePortfolioHolding, "value" | "allocation" | "daily" | "unrealized"> & {
    currentPrice: number | null;
    value: number | null;
    allocation: number | null;
    daily: number | null;
    unrealized: number | null;
  }
>;

export type MarkedSamplePortfolio = Readonly<{
  holdings: readonly MarkedSamplePortfolioHolding[];
  holdingsValue: number | null;
  unrealizedGain: number | null;
  complete: boolean;
}>;

function validPositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function newYorkTradingDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function dailyBarTradingDate(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;

  // Daily-data providers commonly encode a session date either as YYYY-MM-DD
  // or as midnight UTC. Converting those values to New York time would shift
  // them to the previous calendar day and could make an in-progress pre-market
  // candle look completed. Preserve the provider's explicit session date.
  if (/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(value)) {
    return value.slice(0, 10);
  }
  return newYorkTradingDate(new Date(timestamp));
}

function conservativeSessionAt(value: Date): Quote["marketState"] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (fields.weekday === "Sat" || fields.weekday === "Sun") return "closed";
  const minutes = Number(fields.hour) * 60 + Number(fields.minute);
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre_market";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "after_hours";
  return "closed";
}

function completedDailyBars(
  bars: readonly MarketBar[],
  excludedTradingDate?: string,
): readonly MarketBar[] {
  return bars
    .filter((bar) => {
      const tradingDate = dailyBarTradingDate(bar.time);
      return validPositive(bar.close)
        && tradingDate !== null
        && tradingDate !== excludedTradingDate;
    })
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

/**
 * Select the price used to mark a strategy holding.
 *
 * A direct USD quote is valid only while the regular U.S. session is open.
 * Pre-market excludes the current New York trading date because some providers
 * expose an in-progress daily candle before the open. After-hours and closed
 * sessions use the newest completed daily bar. `Quote.previousClose` is never
 * used because its session meaning differs across providers.
 */
export function strategyMarketMark(
  quote: Quote | null,
  dailyBars: readonly MarketBar[],
  options: StrategyMarketMarkOptions = {},
): StrategyMarketMark | null {
  if (quote?.marketState === "regular" && validPositive(quote.price)) {
    return Object.freeze({
      price: quote.price,
      changePercent: Number.isFinite(quote.changePercent) ? quote.changePercent : null,
      asOf: quote.provenance.asOf,
      source: "regular_quote",
    });
  }

  const observedAt = options.observedAt ?? new Date();
  const session = quote?.marketState ?? conservativeSessionAt(observedAt);
  const currentTradingDate = newYorkTradingDate(observedAt);
  const excludeCurrentTradingDate = session === "pre_market" || session === "regular";
  const completed = completedDailyBars(
    dailyBars,
    excludeCurrentTradingDate ? currentTradingDate : undefined,
  );
  const latest = completed.at(-1);
  if (!latest) return null;
  const previous = completed.at(-2);
  const changePercent = previous && validPositive(previous.close)
    ? (latest.close / previous.close - 1) * 100
    : null;
  return Object.freeze({
    price: latest.close,
    changePercent,
    asOf: latest.time,
    source: "completed_daily_close",
  });
}

/** Revalue sample lots without changing their quantities or acquisition cost. */
export function markSamplePortfolio(
  holdings: readonly SamplePortfolioHolding[],
  marksBySymbol: Readonly<Record<string, StrategyMarketMark>>,
  cashPercent: number,
): MarkedSamplePortfolio {
  const investedPercent = Math.max(0, Math.min(100, 100 - cashPercent));
  const values = holdings.map((holding) => {
    const mark = marksBySymbol[holding.ticker];
    return mark ? holding.shares * mark.price : null;
  });
  const complete = values.every((value): value is number => value !== null);
  const holdingsValue = complete
    ? values.reduce((sum, value) => sum + value, 0)
    : null;

  const marked = holdings.map((holding, index): MarkedSamplePortfolioHolding => {
    const mark = marksBySymbol[holding.ticker];
    const value = values[index] ?? null;
    const allocation = value !== null && holdingsValue !== null && holdingsValue > 0
      ? value / holdingsValue * investedPercent
      : null;
    return Object.freeze({
      ticker: holding.ticker,
      shares: holding.shares,
      average: holding.average,
      beta: holding.beta,
      rsi: holding.rsi,
      performance1M: holding.performance1M,
      technicalRating: holding.technicalRating,
      currentPrice: mark?.price ?? null,
      value,
      allocation,
      daily: mark?.changePercent ?? null,
      unrealized: value === null ? null : value - holding.shares * holding.average,
    });
  });
  const unrealizedGain = complete
    ? marked.reduce((sum, holding) => sum + (holding.unrealized ?? 0), 0)
    : null;

  return Object.freeze({
    holdings: Object.freeze(marked),
    holdingsValue,
    unrealizedGain,
    complete,
  });
}
