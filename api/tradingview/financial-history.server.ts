import type { DataProvenance, EarningsEvent, FinancialStatementPeriod, Instrument, ProviderEnvironment, ProviderRequestContext } from "@/app/platform/provider-contracts";

const SOURCE_URL = "https://www.tradingview.com/";
const FIELDS = {
  revenue: "total_revenue", grossProfit: "gross_profit", operatingIncome: "oper_income", ebitda: "ebitda",
  netIncome: "net_income", eps: "earnings_per_share_diluted", researchAndDevelopment: "research_and_dev",
  sellingGeneralAndAdministrative: "sell_gen_admin_exp_other", totalAssets: "total_assets",
  totalLiabilities: "total_liabilities", totalDebt: "total_debt", netDebt: "net_debt", shareholdersEquity: "total_equity",
  cashAndShortTermInvestments: "cash_n_short_term_invest", operatingCashFlow: "cash_f_operating_activities",
  capitalExpenditure: "capital_expenditures", freeCashFlow: "free_cash_flow",
  investingCashFlow: "cash_f_investing_activities", financingCashFlow: "cash_f_financing_activities",
} as const;
type Row = Record<string, unknown>;
export type TradingViewFinancialHistory = Readonly<{
  annual: readonly FinancialStatementPeriod[];
  quarterly: readonly FinancialStatementPeriod[];
  earnings: readonly EarningsEvent[];
  provenance: DataProvenance;
}>;
type Options = { fetch?: typeof globalThis.fetch; now?: () => Date; timeoutMs?: number; cacheTtlMs?: number };
const record = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const date = (value: unknown) => finite(value) && value > 0 && value < 4_133_980_800 ? new Date(value * 1_000).toISOString().slice(0, 10) : undefined;

function source(sourceSymbol: string, observedAt: string, dataset: string): DataProvenance {
  return { providerId: "tradingview", sourceId: `tradingview:financial-websocket:${sourceSymbol}:${dataset}`,
    sourceUrl: `${SOURCE_URL}symbols/${sourceSymbol.replace(":", "-")}/financials-overview/`, asOf: observedAt, ingestedAt: observedAt };
}

export function parseTradingViewFinancialHistory(payload: unknown, sourceSymbol: string, now: Date): TradingViewFinancialHistory {
  if (!record(payload) || payload.schemaVersion !== "trader.tradingview-financials.v1" || payload.sourceSymbol !== sourceSymbol
    || typeof payload.observedAt !== "string" || !Number.isFinite(Date.parse(payload.observedAt))
    || Date.parse(payload.observedAt) > now.getTime() + 60_000 || now.getTime() - Date.parse(payload.observedAt) > 300_000
    || !record(payload.values) || payload.values.currency_code !== "USD" || payload.values.fundamental_currency_code !== "USD") throw new Error("Invalid TradingView financial history.");
  const row = payload.values;
  const observedAt = payload.observedAt;
  const array = (key: string) => Array.isArray(row[key]) && row[key].length <= 40 ? row[key] as unknown[] : undefined;
  function statements(basis: "fy" | "fq"): readonly FinancialStatementPeriod[] {
    const periods = array(`fiscal_period_${basis}_h`);
    if (!periods) return [];
    const dates = array(`fiscal_period_end_${basis}_h`);
    const seen = new Set<string>();
    return periods.flatMap((raw, index) => {
      const period = String(raw);
      if (!(basis === "fy" ? /^(19|20|21)\d{2}$/ : /^(19|20|21)\d{2}-Q[1-4]$/).test(period) || seen.has(period)) return [];
      const periodEnd = dates?.length === periods.length ? date(dates[index]) : undefined;
      if (periodEnd && periodEnd > observedAt.slice(0, 10)) return [];
      seen.add(period);
      const values: Record<string, number> = {};
      for (const [metric, field] of Object.entries(FIELDS)) {
        const series = array(`${field}_${basis}_h`);
        if (series?.length === periods.length && finite(series[index])) values[metric] = series[index];
      }
      if (!Object.keys(values).length) return [];
      return [{ period, currency: "USD" as const, ...values,
        fiscalDateEnding: periodEnd,
        provenance: source(sourceSymbol, observedAt, `${basis}:${period}`) }];
    }).sort((a, b) => b.period.localeCompare(a.period));
  }
  const annual = statements("fy");
  const quarterly = statements("fq");
  const periods = array("earnings_fiscal_period_fq_h");
  const reportDates = array("earnings_release_date_fq_h");
  const seenEarnings = new Set<string>();
  const earnings = !periods || !reportDates || periods.length !== reportDates.length ? [] : periods.flatMap((raw, index) => {
    const period = typeof raw === "string" ? raw : "";
    const reportDate = date(reportDates[index]);
    if (!/^(19|20|21)\d{2}-Q[1-4]$/.test(period) || !reportDate || reportDate > observedAt.slice(0, 10) || seenEarnings.has(period)) return [];
    seenEarnings.add(period);
    const values: Record<string, number> = {};
    for (const [key, field] of Object.entries({ epsActual: "earnings_per_share_fq_h", epsEstimate: "earnings_per_share_forecast_fq_h", revenueActual: "revenue_fq_h", revenueEstimate: "revenue_forecast_fq_h" })) {
      const series = array(field);
      if (series?.length === periods.length && finite(series[index])) values[key] = series[index];
    }
    if (!Object.keys(values).length) return [];
    const statement = quarterly.find(item => item.period === period);
    if (statement?.fiscalDateEnding && statement.fiscalDateEnding > reportDate) return [];
    return [{ reportDate, fiscalPeriod: period, fiscalDateEnding: statement?.fiscalDateEnding,
      epsBasis: "earnings_display" as const, statementEPS: statement?.eps, ...values,
      provenance: source(sourceSymbol, observedAt, `earnings:${period}:adjusted-eps`) }];
  }).sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  return { annual, quarterly, earnings, provenance: source(sourceSymbol, observedAt, "financial-history") };
}

