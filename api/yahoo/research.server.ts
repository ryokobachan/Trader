import type {
  CompanyResearch, CorporateAction, DataProvenance, FinancialStatementPeriod,
  Instrument, OwnershipSnapshot, ProviderRequestContext,
} from "@/app/platform/provider-contracts";
import { US_EXCHANGES } from "./search";

const FIELDS = {
  quarterlyTotalRevenue: "revenue", quarterlyNetIncome: "netIncome", quarterlyDilutedEPS: "eps",
  quarterlyTotalAssets: "totalAssets", quarterlyTotalDebt: "totalDebt",
  quarterlyStockholdersEquity: "shareholdersEquity", quarterlyOperatingCashFlow: "operatingCashFlow",
  quarterlyCapitalExpenditure: "capitalExpenditure", quarterlyFreeCashFlow: "freeCashFlow",
  quarterlyInvestingCashFlow: "investingCashFlow", quarterlyFinancingCashFlow: "financingCashFlow",
  annualOperatingCashFlow: "operatingCashFlow", annualInvestingCashFlow: "investingCashFlow",
  annualFinancingCashFlow: "financingCashFlow", annualCapitalExpenditure: "capitalExpenditure", annualFreeCashFlow: "freeCashFlow",
} as const;
type FinancialField = (typeof FIELDS)[keyof typeof FIELDS];
type JsonRecord = Record<string, unknown>;
type SummaryItem = Readonly<{ payload: unknown; sourceUrl: string; ingestedAt: string }>;
type CacheState = {
  cache: Map<string, { expiresAt: number; result: CompanyResearch }>;
  inFlight: Map<string, Promise<CompanyResearch>>;
};
const sharedStates = new WeakMap<object, CacheState>();

export type YahooResearchClientOptions = Readonly<{
  fetchQuoteSummary: (symbol: string, fresh: boolean) => Promise<SummaryItem>;
  fetchJson: (url: URL) => Promise<unknown>;
  fetchOwnershipFallback?: (instrument: Instrument) => Promise<OwnershipSnapshot>;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => Date;
  /** Original transport identity preserves production caches across runtime creation. */
  cacheScope?: object;
}>;

export class YahooResearchError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_response" | "timeout" | "aborted" | "capacity") {
    super(`Yahoo Finance research ${code.replaceAll("_", " ")}.`);
    this.name = "YahooResearchError";
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
function numeric(value: unknown): number | undefined {
  const raw = record(value)?.raw ?? value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}
function nonNegative(value: unknown) {
  const number = numeric(value);
  return number !== undefined && number >= 0 ? number : undefined;
}
function symbol(value: unknown) {
  if (typeof value !== "string") return undefined;
  const result = value.normalize("NFKC").trim().toUpperCase().replaceAll(".", "-");
  return /^[A-Z][A-Z0-9-]{0,14}$/.test(result) ? result : undefined;
}
function sourceDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value ? value : undefined;
}
function unixDate(value: unknown) {
  const seconds = numeric(value);
  return seconds !== undefined && Number.isInteger(seconds) && seconds > 0 && seconds < 7_258_118_400
    ? new Date(seconds * 1_000).toISOString().slice(0, 10) : undefined;
}
function provenance(symbol: string, kind: string, sourceUrl: string, ingestedAt: string, asOf = ingestedAt): DataProvenance {
  return Object.freeze({ providerId: "yahoo", sourceId: `yahoo-research:${symbol}:${kind}`, sourceUrl, ingestedAt, asOf });
}
function invalid(): never { throw new YahooResearchError("invalid_response"); }

function ownership(item: SummaryItem, expectedSymbol: string): OwnershipSnapshot | undefined {
  const summary = record(record(item.payload)?.quoteSummary);
  if (!summary || summary.error || !Array.isArray(summary.result) || summary.result.length !== 1) invalid();
  const result = record(summary.result[0]);
  const price = record(result?.price);
  const stats = record(result?.defaultKeyStatistics);
  if (!price || symbol(price.symbol) !== expectedSymbol || price.currency !== "USD" || !stats) invalid();
  const fields = {
    insiderOwnership: nonNegative(stats.heldPercentInsiders),
    institutionalOwnership: nonNegative(stats.heldPercentInstitutions),
    sharesShort: nonNegative(stats.sharesShort),
    sharesShortPriorMonth: nonNegative(stats.sharesShortPriorMonth),
    shortFloatRatio: nonNegative(stats.shortPercentOfFloat),
    shortOutstandingRatio: nonNegative(stats.sharesPercentSharesOut),
    shortRatio: nonNegative(stats.shortRatio),
    shortInterestDate: unixDate(stats.dateShortInterest),
  };
  const present = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (!Object.keys(present).some((field) => field !== "shortInterestDate")) return undefined;
  return Object.freeze({
    ...present,
    // Yahoo supplies a separate short-interest date, not an ownership observation date.
    provenance: provenance(expectedSymbol, "ownership", item.sourceUrl, item.ingestedAt),
  });
}

