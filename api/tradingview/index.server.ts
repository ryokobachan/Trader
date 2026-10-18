import {
  PROVIDER_SCHEMA_VERSION,
  type CompanyProfile,
  type DataProvenance,
  type FinancialStatementPeriod,
  type FundamentalFiscalForecast,
  type FundamentalsSnapshot,
  type Instrument,
  type ProviderAdapter,
  type ProviderEnvironment,
  type ProviderRegistration,
  type ProviderRequestContext,
} from "@/app/platform/provider-contracts";
import { companyLogoPathForUSStock } from "@/app/platform/company-logo";
import { createTradingViewFinancialHistoryClient } from "./financial-history.server";

const SCANNER_URL = "https://scanner.tradingview.com/america/scan";
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_HISTORY_PERIODS = 40;
const MAX_CACHE_ENTRIES = 200;
const MAX_IN_FLIGHT = 32;

// These are explicitly annual values. In particular, the unsuffixed scanner
// ratios often describe the latest quarter or TTM and must not replace them.
const ANNUAL_FIELDS = {
  revenue: "total_revenue_fy",
  grossProfit: "gross_profit_fy",
  operatingIncome: "oper_income_fy",
  ebitda: "ebitda_fy",
  netIncome: "net_income_fy",
  eps: "earnings_per_share_diluted_fy",
  totalAssets: "total_assets_fy",
  totalDebt: "total_debt_fy",
  netDebt: "net_debt_fy",
  shareholdersEquity: "total_equity_fy",
  cashAndShortTermInvestments: "cash_n_short_term_invest_fy",
  operatingCashFlow: "cash_f_operating_activities_fy",
  capitalExpenditure: "capital_expenditures_fy",
  freeCashFlow: "free_cash_flow_fy",
  assetTurnover: "asset_turnover_fy",
  currentRatio: "current_ratio_fy",
  quickRatio: "quick_ratio_fy",
  debtToEquity: "debt_to_equity_fy",
  dividendPerShare: "dps_common_stock_prim_issue_fy",
  revenuePerShare: "revenue_per_share_fy",
  bookValuePerShare: "book_value_per_share_fy",
  operatingCashFlowPerShare: "operating_cash_flow_per_share_fy",
  freeCashFlowPerShare: "free_cash_flow_per_share_fy",
  totalLiabilities: "total_liabilities_fy",
  researchAndDevelopment: "research_and_dev_fy",
  sellingGeneralAndAdministrative: "sell_gen_admin_exp_other_fy",
  investingCashFlow: "cash_f_investing_activities_fy",
  financingCashFlow: "cash_f_financing_activities_fy",
} as const;

const ANNUAL_PERCENT_FIELDS = {
  revenueGrowth: "total_revenue_yoy_growth_fy",
  epsGrowth: "earnings_per_share_diluted_yoy_growth_fy",
  roe: "return_on_equity_fy",
  roa: "return_on_assets_fy",
  roic: "return_on_invested_capital_fy",
  grossMargin: "gross_margin_fy",
  operatingMargin: "operating_margin_fy",
  ebitdaMargin: "ebitda_margin_fy",
  netMargin: "net_margin_fy",
  freeCashFlowMargin: "free_cash_flow_margin_fy",
  dividendYield: "dividends_yield_fy",
  payoutRatio: "dividend_payout_ratio_percent_fy",
} as const;

const VALUATION_FIELDS = {
  trailingPe: "price_earnings_ttm",
  forwardPe: "price_earnings_fwd",
  priceToBook: "price_book_ratio",
  priceToSales: "price_revenue_ttm",
  priceToFreeCashFlow: "price_free_cash_flow_ttm",
  pegRatio: "price_earnings_growth_ttm",
  enterpriseValue: "enterprise_value_current",
  enterpriseValueToRevenue: "enterprise_value_to_revenue_ttm",
  enterpriseValueToEbitda: "enterprise_value_ebitda_ttm",
} as const;