type Entry = { expiresAt: number; generation: number; data: TradingViewFinancialHistory };
const state = () => ({ cache: new Map<string, Entry>(), inFlight: new Map<string, Promise<TradingViewFinancialHistory | undefined>>(), generation: 0 });
const productionState = state();

export function createTradingViewFinancialHistoryClient(env: ProviderEnvironment, options: Options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  const storage = Object.keys(options).length ? state() : productionState;
  const ttl = Math.max(0, Math.min(3_600_000, options.cacheTtlMs ?? 15 * 60_000));
  const timeout = Math.max(1, Math.min(20_000, options.timeoutMs ?? 15_000));
  return { get: async (instrument: Instrument, context: ProviderRequestContext): Promise<TradingViewFinancialHistory | undefined> => {
    if (context.signal?.aborted) throw new Error("TradingView financial request cancelled.");
    const base = env.TRADER_TRADINGVIEW_SIDECAR_URL?.trim();
    const token = env.TRADER_TRADINGVIEW_SIDECAR_TOKEN?.trim();
    if (!base || !token) return undefined;
    const exchanges: Record<string, string> = { XNAS: "NASDAQ", XNYS: "NYSE", XASE: "AMEX", ARCX: "AMEX", BATS: "CBOE" };
    if (!exchanges[instrument.exchangeMic] || instrument.listingCountry !== "US" || instrument.currency !== "USD" || !instrument.active
      || !["common_stock", "adr"].includes(instrument.assetType) || !/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)?$/.test(instrument.symbol) || instrument.symbol.length > 10) return undefined;
    const url = new URL("/v1/tradingview/financials", base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid TradingView sidecar configuration.");
    url.search = new URLSearchParams({ symbol: instrument.symbol, mic: instrument.exchangeMic }).toString();
    const key = url.href;
    const cached = storage.cache.get(key);
    if (!context.fresh && cached && cached.expiresAt > now().getTime()) return cached.data;
    const requestKey = `${key}:${context.fresh ? "fresh" : "normal"}`;
    let work = storage.inFlight.get(`${key}:fresh`) ?? storage.inFlight.get(requestKey);
    if (!work) {
      if (storage.inFlight.size >= 32) throw new Error("TradingView financial capacity reached.");
      const generation = ++storage.generation;
      work = (async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error("TradingView financial history timed out."));
        }, timeout); });
        try {
          return await Promise.race([(async () => {
          const response = await fetcher(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: controller.signal, redirect: "manual" });
          if (!response.ok || !response.body) throw new Error("TradingView financial history unavailable.");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let body = "", bytes = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > 2_000_000) throw new Error("TradingView financial history exceeds limit.");
              body += decoder.decode(chunk.value, { stream: true });
            }
          } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
          finally { reader.releaseLock(); }
          const sourceSymbol = `${exchanges[instrument.exchangeMic]}:${instrument.symbol.replaceAll("-", ".")}`;
          const data = parseTradingViewFinancialHistory(JSON.parse(body + decoder.decode()), sourceSymbol, now());
          if (controller.signal.aborted) throw new Error("TradingView financial history timed out.");
          if (generation >= (storage.cache.get(key)?.generation ?? 0)) {
            storage.cache.delete(key);
            while (storage.cache.size >= 200) storage.cache.delete(storage.cache.keys().next().value!);
            storage.cache.set(key, { data, generation, expiresAt: now().getTime() + ttl });
          }
          return data;
          })(), deadline]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      })().finally(() => storage.inFlight.delete(requestKey));
      storage.inFlight.set(requestKey, work);
    }
    if (!context.signal) return work;
    const signal = context.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error("TradingView financial request cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
      work!.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  } };
}
