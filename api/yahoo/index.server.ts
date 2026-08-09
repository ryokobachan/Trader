import {
  PROVIDER_SCHEMA_VERSION,
  type CompanyNewsItem,
  type CompanyProfile,
  type DataProvenance,
  type FundamentalsSnapshot,
  type Instrument,
  type MarketBar,
  type MarketBarInterval,
  type MarketBarRange,
  type MarketBars,
  type MarketSessionState,
  type ProviderEnvironment,
  type ProviderRegistration,
  type Quote,
} from "@/app/platform/provider-contracts";
import { aggregateMarketBars } from "@/app/platform/market-bar-aggregation";
import { companyLogoPathForUSStock } from "@/app/platform/company-logo";
import { YAHOO_CHART_URL } from "./chart";
import { createYahooEarningsHistoryClient } from "./earnings.server";
import {
  YAHOO_FUNDAMENTAL_TYPE_BATCHES,
  YAHOO_TIMESERIES_URL,
} from "./fundamentals";
import {
  YAHOO_COOKIE_URL,
  YAHOO_CRUMB_URL,
  YAHOO_QUOTE_SUMMARY_MODULES,
  YAHOO_QUOTE_SUMMARY_URL,
} from "./fundamentals/profile";
import { POPULAR_US_SYMBOLS, US_EXCHANGES, YAHOO_SEARCH_URL } from "./search";

const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_SEARCH_RESULTS = 50;
const POPULAR_SEARCH_CACHE_TTL_MS = 30_000;
const CRUMB_CACHE_TTL_MS = 30 * 60_000;
const QUOTE_SUMMARY_CACHE_TTL_MS = 30_000;
const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: "yahoo",
  version: "1.0.0",
  displayName: "Yahoo Finance compatibility provider (personal use only)",
  capabilities: [
    "instrument.search",
    "instrument.identity",
    "market.quote",
    "market.bars",
    "fundamentals.profile",
    "fundamentals.normalized",
    "fundamentals.earnings",
    "news.company",
  ],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: ["UNICORN_USAGE_MODE", "UNICORN_ENABLE_YAHOO_COMPAT"],
} as const;

export type YahooProviderErrorCode =
  | "usage_not_permitted"
  | "request_timeout"
  | "upstream_error"
  | "invalid_response";

export class YahooProviderError extends Error {
  readonly code: YahooProviderErrorCode;
  readonly status?: number;

  constructor(code: YahooProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = "YahooProviderError";
    this.code = code;
    this.status = status;
  }
}

type JsonRecord = Record<string, unknown>;
type FetchImplementation = typeof globalThis.fetch;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteArrayValue(value: unknown, index: number): number | null {
  return Array.isArray(value) ? finiteNumber(value[index]) : null;
}

function unixSeconds(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? Math.trunc(parsed) : null;
}