const HISTORY_FIELDS = {
  revenue: "total_revenue_fy_h",
  grossProfit: "gross_profit_fy_h",
  ebitda: "ebitda_fy_h",
  netIncome: "net_income_fy_h",
  eps: "earnings_per_share_diluted_fy_h",
  totalAssets: "total_assets_fy_h",
  totalDebt: "total_debt_fy_h",
  freeCashFlow: "free_cash_flow_fy_h",
} as const;

/** Fixed, metadata-verified columns; unknown fields fail visibly upstream. */
export const TRADINGVIEW_FUNDAMENTAL_COLUMNS = Object.freeze([
  "fundamental_currency_code", "currency", "sector", "industry", "country",
  "number_of_employees", "market_cap_basic", "beta_1_year", "ipo_offer_date",
  "fiscal_period_fy", "fiscal_period_end_fy",
  ...Object.values(ANNUAL_FIELDS), ...Object.values(ANNUAL_PERCENT_FIELDS),
  ...Object.values(VALUATION_FIELDS), "earnings_yield",
  "close", "earnings_per_share_diluted_ttm", "eps_estimate_ntm", "earnings_per_share_diluted_yoy_growth_ttm",
  "float_shares_outstanding", "total_shares_outstanding_fundamental",
  "altman_z_score_ttm", "piotroski_f_score_fy", "fiscal_period_fy_h",
  ...Object.values(HISTORY_FIELDS), "earnings_fq_h", "revenues_fq_h",
]);

export type TradingViewFundamentalsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type TradingViewFundamentalsOptions = Readonly<{
  fetch?: TradingViewFundamentalsFetch;
  now?: () => Date;
  timeoutMs?: number;
  cacheTtlMs?: number;
}>;

export class TradingViewFundamentalsError extends Error {
  constructor(
    readonly code: "network" | "timeout" | "upstream" | "invalid_response" | "aborted" | "capacity",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TradingViewFundamentalsError";
  }
}

const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "tradingview",
  version: "1.0.0",
  displayName: "Market data provider",
  capabilities: ["fundamentals.profile", "fundamentals.normalized", "fundamentals.earnings", "fundamentals.research"],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: [],
} as const;

type Row = Readonly<Record<string, unknown>>;
type ScanResult = Readonly<{ row: Row; observedAt: string }>;
type CacheEntry = Readonly<{ expiresAt: number; generation: number; value: ScanResult | null }>;

function createCacheState() {
  return {
    cache: new Map<string, CacheEntry>(),
    inFlight: new Map<string, Promise<ScanResult | null>>(),
    generation: 0,
  };
}

// Registry adapters are reconstructed for individual HTTP requests. Keep the
// production cache alive across those requests, while injectable tests stay isolated.
const productionCacheState = createCacheState();

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positive(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function fiscalYear(value: unknown): string | undefined {
  const year = typeof value === "number" ? String(value) : text(value);
  return year && /^(19|20|21)\d{2}$/.test(year) ? year : undefined;
}

function dateFromSeconds(value: unknown): string | undefined {
  const seconds = number(value);
  if (seconds === undefined || seconds < -2_208_988_800 || seconds > 4_133_980_800) return undefined;
  return new Date(seconds * 1_000).toISOString().slice(0, 10);
}

/** Resolve only a supported, already-identified US listing; never guess exchanges. */
function sourceSymbol(instrument: Instrument): string | null {
  if (
    instrument.listingCountry !== "US" || instrument.currency !== "USD" || !instrument.active
    || !["common_stock", "adr"].includes(instrument.assetType)
    || !/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)?$/.test(instrument.symbol)
    || instrument.symbol.length > 10
  ) return null;
  const exchanges: Readonly<Record<string, string>> = {
    XNAS: "NASDAQ", XNYS: "NYSE", XASE: "AMEX", ARCX: "AMEX", BATS: "CBOE",
  };
  const exchange = exchanges[instrument.exchangeMic];
  return exchange ? `${exchange}:${instrument.symbol.replaceAll("-", ".")}` : null;
}