function statementPeriods(payload: unknown, expectedSymbol: string, url: string, ingestedAt: string, basis: "quarterly" | "annual"): readonly FinancialStatementPeriod[] {
  const root = record(record(payload)?.timeseries);
  if (!root || root.error || !Array.isArray(root.result) || root.result.length > 30) invalid();
  const periods = new Map<string, Partial<Record<FinancialField, number>>>();
  for (const raw of root.result) {
    const series = record(raw);
    const meta = record(series?.meta);
    if (!series || !meta || !Array.isArray(meta.symbol) || meta.symbol.length !== 1
      || symbol(meta.symbol[0]) !== expectedSymbol || !Array.isArray(meta.type) || meta.type.length !== 1) invalid();
    const type = meta.type[0];
    if (typeof type !== "string" || !Object.hasOwn(FIELDS, type)) invalid();
    if (!type.startsWith(basis)) continue;
    const rows = series[type];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > 100) invalid();
    for (const rawRow of rows) {
      const row = record(rawRow);
      if (!row || row.currencyCode !== "USD" || row.periodType !== (basis === "annual" ? "12M" : "3M")) continue;
      const date = sourceDate(row.asOfDate);
      const value = numeric(row.reportedValue) ?? numeric(row.dataValue);
      if (!date || date > ingestedAt.slice(0, 10) || value === undefined) continue;
      const values = periods.get(date) ?? {};
      const field = FIELDS[type as keyof typeof FIELDS];
      if (values[field] !== undefined && values[field] !== value) invalid();
      values[field] = value;
      periods.set(date, values);
    }
  }
  return Object.freeze([...periods].sort(([a], [b]) => b.localeCompare(a)).slice(0, 24).map(([date, values]) => Object.freeze({
    // Calendar quarters are not necessarily fiscal quarters; retain the actual supplied date.
    period: date, fiscalDateEnding: date, currency: "USD" as const, ...values,
    provenance: provenance(expectedSymbol, `${basis}:${date}`, url, ingestedAt, date),
  })));
}

function corporateActions(payload: unknown, instrument: Instrument, url: string, ingestedAt: string, now: Date): readonly CorporateAction[] {
  const chart = record(record(payload)?.chart);
  if (!chart || chart.error || !Array.isArray(chart.result) || chart.result.length !== 1) invalid();
  const result = record(chart.result[0]);
  const meta = record(result?.meta);
  const expectedSymbol = symbol(instrument.symbol)!;
  const exchange = typeof meta?.exchangeName === "string"
    ? US_EXCHANGES[meta.exchangeName as keyof typeof US_EXCHANGES] : undefined;
  if (!meta || symbol(meta.symbol) !== expectedSymbol || meta.currency !== "USD"
    || meta.instrumentType !== "EQUITY" || exchange?.mic !== instrument.exchangeMic) invalid();
  const events = record(result?.events);
  if (result?.events !== undefined && !events) invalid();
  const actions: CorporateAction[] = [];
  const earliest = new Date(now);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - 5);
  const lowerDate = earliest.toISOString().slice(0, 10);
  const upperDate = now.toISOString().slice(0, 10);
  for (const [key, type] of [["dividends", "dividend"], ["splits", "split"]] as const) {
    const entries = record(events?.[key]);
    if (events?.[key] !== undefined && !entries) invalid();
    const rawEvents = Object.values(entries ?? {});
    if (rawEvents.length > 500) invalid();
    for (const raw of rawEvents) {
      const event = record(raw);
      const date = unixDate(event?.date);
      if (!event || !date || date < lowerDate || date > upperDate) continue;
      const amount = nonNegative(event.amount);
      const numerator = nonNegative(event.numerator);
      const denominator = nonNegative(event.denominator);
      if (type === "dividend" && amount === undefined) continue;
      if (type === "split" && (!numerator || !denominator)) continue;
      const id = `yahoo:${expectedSymbol}:${type}:${date}`;
      actions.push(Object.freeze({
        id, type, date,
        ...(type === "dividend" ? { amount, currency: "USD" as const } : { numerator, denominator }),
        provenance: provenance(expectedSymbol, `${type}:${date}`, url, ingestedAt, date),
      }));
    }
  }
  return Object.freeze(actions.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)));
}