function isoFromUnix(value: unknown): string | null {
  const seconds = unixSeconds(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizedSymbol(value: string): string | null {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/[./]/g, "-");
  return /^[A-Z][A-Z0-9-]{0,14}$/.test(normalized) ? normalized : null;
}

function normalizedYahooSearchQuery(value: string): string {
  const trimmed = value.normalize("NFKC").trim().slice(0, 100);
  // Yahoo Search interprets class shares such as BRK.B as option symbols. Its
  // canonical equity identifier is BRK-B. Do not uppercase every word-like
  // query here: company-name searches such as Apple and Palantir must remain
  // names rather than being treated as ticker symbols.
  if (/^[A-Za-z][A-Za-z0-9]{0,9}[./][A-Za-z0-9]{1,4}$/.test(trimmed)) {
    return normalizedSymbol(trimmed) ?? trimmed;
  }
  return trimmed;
}

function exchangeDetails(value: unknown) {
  const key = text(value).toUpperCase() as keyof typeof US_EXCHANGES;
  return US_EXCHANGES[key] ?? null;
}

function sourceTimestamp(record: JsonRecord, fallback: string): string {
  return isoFromUnix(record.regularMarketTime) ?? fallback;
}

function instrumentFromSearchQuote(
  value: unknown,
  sourceUrl: string,
  ingestedAt: string,
): Instrument | null {
  const quote = asRecord(value);
  if (!quote || text(quote.quoteType).toUpperCase() !== "EQUITY") return null;

  // Yahoo labels ETFs, mutual funds and indices with distinct quoteType values.
  // Requiring EQUITY and a known US primary exchange makes this adapter fail
  // closed when the upstream response cannot prove that an item is in scope.
  const exchange = exchangeDetails(quote.exchange);
  const symbol = normalizedSymbol(text(quote.symbol));
  const currency = text(quote.currency).toUpperCase();
  const region = text(quote.region).toUpperCase();
  const market = text(quote.market).toLowerCase();
  if (
    !exchange
    || !symbol
    || quote.isYahooFinance === false
    || (currency && currency !== "USD")
    || (region && region !== "US")
    || (market && market !== "us_market")
  ) {
    return null;
  }

  const name = text(quote.longname) || text(quote.shortname);
  if (!name) return null;
  const assetType = /\b(?:ADR|ADS|American Depositary)\b/i.test(name)
    ? "adr"
    : "common_stock";
  const asOf = sourceTimestamp(quote, ingestedAt);
  const sector = text(quote.sectorDisp) || text(quote.sector);
  const industry = text(quote.industryDisp) || text(quote.industry);
  const logoPath = companyLogoPathForUSStock(symbol);

  return Object.freeze({
    instrumentId: `us:${exchange.mic}:${symbol}`,
    symbol,
    name,
    assetType,
    active: true,
    listingCountry: "US",
    exchange: text(quote.exchDisp) || text(quote.exchangeDisp) || exchange.name,
    exchangeMic: exchange.mic,
    currency: "USD",
    ...(sector ? { sector } : {}),
    ...(industry ? { industry } : {}),
    ...(logoPath ? { logoPath } : {}),
    provenance: Object.freeze({
      providerId: manifest.id,
      sourceId: `yahoo-search:${symbol}`,
      asOf,
      ingestedAt,
      sourceUrl,
    }),
  });
}

function rankSearchResults(
  instruments: readonly Instrument[],
  rawQuery: string,
): readonly Instrument[] {
  const query = rawQuery.normalize("NFKC").trim();
  const queryLower = query.toLocaleLowerCase("en-US");
  const exactSymbol = normalizedSymbol(query);

  function score(instrument: Instrument): number {
    const symbol = instrument.symbol.toUpperCase();
    const name = instrument.name.toLocaleLowerCase("en-US");
    if (exactSymbol && symbol === exactSymbol) return 0;
    if (name === queryLower) return 1;
    if (name.startsWith(queryLower)) return 2;
    if (exactSymbol && symbol.startsWith(exactSymbol)) return 3;
    if (name.includes(queryLower)) return 4;
    return 5;
  }

  return Object.freeze(instruments
    .map((instrument, index) => ({ instrument, index, score: score(instrument) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ instrument }) => instrument));
}

function timeoutMilliseconds(env: ProviderEnvironment): number {
  const configured = Number(env.UNICORN_YAHOO_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.min(15_000, Math.max(10, Math.trunc(configured)));
}

async function fetchResponse(
  fetchImplementation: FetchImplementation,
  url: URL,
  timeoutMs: number,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImplementation(url, {
      headers: {
        accept: "application/json",
        "user-agent": "Unicorn/0.1 (Yahoo compatibility provider; personal use only)",
        ...headers,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof YahooProviderError) throw error;
    if (controller.signal.aborted) {
      throw new YahooProviderError(
        "request_timeout",
        "Yahoo Finance request timed out.",
      );
    }
    throw new YahooProviderError(
      "upstream_error",
      "Yahoo Finance request failed.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(
  fetchImplementation: FetchImplementation,
  url: URL,
  timeoutMs: number,
  headers: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  const response = await fetchResponse(fetchImplementation, url, timeoutMs, headers);
  if (!response.ok) {
    throw new YahooProviderError(
      "upstream_error",
      "Yahoo Finance returned an unsuccessful response.",
      response.status,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new YahooProviderError(
      "invalid_response",
      "Yahoo Finance returned an invalid JSON response.",
    );
  }
}

function searchUrl(query: string, limit: number): URL {
  const url = new URL(YAHOO_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("quotesCount", String(limit));
  url.searchParams.set("newsCount", "0");
  url.searchParams.set("listsCount", "0");
  url.searchParams.set("enableFuzzyQuery", "false");
  return url;
}

function newsSearchUrl(symbol: string, limit: number): URL {
  const url = new URL(YAHOO_SEARCH_URL);
  url.searchParams.set("q", symbol);
  url.searchParams.set("quotesCount", "0");
  url.searchParams.set("newsCount", String(limit));
  url.searchParams.set("listsCount", "0");
  url.searchParams.set("enableFuzzyQuery", "false");
  return url;
}

function safeHttpUrl(value: unknown): string | null {
  try {
    const url = new URL(text(value));
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username
      || url.password
      || !url.hostname
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function newsImageUrl(value: unknown): string | undefined {
  const thumbnail = asRecord(value);
  const resolutions = asArray(thumbnail?.resolutions);
  const ordered = [
    ...resolutions.filter((resolution) => text(asRecord(resolution)?.tag) === "original"),
    ...resolutions.filter((resolution) => text(asRecord(resolution)?.tag) !== "original"),
  ];
  for (const resolution of ordered) {
    const url = safeHttpUrl(asRecord(resolution)?.url);
    if (url) return url;
  }
  return undefined;
}

function companyNewsFromSearch(
  instrument: Instrument,
  payload: unknown,
  sourceUrl: string,
  ingestedAt: string,
  limit: number,
): readonly CompanyNewsItem[] {
  const root = asRecord(payload);
  const instrumentSymbol = normalizedSymbol(instrument.symbol);
  if (!instrumentSymbol) return [];

  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const items: CompanyNewsItem[] = [];
  for (const value of asArray(root?.news)) {
    const news = asRecord(value);
    if (!news) continue;
    const relatedTickers = new Set(asArray(news.relatedTickers)
      .map((ticker) => normalizedSymbol(text(ticker)))
      .filter((ticker): ticker is string => ticker !== null));
    if (!relatedTickers.has(instrumentSymbol)) continue;

    const title = text(news.title);
    const publisher = text(news.publisher);
    const url = safeHttpUrl(news.link);
    const publishedAt = isoFromUnix(news.providerPublishTime);
    const upstreamId = text(news.uuid);
    const id = upstreamId || url;
    if (
      !title
      || !publisher
      || !url
      || !publishedAt
      || !id
      || seenIds.has(id)
      || seenUrls.has(url)
    ) {
      continue;
    }
    seenIds.add(id);
    seenUrls.add(url);
    const imageUrl = newsImageUrl(news.thumbnail);
    items.push(Object.freeze({
      id: `yahoo:${id}`,
      instrumentId: instrument.instrumentId,
      title,
      url,
      publisher,
      publishedAt,
      ...(imageUrl ? { imageUrl } : {}),
      provenance: Object.freeze({
        providerId: manifest.id,
        sourceId: `yahoo-news:${id}`,
        asOf: publishedAt,
        ingestedAt,
        sourceUrl,
      }),
    }));
  }
  return Object.freeze(items
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .slice(0, limit));
}

function fundamentalsTimeseriesUrl(
  symbol: string,
  types: readonly string[],
  period1: number,
  period2: number,
): URL {
  const url = new URL(`${YAHOO_TIMESERIES_URL}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("type", types.join(","));
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));
  return url;
}

function quoteSummaryUrl(symbol: string, crumb?: string): URL {
  const url = new URL(`${YAHOO_QUOTE_SUMMARY_URL}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("modules", YAHOO_QUOTE_SUMMARY_MODULES.join(","));
  if (crumb) url.searchParams.set("crumb", crumb);
  return url;
}

function rawNumber(value: unknown): number | null {
  return finiteNumber(value) ?? finiteNumber(asRecord(value)?.raw);
}

type FundamentalPoint = Readonly<{
  asOfDate: string;
  value: number;
}>;

function fundamentalSeries(
  payloads: readonly unknown[],
  expectedSymbol: string,
): ReadonlyMap<string, readonly FundamentalPoint[]> {
  const byType = new Map<string, FundamentalPoint[]>();
  for (const payload of payloads) {
    const root = asRecord(payload);
    const timeseries = asRecord(root?.timeseries);
    for (const value of asArray(timeseries?.result)) {
      const result = asRecord(value);
      const meta = asRecord(result?.meta);
      const symbols = asArray(meta?.symbol).map((symbol) => normalizedSymbol(text(symbol)));
      const type = text(asArray(meta?.type)[0]);
      if (!result || !type || !symbols.includes(expectedSymbol)) continue;
      const pointsByDate = new Map(
        (byType.get(type) ?? []).map((point) => [point.asOfDate, point]),
      );
      for (const rowValue of asArray(result[type])) {
        const row = asRecord(rowValue);
        const asOfDate = text(row?.asOfDate);
        const currency = text(row?.currencyCode).toUpperCase();
        const pointValue = rawNumber(row?.reportedValue) ?? finiteNumber(row?.dataValue);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
          || !Number.isFinite(Date.parse(`${asOfDate}T00:00:00Z`))
          || pointValue === null
          || (currency && currency !== "USD")
        ) {
          continue;
        }
        pointsByDate.set(asOfDate, Object.freeze({ asOfDate, value: pointValue }));
      }
      const points = [...pointsByDate.values()]
        .sort((left, right) => left.asOfDate.localeCompare(right.asOfDate));
      byType.set(type, points);
    }
  }
  return byType;
}

function latestPoint(
  series: ReadonlyMap<string, readonly FundamentalPoint[]>,
  type: string,
): FundamentalPoint | null {
  return series.get(type)?.at(-1) ?? null;
}

function growthFromLastTwo(
  series: ReadonlyMap<string, readonly FundamentalPoint[]>,
  type: string,
): number | undefined {
  const points = series.get(type) ?? [];
  const latest = points.at(-1);
  const previous = points.at(-2);
  if (!latest || !previous || previous.value === 0) return undefined;
  return (latest.value - previous.value) / Math.abs(previous.value);
}

function safeRatio(numerator: number | undefined, denominator: number | undefined): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) ? ratio : undefined;
}

function fundamentalsFromTimeseries(
  instrument: Instrument,
  payloads: readonly unknown[],
  quoteSummary: JsonRecord | null,
  ingestedAt: string,
): FundamentalsSnapshot | null {
  const symbol = normalizedSymbol(instrument.symbol);
  if (!symbol) return null;
  const series = fundamentalSeries(payloads, symbol);
  const financialData = asRecord(quoteSummary?.financialData);
  const summaryDetail = asRecord(quoteSummary?.summaryDetail);
  const statistics = asRecord(quoteSummary?.defaultKeyStatistics);
  const price = asRecord(quoteSummary?.price);

  const revenuePoint = latestPoint(series, "trailingTotalRevenue")
    ?? latestPoint(series, "annualTotalRevenue");
  const netIncomePoint = latestPoint(series, "trailingNetIncome")
    ?? latestPoint(series, "annualNetIncome");
  const epsPoint = latestPoint(series, "trailingDilutedEPS")
    ?? latestPoint(series, "annualDilutedEPS");
  const grossProfit = latestPoint(series, "trailingGrossProfit")?.value;
  const operatingIncome = latestPoint(series, "trailingOperatingIncome")?.value;
  const ebitda = latestPoint(series, "trailingEBITDA")?.value
    ?? rawNumber(financialData?.ebitda)
    ?? undefined;
  const operatingCashFlow = latestPoint(series, "trailingOperatingCashFlow")?.value
    ?? rawNumber(financialData?.operatingCashflow)
    ?? undefined;
  const capitalExpenditure = latestPoint(series, "trailingCapitalExpenditure")?.value ?? undefined;
  const freeCashFlow = latestPoint(series, "trailingFreeCashFlow")?.value
    ?? rawNumber(financialData?.freeCashflow)
    ?? undefined;
  const marketCap = latestPoint(series, "trailingMarketCap")?.value
    ?? rawNumber(price?.marketCap)
    ?? rawNumber(summaryDetail?.marketCap)
    ?? undefined;
  const revenue = revenuePoint?.value ?? rawNumber(financialData?.totalRevenue) ?? undefined;
  const netIncome = netIncomePoint?.value;
  const revenueGrowth = growthFromLastTwo(series, "annualTotalRevenue")
    ?? rawNumber(financialData?.revenueGrowth)
    ?? undefined;
  const epsGrowth = growthFromLastTwo(series, "annualDilutedEPS")
    ?? rawNumber(financialData?.earningsGrowth)
    ?? undefined;
  const grossMargin = safeRatio(grossProfit, revenue)
    ?? rawNumber(financialData?.grossMargins)
    ?? undefined;
  const operatingMargin = safeRatio(operatingIncome, revenue)
    ?? rawNumber(financialData?.operatingMargins)
    ?? undefined;
  const netMargin = safeRatio(netIncome, revenue)
    ?? rawNumber(financialData?.profitMargins)
    ?? undefined;
  const freeCashFlowYield = safeRatio(freeCashFlow, marketCap);
  const trailingPe = latestPoint(series, "trailingPeRatio")?.value
    ?? rawNumber(summaryDetail?.trailingPE)
    ?? undefined;
  const forwardPe = rawNumber(summaryDetail?.forwardPE) ?? undefined;
  const priceToBook = latestPoint(series, "trailingPbRatio")?.value
    ?? rawNumber(statistics?.priceToBook)
    ?? undefined;
  const priceToSales = latestPoint(series, "trailingPsRatio")?.value
    ?? rawNumber(summaryDetail?.priceToSalesTrailing12Months)
    ?? undefined;
  const dividendYield = latestPoint(series, "trailingDividendYield")?.value
    ?? rawNumber(summaryDetail?.dividendYield)
    ?? undefined;
  const roe = rawNumber(financialData?.returnOnEquity) ?? undefined;
  const roa = rawNumber(financialData?.returnOnAssets) ?? undefined;
  const currentRatio = rawNumber(financialData?.currentRatio) ?? undefined;
  const quickRatio = rawNumber(financialData?.quickRatio) ?? undefined;
  const yahooDebtToEquity = rawNumber(financialData?.debtToEquity);
  // Yahoo publishes this field as a percentage (for example 152 means 1.52x).
  const debtToEquity = yahooDebtToEquity === null ? undefined : yahooDebtToEquity / 100;
  const cashAndShortTermInvestments = latestPoint(
    series,
    "annualCashCashEquivalentsAndShortTermInvestments",
  )?.value ?? rawNumber(financialData?.totalCash) ?? undefined;
  const totalAssets = latestPoint(series, "annualTotalAssets")?.value;
  const totalDebt = latestPoint(series, "annualTotalDebt")?.value
    ?? rawNumber(financialData?.totalDebt)
    ?? undefined;
  const shareholdersEquity = latestPoint(series, "annualStockholdersEquity")?.value;
  const currentLiabilities = latestPoint(series, "annualCurrentLiabilities")?.value;
  const netDebt = totalDebt === undefined || cashAndShortTermInvestments === undefined
    ? undefined
    : totalDebt - cashAndShortTermInvestments;
  const cashRatio = safeRatio(cashAndShortTermInvestments, currentLiabilities);
  const enterpriseValue = rawNumber(statistics?.enterpriseValue) ?? undefined;
  const enterpriseValueToRevenue = rawNumber(statistics?.enterpriseToRevenue)
    ?? safeRatio(enterpriseValue, revenue);
  const enterpriseValueToEbitda = rawNumber(statistics?.enterpriseToEbitda)
    ?? safeRatio(enterpriseValue, ebitda);
  const pegRatio = rawNumber(statistics?.pegRatio) ?? undefined;
  const priceToFreeCashFlow = safeRatio(marketCap, freeCashFlow);
  const earningsYield = safeRatio(netIncome, marketCap)
    ?? (trailingPe === undefined || trailingPe === 0 ? undefined : 1 / trailingPe);
  const ebitdaMargin = safeRatio(ebitda, revenue)
    ?? rawNumber(financialData?.ebitdaMargins)
    ?? undefined;
  const freeCashFlowMargin = safeRatio(freeCashFlow, revenue);
  const dividendPerShare = rawNumber(summaryDetail?.trailingAnnualDividendRate)
    ?? rawNumber(summaryDetail?.dividendRate)
    ?? undefined;
  const payoutRatio = rawNumber(summaryDetail?.payoutRatio) ?? undefined;
  const sharesOutstanding = rawNumber(statistics?.sharesOutstanding) ?? undefined;
  const revenuePerShare = safeRatio(revenue, sharesOutstanding);
  const bookValuePerShare = rawNumber(statistics?.bookValue) ?? undefined;
  const operatingCashFlowPerShare = safeRatio(operatingCashFlow, sharesOutstanding);
  const freeCashFlowPerShare = safeRatio(freeCashFlow, sharesOutstanding);
  const asOf = Array.from(series.values())
    .flatMap((points) => points.map((point) => point.asOfDate))
    .sort()
    .at(-1) ?? (isoFromUnix(price?.regularMarketTime)?.slice(0, 10) ?? ingestedAt);
  const sourceUrl = `${YAHOO_TIMESERIES_URL}/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}`;

  if (
    series.size === 0
    && revenue === undefined
    && revenueGrowth === undefined
    && epsGrowth === undefined
    && grossProfit === undefined
    && operatingIncome === undefined
    && ebitda === undefined
    && enterpriseValue === undefined
    && trailingPe === undefined
    && forwardPe === undefined
    && pegRatio === undefined
    && priceToBook === undefined
    && priceToSales === undefined
    && priceToFreeCashFlow === undefined
    && grossMargin === undefined
    && operatingMargin === undefined
    && ebitdaMargin === undefined
    && netMargin === undefined
    && dividendYield === undefined
    && dividendPerShare === undefined
    && freeCashFlow === undefined
    && operatingCashFlow === undefined
    && roe === undefined
    && roa === undefined
    && cashAndShortTermInvestments === undefined
    && totalAssets === undefined
    && totalDebt === undefined
    && shareholdersEquity === undefined
    && currentRatio === undefined
    && quickRatio === undefined
    && debtToEquity === undefined
  ) return null;

  return Object.freeze({
    instrumentId: instrument.instrumentId,
    currency: "USD",
    period: asOf,
    ...(revenue === undefined ? {} : { revenue }),
    ...(revenueGrowth === undefined ? {} : { revenueGrowth }),
    ...(grossProfit === undefined ? {} : { grossProfit }),
    ...(operatingIncome === undefined ? {} : { operatingIncome }),
    ...(ebitda === undefined ? {} : { ebitda }),
    ...(netIncome === undefined ? {} : { netIncome }),
    ...(epsPoint === null ? {} : { eps: epsPoint.value }),
    ...(epsGrowth === undefined ? {} : { epsGrowth }),
    ...(enterpriseValue === undefined ? {} : { enterpriseValue }),
    ...(trailingPe === undefined ? {} : { trailingPe }),
    ...(forwardPe === undefined ? {} : { forwardPe }),
    ...(pegRatio === undefined ? {} : { pegRatio }),
    ...(priceToBook === undefined ? {} : { priceToBook }),
    ...(priceToSales === undefined ? {} : { priceToSales }),
    ...(priceToFreeCashFlow === undefined ? {} : { priceToFreeCashFlow }),
    ...(enterpriseValueToRevenue === undefined ? {} : { enterpriseValueToRevenue }),
    ...(enterpriseValueToEbitda === undefined ? {} : { enterpriseValueToEbitda }),
    ...(earningsYield === undefined ? {} : { earningsYield }),
    ...(roe === undefined ? {} : { roe }),
    ...(roa === undefined ? {} : { roa }),
    ...(grossMargin === undefined ? {} : { grossMargin }),
    ...(operatingMargin === undefined ? {} : { operatingMargin }),
    ...(ebitdaMargin === undefined ? {} : { ebitdaMargin }),
    ...(netMargin === undefined ? {} : { netMargin }),
    ...(freeCashFlowMargin === undefined ? {} : { freeCashFlowMargin }),
    ...(cashAndShortTermInvestments === undefined ? {} : { cashAndShortTermInvestments }),
    ...(totalAssets === undefined ? {} : { totalAssets }),
    ...(totalDebt === undefined ? {} : { totalDebt }),
    ...(netDebt === undefined ? {} : { netDebt }),
    ...(shareholdersEquity === undefined ? {} : { shareholdersEquity }),
    ...(dividendYield === undefined ? {} : { dividendYield }),
    ...(dividendPerShare === undefined ? {} : { dividendPerShare }),
    ...(payoutRatio === undefined ? {} : { payoutRatio }),
    ...(operatingCashFlow === undefined ? {} : { operatingCashFlow }),
    ...(capitalExpenditure === undefined ? {} : { capitalExpenditure }),
    ...(freeCashFlow === undefined ? {} : { freeCashFlow }),
    ...(freeCashFlowYield === undefined ? {} : { freeCashFlowYield }),
    ...(debtToEquity === undefined ? {} : { debtToEquity }),
    ...(currentRatio === undefined ? {} : { currentRatio }),
    ...(quickRatio === undefined ? {} : { quickRatio }),
    ...(cashRatio === undefined ? {} : { cashRatio }),
    ...(revenuePerShare === undefined ? {} : { revenuePerShare }),
    ...(bookValuePerShare === undefined ? {} : { bookValuePerShare }),
    ...(operatingCashFlowPerShare === undefined ? {} : { operatingCashFlowPerShare }),
    ...(freeCashFlowPerShare === undefined ? {} : { freeCashFlowPerShare }),
    provenance: Object.freeze({
      providerId: manifest.id,
      sourceId: `yahoo-timeseries:${symbol}`,
      asOf,
      ingestedAt,
      sourceUrl,
    }),
  });
}

function quoteSummaryResult(payload: unknown): JsonRecord | null {
  const root = asRecord(payload);
  const summary = asRecord(root?.quoteSummary);
  if (!summary || summary.error) return null;
  return asRecord(asArray(summary.result)[0]);
}

function profileFromQuoteSummary(
  instrument: Instrument,
  result: JsonRecord,
  sourceUrl: string,
  ingestedAt: string,
): CompanyProfile {
  const assetProfile = asRecord(result.assetProfile);
  const summaryDetail = asRecord(result.summaryDetail);
  const statistics = asRecord(result.defaultKeyStatistics);
  const price = asRecord(result.price);
  const website = safeHttpUrl(assetProfile?.website);
  const employees = rawNumber(assetProfile?.fullTimeEmployees);
  const firstTradeMilliseconds = rawNumber(price?.firstTradeDateMilliseconds);
  const firstTradeSeconds = firstTradeMilliseconds === null
    ? rawNumber(assetProfile?.ipoDate)
    : firstTradeMilliseconds / 1_000;
  const ipoDate = isoFromUnix(firstTradeSeconds)?.slice(0, 10);
  const asOf = isoFromUnix(price?.regularMarketTime) ?? ingestedAt;
  const beta = rawNumber(summaryDetail?.beta) ?? rawNumber(statistics?.beta);
  const marketCap = rawNumber(price?.marketCap) ?? rawNumber(summaryDetail?.marketCap);
  const description = text(assetProfile?.longBusinessSummary);
  const sector = text(assetProfile?.sectorDisp) || text(assetProfile?.sector);
  const industry = text(assetProfile?.industryDisp) || text(assetProfile?.industry);
  const country = text(assetProfile?.country);
  const city = text(assetProfile?.city);
  const logoUrl = companyLogoPathForUSStock(instrument.symbol);

  return Object.freeze({
    instrumentId: instrument.instrumentId,
    ...(description ? { description } : {}),
    ...(website ? { website } : {}),
    ...(sector ? { sector } : {}),
    ...(industry ? { industry } : {}),
    ...(country ? { country } : {}),
    ...(city ? { city } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    ...(employees === null ? {} : { employees: Math.max(0, Math.trunc(employees)) }),
    ...(beta === null ? {} : { beta }),
    ...(marketCap === null ? {} : { marketCap }),
    ...(ipoDate ? { ipoDate } : {}),
    provenance: Object.freeze({
      providerId: manifest.id,
      sourceId: `yahoo-quote-summary:${instrument.symbol}:profile`,
      asOf,
      ingestedAt,
      sourceUrl,
    }),
  });
}

function chartUrl(
  symbol: string,
  range: MarketBarRange,
  interval: MarketBarInterval,
  includePrePost: boolean,
): URL {
  // The symbol has already passed a strict allowlist, but encodeURIComponent is
  // still used at the path boundary to avoid turning future symbol formats into
  // path or query syntax.
  const url = new URL(`${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  // Yahoo exposes 1-hour candles but no native four-hour resolution. Keep the
  // public contract canonical and rebuild 4h bars after normalization.
  url.searchParams.set("interval", interval === "4h" ? "1h" : interval);
  url.searchParams.set("includePrePost", String(includePrePost));
  url.searchParams.set("events", "div,splits");
  url.searchParams.set("includeAdjustedClose", "true");
  return url;
}

function chartResult(payload: unknown): JsonRecord | null {
  const root = asRecord(payload);
  const chart = asRecord(root?.chart);
  if (!chart || chart.error) return null;
  const result = asArray(chart.result);
  return asRecord(result[0]);
}

function validatedChartMeta(result: JsonRecord, expectedSymbol: string): JsonRecord | null {
  const meta = asRecord(result.meta);
  if (!meta) return null;
  const symbol = normalizedSymbol(text(meta.symbol));
  const instrumentType = text(meta.instrumentType).toUpperCase();
  const currency = text(meta.currency).toUpperCase();
  if (
    symbol !== expectedSymbol
    || instrumentType !== "EQUITY"
    || !exchangeDetails(meta.exchangeName)
    || currency !== "USD"
  ) {
    return null;
  }
  return meta;
}

type ParsedBar = Readonly<MarketBar & { unixTime: number }>;

function barsFromChartResult(result: JsonRecord): readonly ParsedBar[] {
  const timestamps = asArray(result.timestamp);
  const indicators = asRecord(result.indicators);
  const quotes = asArray(indicators?.quote);
  const quote = asRecord(quotes[0]);
  const adjustedRows = asArray(indicators?.adjclose);
  const adjusted = asRecord(adjustedRows[0]);
  if (!quote) return [];

  const items: ParsedBar[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const unixTime = unixSeconds(timestamps[index]);
    const open = finiteArrayValue(quote.open, index);
    const high = finiteArrayValue(quote.high, index);
    const low = finiteArrayValue(quote.low, index);
    const close = finiteArrayValue(quote.close, index);
    if (unixTime === null || open === null || high === null || low === null || close === null) {
      continue;
    }
    const volume = finiteArrayValue(quote.volume, index) ?? 0;
    const adjustedClose = finiteArrayValue(adjusted?.adjclose, index);
    items.push(Object.freeze({
      time: new Date(unixTime * 1_000).toISOString(),
      open,
      high,
      low,
      close,
      volume,
      ...(adjustedClose === null ? {} : { adjustedClose }),
      unixTime,
    }));
  }
  return Object.freeze(items);
}

function marketState(meta: JsonRecord, atSeconds: number): MarketSessionState {
  const explicit = text(meta.marketState).toUpperCase();
  if (explicit === "PRE" || explicit === "PREPRE") return "pre_market";
  if (explicit === "REGULAR") return "regular";
  if (explicit === "POST" || explicit === "POSTPOST") return "after_hours";
  if (explicit === "CLOSED") return "closed";

  const periods = asRecord(meta.currentTradingPeriod);
  for (const [key, state] of [
    ["pre", "pre_market"],
    ["regular", "regular"],
    ["post", "after_hours"],
  ] as const) {
    const period = asRecord(periods?.[key]);
    const start = unixSeconds(period?.start);
    const end = unixSeconds(period?.end);
    if (start !== null && end !== null && atSeconds >= start && atSeconds < end) {
      return state;
    }
  }
  return "closed";
}

function quoteFromChart(
  instrument: Instrument,
  result: JsonRecord,
  sourceUrl: string,
  ingestedAt: string,
  requestedAsOf?: string,
): Quote | null {
  const symbol = normalizedSymbol(instrument.symbol);
  if (!symbol) return null;
  const meta = validatedChartMeta(result, symbol);
  const bars = barsFromChartResult(result);
  const latest = bars.at(-1);
  if (!meta || !latest) return null;

  const previousClose = finiteNumber(meta.chartPreviousClose)
    ?? finiteNumber(meta.previousClose);
  if (previousClose === null || previousClose <= 0 || latest.close <= 0) return null;
  const open = finiteNumber(meta.regularMarketOpen) ?? latest.open;
  const high = finiteNumber(meta.regularMarketDayHigh) ?? latest.high;
  const low = finiteNumber(meta.regularMarketDayLow) ?? latest.low;
  const volume = finiteNumber(meta.regularMarketVolume) ?? latest.volume;
  const price = latest.close;
  if (open <= 0 || high <= 0 || low <= 0) return null;
  const change = price - previousClose;
  const asOfSeconds = requestedAsOf ? Date.parse(requestedAsOf) / 1_000 : Date.now() / 1_000;
  const stateAt = Number.isFinite(asOfSeconds) ? asOfSeconds : Date.now() / 1_000;
  const delayedByMinutes = finiteNumber(meta.exchangeDataDelayedBy);
  const provenance: DataProvenance = Object.freeze({
    providerId: manifest.id,
    sourceId: `yahoo-chart:${symbol}:quote`,
    asOf: latest.time,
    ingestedAt,
    sourceUrl,
  });

  return Object.freeze({
    instrumentId: instrument.instrumentId,
    price,
    change,
    changePercent: previousClose === 0 ? 0 : change / previousClose * 100,
    previousClose,
    open,
    high,
    low,
    volume,
    ...(finiteNumber(meta.marketCap) === null ? {} : { marketCap: finiteNumber(meta.marketCap) ?? undefined }),
    currency: "USD",
    marketState: marketState(meta, stateAt),
    delaySeconds: delayedByMinutes === null ? 900 : Math.max(0, delayedByMinutes * 60),
    provenance,
  });
}

function marketBarsFromChart(
  instrument: Instrument,
  result: JsonRecord,
  range: MarketBarRange,
  interval: MarketBarInterval,
  sourceUrl: string,
  ingestedAt: string,
): MarketBars | null {
  const symbol = normalizedSymbol(instrument.symbol);
  if (!symbol || !validatedChartMeta(result, symbol)) return null;
  const parsed = barsFromChartResult(result);
  if (parsed.length === 0) return null;
  const normalizedItems = parsed.map((bar) => Object.freeze({
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    ...(bar.adjustedClose === undefined ? {} : { adjustedClose: bar.adjustedClose }),
  }));
  const items = interval === "4h"
    ? aggregateMarketBars(normalizedItems, "4h")
    : normalizedItems;
  const latest = items.at(-1);
  if (!latest) return null;

  return Object.freeze({
    instrumentId: instrument.instrumentId,
    interval,
    range,
    adjustment: "raw",
    items: Object.freeze(items),
    provenance: Object.freeze({
      providerId: manifest.id,
      sourceId: `yahoo-chart:${symbol}:${range}:${interval}`,
      asOf: latest.time,
      ingestedAt,
      sourceUrl,
    }),
  });
}

function assertPersonalUse(env: ProviderEnvironment): void {
  const usageMode = env.UNICORN_USAGE_MODE?.trim().toLowerCase();
  const enabled = env.UNICORN_ENABLE_YAHOO_COMPAT?.trim().toLowerCase();
  if (usageMode !== "personal" || enabled !== "true") {
    throw new YahooProviderError(
      "usage_not_permitted",
      "Yahoo compatibility provider requires an explicit personal-use opt-in.",
    );
  }
}

export const yahooProviderRegistration: ProviderRegistration = {
  manifest,
  create: (env) => {
    if (typeof window !== "undefined") {
      throw new YahooProviderError("usage_not_permitted", "Yahoo provider is server-only.");
    }
    assertPersonalUse(env);

    // This double opt-in is a safety boundary, not a data-display license. Never
    // set these flags in a public, hosted or multi-user deployment. Such a build
    // must select a separately licensed provider instead, so publishing Unicorn
    // cannot accidentally turn this compatibility adapter on by default.
    const fetchImplementation = globalThis.fetch.bind(globalThis);
    const timeoutMs = timeoutMilliseconds(env);
    let popularSearchCache: Readonly<{
      expiresAt: number;
      items: readonly Instrument[];
    }> | null = null;
    let credentialCache: Readonly<{
      cookie: string;
      crumb: string;
      expiresAt: number;
    }> | null = null;
    let credentialPromise: Promise<Readonly<{
      cookie: string;
      crumb: string;
    }>> | null = null;
    const quoteSummaryCache = new Map<string, Readonly<{
      payload: unknown;
      sourceUrl: string;
      ingestedAt: string;
      expiresAt: number;
    }>>();
    const quoteSummaryPromises = new Map<string, Promise<Readonly<{
      payload: unknown;
      sourceUrl: string;
      ingestedAt: string;
    }>>>();

    async function yahooCredential(forceRefresh = false): Promise<Readonly<{
      cookie: string;
      crumb: string;
    }>> {
      const now = Date.now();
      if (!forceRefresh && credentialCache && credentialCache.expiresAt > now) {
        return credentialCache;
      }
      if (!forceRefresh && credentialPromise) return credentialPromise;

      const operation = (async () => {
        const cookieResponse = await fetchResponse(
          fetchImplementation,
          new URL(YAHOO_COOKIE_URL),
          timeoutMs,
        );
        // fc.yahoo.com intentionally answers 404 while setting the anonymous A3
        // cookie. Other unsuccessful statuses are treated as upstream failures.
        if (!cookieResponse.ok && cookieResponse.status !== 404) {
          throw new YahooProviderError(
            "upstream_error",
            "Yahoo Finance returned an unsuccessful credential response.",
            cookieResponse.status,
          );
        }
        const setCookie = cookieResponse.headers.get("set-cookie") ?? "";
        const cookieMatch = setCookie.match(/(?:^|[;,]\s*)A3=([^;,\s]+)/i);
        if (!cookieMatch?.[1]) {
          throw new YahooProviderError(
            "invalid_response",
            "Yahoo Finance did not return a usable anonymous session cookie.",
          );
        }
        const cookie = `A3=${cookieMatch[1]}`;
        const crumbResponse = await fetchResponse(
          fetchImplementation,
          new URL(YAHOO_CRUMB_URL),
          timeoutMs,
          { cookie },
        );
        if (!crumbResponse.ok) {
          throw new YahooProviderError(
            "upstream_error",
            "Yahoo Finance returned an unsuccessful crumb response.",
            crumbResponse.status,
          );
        }
        const crumb = (await crumbResponse.text()).trim();
        if (!crumb || crumb.length > 256 || /[\u0000-\u001f\u007f<>]/.test(crumb)) {
          throw new YahooProviderError(
            "invalid_response",
            "Yahoo Finance returned an invalid anonymous session crumb.",
          );
        }
        credentialCache = Object.freeze({
          cookie,
          crumb,
          expiresAt: now + CRUMB_CACHE_TTL_MS,
        });
        return credentialCache;
      })();
      if (!forceRefresh) credentialPromise = operation;
      try {
        return await operation;
      } finally {
        if (credentialPromise === operation) credentialPromise = null;
      }
    }

    async function parseJsonResponse(response: Response): Promise<unknown> {
      try {
        return await response.json();
      } catch {
        throw new YahooProviderError(
          "invalid_response",
          "Yahoo Finance returned an invalid JSON response.",
        );
      }
    }

    const earningsHistoryClient = createYahooEarningsHistoryClient({
      fetchImplementation,
      getCredential: yahooCredential,
      timeoutMs: Math.max(timeoutMs, 10_000),
      requestSize: 24,
    });

    async function fetchQuoteSummary(symbol: string): Promise<Readonly<{
      payload: unknown;
      sourceUrl: string;
      ingestedAt: string;
    }>> {
      const cached = quoteSummaryCache.get(symbol);
      if (cached && cached.expiresAt > Date.now()) return cached;
      const pending = quoteSummaryPromises.get(symbol);
      if (pending) return pending;

      const operation = (async () => {
        let credential = await yahooCredential();
        let response: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const url = quoteSummaryUrl(symbol, credential.crumb);
          response = await fetchResponse(fetchImplementation, url, timeoutMs, {
            cookie: credential.cookie,
          });
          if (response.status !== 401 || attempt === 1) break;
          credentialCache = null;
          quoteSummaryCache.delete(symbol);
          credential = await yahooCredential(true);
        }
        if (!response?.ok) {
          throw new YahooProviderError(
            "upstream_error",
            "Yahoo Finance returned an unsuccessful quote summary response.",
            response?.status,
          );
        }
        const payload = await parseJsonResponse(response);
        const ingestedAt = new Date().toISOString();
        // Never retain the crumb-bearing URL in provenance, caches or errors.
        const item = Object.freeze({
          payload,
          sourceUrl: quoteSummaryUrl(symbol).toString(),
          ingestedAt,
          expiresAt: Date.now() + QUOTE_SUMMARY_CACHE_TTL_MS,
        });
        quoteSummaryCache.set(symbol, item);
        return item;
      })();
      quoteSummaryPromises.set(symbol, operation);
      try {
        return await operation;
      } finally {
        if (quoteSummaryPromises.get(symbol) === operation) {
          quoteSummaryPromises.delete(symbol);
        }
      }
    }

    async function fetchFundamentals(
      instrument: Instrument,
      requestedAsOf?: string,
    ): Promise<FundamentalsSnapshot | null> {
      const symbol = normalizedSymbol(instrument.symbol);
      if (!symbol) return null;
      const parsedAsOf = requestedAsOf ? Date.parse(requestedAsOf) : NaN;
      const endMilliseconds = Number.isFinite(parsedAsOf) ? parsedAsOf : Date.now();
      const period2 = Math.trunc(endMilliseconds / 1_000) + 86_400;
      const period1 = period2 - 3 * 366 * 86_400;
      const [timeseriesSettled, [summaryItem]] = await Promise.all([
        Promise.allSettled(YAHOO_FUNDAMENTAL_TYPE_BATCHES.map((types) => {
          const url = fundamentalsTimeseriesUrl(symbol, types, period1, period2);
          return fetchJson(fetchImplementation, url, timeoutMs);
        })),
        Promise.allSettled([fetchQuoteSummary(symbol)]),
      ]);
      const timeseriesPayloads = timeseriesSettled
        .filter((item): item is PromiseFulfilledResult<unknown> => item.status === "fulfilled")
        .map((item) => item.value);
      const summaryResult = summaryItem?.status === "fulfilled"
        ? quoteSummaryResult(summaryItem.value.payload)
        : null;
      const ingestedAt = summaryItem?.status === "fulfilled"
        ? summaryItem.value.ingestedAt
        : new Date().toISOString();
      const snapshot = fundamentalsFromTimeseries(
        instrument,
        timeseriesPayloads,
        summaryResult,
        ingestedAt,
      );
      if (snapshot) return snapshot;
      const firstFailure = [...timeseriesSettled, summaryItem].find(
        (item): item is PromiseRejectedResult => item.status === "rejected",
      );
      if (firstFailure) throw firstFailure.reason;
      return null;
    }

    async function fetchSearchResults(
      query: string,
      requestedLimit: number,
    ): Promise<readonly Instrument[]> {
      const upstreamLimit = Math.min(
        MAX_SEARCH_RESULTS,
        Math.max(20, requestedLimit),
      );
      const url = searchUrl(query, upstreamLimit);
      const payload = asRecord(await fetchJson(fetchImplementation, url, timeoutMs));
      const quotes = asArray(payload?.quotes);
      const ingestedAt = new Date().toISOString();
      const seen = new Set<string>();
      const instruments: Instrument[] = [];
      for (const value of quotes) {
        const instrument = instrumentFromSearchQuote(value, url.toString(), ingestedAt);
        if (!instrument || seen.has(instrument.symbol)) continue;
        seen.add(instrument.symbol);
        instruments.push(instrument);
        if (instruments.length >= upstreamLimit) break;
      }
      return Object.freeze(instruments);
    }

    async function popularStocks(limit: number): Promise<readonly Instrument[]> {
      const now = Date.now();
      if (popularSearchCache && popularSearchCache.expiresAt > now) {
        return popularSearchCache.items.slice(0, limit);
      }
      const symbols = POPULAR_US_SYMBOLS.slice(0, Math.min(limit, POPULAR_US_SYMBOLS.length));
      const results = await Promise.all(symbols.map(async (symbol) => {
        const candidates = await fetchSearchResults(symbol, 5);
        return candidates.find((instrument) => instrument.symbol === symbol) ?? null;
      }));
      const items = Object.freeze(results.filter(
        (instrument): instrument is Instrument => instrument !== null,
      ));
      popularSearchCache = Object.freeze({
        expiresAt: now + POPULAR_SEARCH_CACHE_TTL_MS,
        items,
      });
      return items.slice(0, limit);
    }

    async function search(query: string, requestedLimit: number): Promise<readonly Instrument[]> {
      const normalizedLimit = Number.isFinite(requestedLimit)
        ? Math.trunc(requestedLimit)
        : 20;
      const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, normalizedLimit));
      const trimmedQuery = query.normalize("NFKC").trim().slice(0, 100);
      if (!trimmedQuery) return popularStocks(limit);
      const yahooQuery = normalizedYahooSearchQuery(trimmedQuery);
      const instruments = await fetchSearchResults(yahooQuery, limit);
      return rankSearchResults(instruments, trimmedQuery).slice(0, limit);
    }

    return {
      manifest,
      instrument: {
        searchUSStocks: ({ query, limit = 20 }) => search(query, limit),
        getUSStockBySymbol: async (rawSymbol) => {
          const symbol = normalizedSymbol(rawSymbol);
          if (!symbol) return null;
          const instruments = await search(symbol, 10);
          return instruments.find((instrument) => instrument.symbol === symbol) ?? null;
        },
      },
      market: {
        getQuote: async (instrument, context) => {
          const symbol = normalizedSymbol(instrument.symbol);
          if (!symbol) return null;
          const url = chartUrl(symbol, "1d", "5m", true);
          const payload = await fetchJson(fetchImplementation, url, timeoutMs);
          const result = chartResult(payload);
          if (!result) return null;
          return quoteFromChart(
            instrument,
            result,
            url.toString(),
            new Date().toISOString(),
            context.asOf,
          );
        },
        getBars: async (instrument, request) => {
          const symbol = normalizedSymbol(instrument.symbol);
          if (!symbol) return null;
          const url = chartUrl(symbol, request.range, request.interval, false);
          const payload = await fetchJson(fetchImplementation, url, timeoutMs);
          const result = chartResult(payload);
          if (!result) return null;
          return marketBarsFromChart(
            instrument,
            result,
            request.range,
            request.interval,
            url.toString(),
            new Date().toISOString(),
          );
        },
      },
      fundamentals: {
        getProfile: async (instrument) => {
          const symbol = normalizedSymbol(instrument.symbol);
          if (!symbol) return null;
          const item = await fetchQuoteSummary(symbol);
          const result = quoteSummaryResult(item.payload);
          if (!result) return null;
          return profileFromQuoteSummary(
            instrument,
            result,
            item.sourceUrl,
            item.ingestedAt,
          );
        },
        getFundamentals: (instrument, context) => fetchFundamentals(instrument, context.asOf),
        getEarnings: (instrument) => earningsHistoryClient.getEarnings(instrument),
      },
      news: {
        getCompanyNews: async (instrument) => {
          const symbol = normalizedSymbol(instrument.symbol);
          if (!symbol) return [];
          const limit = 20;
          const url = newsSearchUrl(symbol, limit);
          const payload = await fetchJson(fetchImplementation, url, timeoutMs);
          return companyNewsFromSearch(
            instrument,
            payload,
            url.toString(),
            new Date().toISOString(),
            limit,
          );
        },
      },
    };
  },
};