function provenance(symbol: string, observedAt: string, dataset: string): DataProvenance {
  return {
    providerId: "tradingview",
    sourceId: `tradingview:scanner:${symbol}:${dataset}`,
    asOf: observedAt,
    ingestedAt: observedAt,
    sourceUrl: SCANNER_URL,
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new TradingViewFundamentalsError("invalid_response", "Market data provider returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new TradingViewFundamentalsError("invalid_response", "Market data provider response exceeds the size limit.");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  try { return JSON.parse(body); }
  catch { throw new TradingViewFundamentalsError("invalid_response", "Market data provider returned invalid JSON."); }
}

function withCallerSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new TradingViewFundamentalsError("aborted", "Market data provider request was cancelled."));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new TradingViewFundamentalsError("aborted", "Market data provider request was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function annualHistory(row: Row, symbol: string, observedAt: string): readonly FinancialStatementPeriod[] {
  const periods = row.fiscal_period_fy_h;
  if (!Array.isArray(periods) || periods.length > MAX_HISTORY_PERIODS) return [];
  const latestYear = fiscalYear(row.fiscal_period_fy);
  const seen = new Set<string>();
  return periods.flatMap((rawPeriod, index) => {
    const period = fiscalYear(rawPeriod);
    if (!period || seen.has(period) || (latestYear && period > latestYear)) return [];
    seen.add(period);
    const values: Record<string, number> = {};
    for (const [key, column] of Object.entries(HISTORY_FIELDS)) {
      const series = row[column];
      // A short array could have a different starting year. Do not shift it.
      if (!Array.isArray(series) || series.length !== periods.length) continue;
      const value = number(series[index]);
      if (value !== undefined) values[key] = value;
    }
    if (Object.keys(values).length === 0) return [];
    return [{
      period, currency: "USD" as const, ...values,
      ...(period === latestYear ? { fiscalDateEnding: dateFromSeconds(row.fiscal_period_end_fy) } : {}),
      provenance: provenance(symbol, observedAt, `financials:FY:${period}`),
    }];
  }).sort((a, b) => b.period.localeCompare(a.period));
}

function fiscalForecasts(row: Row, symbol: string, observedAt: string): readonly FundamentalFiscalForecast[] {
  const periods = new Map<string, FundamentalFiscalForecast>();
  const conflicts = new Set<string>();
  for (const [field, actualKey, estimateKey] of [
    ["earnings_fq_h", "epsActual", "epsEstimate"],
    ["revenues_fq_h", "revenueActual", "revenueEstimate"],
  ] as const) {
    const records = row[field];
    if (!Array.isArray(records) || records.length > MAX_HISTORY_PERIODS) continue;
    for (const item of records) {
      if (!record(item) || typeof item.IsReported !== "boolean") continue;
      const period = text(item.FiscalPeriod);
      if (!period || !/^(19|20|21)\d{2}-Q[1-4]$/.test(period) || conflicts.has(period)) continue;
      const previous = periods.get(period);
      // Conflicting reported flags are not safe to merge across EPS and revenue.
      if (previous && previous.reported !== item.IsReported) {
        periods.delete(period);
        conflicts.add(period);
        continue;
      }
      const actual = item.IsReported ? number(item.Actual) : undefined;
      const estimate = number(item.Estimate);
      if (actual === undefined && estimate === undefined) continue;
      periods.set(period, {
        ...previous, period, reported: item.IsReported,
        ...(actual === undefined ? {} : { [actualKey]: actual }),
        ...(estimate === undefined ? {} : { [estimateKey]: estimate }),
        provenance: provenance(symbol, observedAt, `fiscal-consensus:${period}:adjusted-eps`),
      });
    }
  }
  return [...periods.values()].sort((a, b) => b.period.localeCompare(a.period));
}

function profileFromScan(scan: ScanResult, instrument: Instrument, symbol: string): CompanyProfile | null {
  const { row, observedAt } = scan;
  if (row.currency !== "USD") return null;
  const employees = number(row.number_of_employees);
  return {
    instrumentId: instrument.instrumentId,
    sector: text(row.sector), industry: text(row.industry), country: text(row.country),
    employees: employees !== undefined && Number.isSafeInteger(employees) && employees >= 0 ? employees : undefined,
    beta: number(row.beta_1_year), marketCap: positive(row.market_cap_basic),
    ipoDate: dateFromSeconds(row.ipo_offer_date),
    logoUrl: companyLogoPathForUSStock(instrument.symbol),
    provenance: provenance(symbol, observedAt, "profile:beta-1y"),
  };
}

function fundamentalsFromScan(scan: ScanResult, instrument: Instrument, symbol: string): FundamentalsSnapshot | null {
  const { row, observedAt } = scan;
  // The canonical contract is USD. An ADR's quote currency is not sufficient
  // evidence of the financial statements' currency; do not relabel foreign money.
  if (row.currency !== "USD" || row.fundamental_currency_code !== "USD") return null;
  const values: Record<string, number> = {};
  for (const [key, column] of Object.entries({ ...ANNUAL_FIELDS, ...VALUATION_FIELDS })) {
    const value = number(row[column]);
    if (value !== undefined) values[key] = value;
  }
  for (const [key, column] of Object.entries(ANNUAL_PERCENT_FIELDS)) {
    const value = number(row[column]);
    if (value !== undefined) values[key] = value / 100;
  }
  const valuationSources: NonNullable<FundamentalsSnapshot["valuationSources"]> = Object.fromEntries(
    (["trailingPe", "forwardPe", "pegRatio"] as const).map((field) => {
      // Nonpositive earnings/growth do not produce a comparable valuation multiple.
      if (!(values[field] > 0)) delete values[field];
      return [field, { provenance: provenance(symbol, observedAt, `valuation:${field}`),
        basis: field === "trailingPe" ? "ttm" : field === "forwardPe" ? "forward" : "growth-adjusted",
        status: values[field] === undefined ? "not_reported" : "reported" }];
    }),
  );
  const close = positive(row.close);
  const epsTtm = positive(row.earnings_per_share_diluted_ttm);
  const epsNtm = positive(row.eps_estimate_ntm);
  const growthPercent = positive(row.earnings_per_share_diluted_yoy_growth_ttm);
  const calculated: Partial<Record<"trailingPe" | "forwardPe" | "pegRatio", NonNullable<FundamentalsSnapshot["valuationSources"]>["trailingPe"]>> = {};
  const derive = (field: "trailingPe" | "forwardPe" | "pegRatio", value: number, calculation: NonNullable<NonNullable<FundamentalsSnapshot["valuationSources"]>["trailingPe"]>["calculation"]) => {
    if (values[field] !== undefined || !Number.isFinite(value) || value <= 0) return;
    values[field] = value;
    calculated[field] = { ...valuationSources[field]!, status: "calculated", calculation,
      provenance: provenance(symbol, observedAt, `valuation:${field}:calculated`) };
  };
  if (close && epsTtm) derive("trailingPe", close / epsTtm, {
    formula: "close / dilutedEpsTtm", inputs: { close, dilutedEpsTtm: epsTtm }, earningsPeriod: "TTM",
  });
  if (close && epsNtm) derive("forwardPe", close / epsNtm, {
    formula: "close / epsEstimateNtm", inputs: { close, epsEstimateNtm: epsNtm }, earningsPeriod: "NTM",
  });
  // This is explicitly historical EPS growth, not a 3/5-year forward PEG.
  if (close && epsTtm && growthPercent) derive("pegRatio", close / epsTtm / growthPercent, {
    formula: "close / dilutedEpsTtm / dilutedEpsTtmGrowthPercent", earningsPeriod: "TTM", growthBasis: "diluted-eps-ttm-yoy",
    inputs: { close, dilutedEpsTtm: epsTtm, dilutedEpsTtmGrowthPercent: growthPercent },
  });
  const earningsYield = number(row.earnings_yield);
  if (earningsYield !== undefined) values.earningsYield = earningsYield / 100;
  const priceToFreeCashFlow = number(row.price_free_cash_flow_ttm);
  if (priceToFreeCashFlow !== undefined && priceToFreeCashFlow !== 0) {
    values.freeCashFlowYield = 1 / priceToFreeCashFlow;
  }
  const outstandingShares = positive(row.total_shares_outstanding_fundamental);
  const rawFloat = number(row.float_shares_outstanding);
  const floatShares = rawFloat !== undefined && rawFloat >= 0 ? rawFloat : undefined;
  const altmanZScore = number(row.altman_z_score_ttm);
  const rawPiotroski = number(row.piotroski_f_score_fy);
  const piotroskiScore = rawPiotroski !== undefined && Number.isInteger(rawPiotroski) && rawPiotroski >= 0 && rawPiotroski <= 9
    ? rawPiotroski : undefined;
  const annualFinancials = annualHistory(row, symbol, observedAt);
  const forecasts = fiscalForecasts(row, symbol, observedAt);
  if (!Object.keys(values).length && !annualFinancials.length && !forecasts.length
    && outstandingShares === undefined && floatShares === undefined && altmanZScore === undefined && piotroskiScore === undefined) return null;
  const year = fiscalYear(row.fiscal_period_fy);
  return {
    instrumentId: instrument.instrumentId, currency: "USD", reportingBasis: "annual",
    period: year, ...values,
    valuationSources: { ...valuationSources, ...calculated },
    ...(outstandingShares !== undefined || floatShares !== undefined ? { shareStructure: {
      outstandingShares, floatShares,
      freeFloatRatio: floatShares !== undefined && outstandingShares !== undefined && floatShares <= outstandingShares
        ? floatShares / outstandingShares : undefined,
      provenance: provenance(symbol, observedAt, "share-structure:current"),
    } } : {}),
    ...(altmanZScore !== undefined || piotroskiScore !== undefined ? { financialHealth: {
      altmanZScore, piotroskiScore,
      altmanZScorePeriod: altmanZScore === undefined ? undefined : "TTM",
      piotroskiScorePeriod: piotroskiScore === undefined ? undefined : (year ? `FY ${year}` : "FY"),
      provenance: provenance(symbol, observedAt, "financial-health:altman-ttm:piotroski-fy"),
    } } : {}),
    ...(annualFinancials.length ? { annualFinancials } : {}),
    ...(forecasts.length ? { fiscalForecasts: forecasts } : {}),
    provenance: provenance(symbol, observedAt, "fundamentals:annual:valuation-ttm-forward"),
  };
}

export function createTradingViewProvider(
  env: ProviderEnvironment = {},
  options: TradingViewFundamentalsOptions = {},
): ProviderAdapter {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  const historyClient = createTradingViewFinancialHistoryClient(env, options);
  const now = options.now ?? (() => new Date());
  const boundedOption = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
    value !== undefined && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
  const configuredTimeout = text(env.TRADER_TRADINGVIEW_FUNDAMENTALS_TIMEOUT_MS);
  const configuredCacheTtl = text(env.TRADER_TRADINGVIEW_FUNDAMENTALS_CACHE_TTL_SECONDS);
  const timeoutMs = boundedOption(options.timeoutMs ?? (configuredTimeout ? Number(configuredTimeout) : undefined), 12_000, 1, 30_000);
  const cacheTtlMs = boundedOption(options.cacheTtlMs ?? (configuredCacheTtl ? Number(configuredCacheTtl) * 1_000 : undefined), 15 * 60_000, 0, 3_600_000);
  const state = Object.keys(options).length ? createCacheState() : productionCacheState;
  const { cache, inFlight } = state;

  async function request(symbol: string): Promise<ScanResult | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TradingViewFundamentalsError("timeout", "Market data provider request timed out."));
      }, timeoutMs);
    });
    try {
      return await Promise.race([(async () => {
        const response = await fetchImplementation(SCANNER_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ symbols: { tickers: [symbol] }, columns: TRADINGVIEW_FUNDAMENTAL_COLUMNS, ignore_unknown_fields: false }),
          signal: controller.signal,
        });
        if (!response.ok) throw new TradingViewFundamentalsError("upstream", `Market data provider request failed with status ${response.status}.`, response.status);
        const payload = await readJson(response);
        if (!record(payload) || !Array.isArray(payload.data) || !Number.isSafeInteger(payload.totalCount)) {
          throw new TradingViewFundamentalsError("invalid_response", "Market data provider returned an invalid scanner response.");
        }
        if (payload.totalCount === 0 && payload.data.length === 0) return null;
        if (payload.totalCount !== 1 || payload.data.length !== 1) {
          throw new TradingViewFundamentalsError("invalid_response", "Market data provider returned an unexpected number of listings.");
        }
        const item = payload.data[0];
        if (!record(item) || item.s !== symbol || !Array.isArray(item.d) || item.d.length !== TRADINGVIEW_FUNDAMENTAL_COLUMNS.length) {
          throw new TradingViewFundamentalsError("invalid_response", "Market data provider returned a different listing or column schema.");
        }
        const data = item.d;
        return { row: Object.fromEntries(TRADINGVIEW_FUNDAMENTAL_COLUMNS.map((column, index) => [column, data[index]])), observedAt: now().toISOString() };
      })(), deadline]);
    } catch (error) {
      if (error instanceof TradingViewFundamentalsError) throw error;
      if (controller.signal.aborted) throw new TradingViewFundamentalsError("timeout", "Market data provider request timed out.");
      throw new TradingViewFundamentalsError("network", "Market data provider request failed.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function scan(instrument: Instrument, context: ProviderRequestContext): Promise<ScanResult | null> {
    if (context.signal?.aborted) throw new TradingViewFundamentalsError("aborted", "Market data provider request was cancelled.");
    const symbol = sourceSymbol(instrument);
    if (!symbol) return null;
    const cached = cache.get(symbol);
    if (!context.fresh && cached && cached.expiresAt > now().getTime()) return cached.value;
    const requestKey = `${symbol}:${context.fresh ? "fresh" : "normal"}`;
    let pending = inFlight.get(`${symbol}:fresh`) ?? inFlight.get(requestKey);
    if (!pending) {
      if (inFlight.size >= MAX_IN_FLIGHT) throw new TradingViewFundamentalsError("capacity", "Market data provider request capacity was reached.");
      const generation = ++state.generation;
      pending = request(symbol).then((value) => {
        if (generation >= (cache.get(symbol)?.generation ?? 0)) {
          cache.delete(symbol);
          while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
          cache.set(symbol, { value, generation, expiresAt: now().getTime() + (value ? cacheTtlMs : Math.min(cacheTtlMs, 60_000)) });
        }
        return value;
      }).finally(() => inFlight.delete(requestKey));
      inFlight.set(requestKey, pending);
    }
    return withCallerSignal(pending, context.signal);
  }

  return {
    manifest,
    fundamentals: {
      getProfile: async (instrument, context) => {
        const data = await scan(instrument, context);
        return data ? profileFromScan(data, instrument, sourceSymbol(instrument)!) : null;
      },
      getFundamentals: async (instrument, context) => {
        const [data, history] = await Promise.all([scan(instrument, context), historyClient.get(instrument, context).catch(() => undefined)]);
        const snapshot = data ? fundamentalsFromScan(data, instrument, sourceSymbol(instrument)!) : null;
        return snapshot && history ? { ...snapshot,
          ...(history.annual.length ? { annualFinancials: history.annual } : {}),
          ...(history.quarterly.length ? { quarterlyFinancials: history.quarterly } : {}),
        } : snapshot;
      },
      getEarnings: async (instrument, context) => (await historyClient.get(instrument, context))?.earnings ?? [],
      getResearch: async (instrument, context) => {
        const history = await historyClient.get(instrument, context);
        return history ? { instrumentId: instrument.instrumentId, quarterlyFinancials: history.quarterly, annualCashFlows: history.annual,
          corporateActions: [], coverage: { ownership: "unavailable", quarterlyFinancials: history.quarterly.length ? "available" : "unavailable", corporateActions: "unavailable" },
          provenance: history.provenance } : null;
      },
    },
  };
}

export const tradingViewProviderRegistration: ProviderRegistration = {
  manifest,
  create: createTradingViewProvider,
};