async function timed<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new YahooResearchError("timeout")), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function withSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new YahooResearchError("aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createYahooResearchClient(options: YahooResearchClientOptions) {
  const now = options.now ?? (() => new Date());
  const timeoutMs = Math.max(1, Math.min(60_000, options.timeoutMs ?? 12_000));
  const cacheTtlMs = Math.max(1, Math.min(86_400_000, options.cacheTtlMs ?? 3_600_000));
  let state = options.cacheScope ? sharedStates.get(options.cacheScope) : undefined;
  if (!state) {
    state = { cache: new Map(), inFlight: new Map() };
    if (options.cacheScope) sharedStates.set(options.cacheScope, state);
  }
  const { cache, inFlight } = state;

  async function load(instrument: Instrument, fresh: boolean, includeFinancialStatements: boolean): Promise<CompanyResearch> {
    const expectedSymbol = symbol(instrument.symbol)!;
    const fetchedAt = now();
    const ingestedAt = fetchedAt.toISOString();
    const period2 = Math.trunc(fetchedAt.getTime() / 1_000) + 86_400;
    const seriesUrl = new URL(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(expectedSymbol)}`);
    seriesUrl.search = new URLSearchParams({ symbol: expectedSymbol, type: Object.keys(FIELDS).join(","), period1: String(period2 - 6 * 366 * 86_400), period2: String(period2) }).toString();
    const chartUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(expectedSymbol)}`);
    chartUrl.search = new URLSearchParams({ range: "5y", interval: "1d", events: "div,splits", includePrePost: "false" }).toString();
    const loadOwnership = async () => {
      try {
        const primary = await timed(options.fetchQuoteSummary(expectedSymbol, fresh).then((item) => ownership(item, expectedSymbol)), timeoutMs);
        if (primary || !options.fetchOwnershipFallback) return primary;
      } catch (error) {
        if (!options.fetchOwnershipFallback) throw error;
      }
      return timed(options.fetchOwnershipFallback(instrument), timeoutMs);
    };
    const [owner, financials, actions] = await Promise.allSettled([
      loadOwnership(),
      includeFinancialStatements ? timed(options.fetchJson(seriesUrl).then((payload) => ({
        quarterly: statementPeriods(payload, expectedSymbol, seriesUrl.toString(), ingestedAt, "quarterly"),
        annualCashFlows: statementPeriods(payload, expectedSymbol, seriesUrl.toString(), ingestedAt, "annual"),
      })), timeoutMs) : Promise.resolve(undefined),
      timed(options.fetchJson(chartUrl).then((payload) => corporateActions(payload, instrument, chartUrl.toString(), ingestedAt, fetchedAt)), timeoutMs),
    ]);
    return Object.freeze({
      instrumentId: instrument.instrumentId,
      ...(owner.status === "fulfilled" && owner.value ? { ownership: owner.value } : {}),
      ...(financials.status === "fulfilled" && financials.value ? { quarterlyFinancials: financials.value.quarterly, annualCashFlows: financials.value.annualCashFlows } : {}),
      corporateActions: actions.status === "fulfilled" ? actions.value : Object.freeze([]),
      coverage: Object.freeze({
        ownership: owner.status === "fulfilled" ? "available" : "unavailable",
        quarterlyFinancials: financials.status === "fulfilled" && financials.value ? "available" : "unavailable",
        corporateActions: actions.status === "fulfilled" ? "available" : "unavailable",
      }),
      provenance: provenance(expectedSymbol, "company", `https://finance.yahoo.com/quote/${encodeURIComponent(expectedSymbol)}/`, ingestedAt),
    });
  }

  return Object.freeze({ getResearch: async (instrument: Instrument, context: ProviderRequestContext, request: Readonly<{ financialStatements?: boolean }> = {}): Promise<CompanyResearch> => {
    if (context.signal?.aborted) throw new YahooResearchError("aborted");
    if (!symbol(instrument.symbol) || instrument.currency !== "USD" || instrument.listingCountry !== "US"
      || !Object.values(US_EXCHANGES).some((exchange) => exchange.mic === instrument.exchangeMic)) throw new YahooResearchError("invalid_request");
    const current = now().getTime();
    if (!Number.isFinite(current)) throw new YahooResearchError("invalid_request");
    const includeFinancialStatements = request.financialStatements !== false;
    const key = `${timeoutMs}:${cacheTtlMs}:${includeFinancialStatements}:${instrument.instrumentId}:${instrument.exchangeMic}:${symbol(instrument.symbol)}`;
    const saved = cache.get(key);
    if (!context.fresh && saved && saved.expiresAt > current) return saved.result;
    let work = inFlight.get(key);
    if (!work) {
      if (inFlight.size >= 32) throw new YahooResearchError("capacity");
      work = load(instrument, context.fresh === true, includeFinancialStatements).then((result) => {
        for (const [entryKey, value] of cache) if (value.expiresAt <= current) cache.delete(entryKey);
        cache.delete(key);
        if (cache.size >= 200) cache.delete(cache.keys().next().value!);
        // Failed sources should be retried soon instead of freezing an outage for an hour.
        const ttl = Object.values(result.coverage).includes("unavailable") ? Math.min(cacheTtlMs, 30_000) : cacheTtlMs;
        cache.set(key, { result, expiresAt: now().getTime() + ttl });
        return result;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, work);
    }
    return withSignal(work, context.signal);
  } });
}
