"use client";

import { Star } from "@phosphor-icons/react";
import { CompanyLogo } from "../../components/CompanyLogo";
import { useI18n } from "../../platform/i18n";
import {
  clampPercent,
  compareSummaryPrices,
  formatSummaryAfterHoursPrice,
  formatSummaryCurrentPrice,
  formatSymbolPrice,
  validSummaryAfterHoursClose,
  type SymbolSummaryModuleProps,
} from "../../platform/symbol-summary";
import {
  UI_MODULE_SCHEMA_VERSION,
  type UiModuleManifestV1,
  type UiModuleRegistration,
} from "../../platform/ui-module-registry";
import { localizedSummaryManifest } from "./summary-i18n";

const BASE_MANIFEST = {
  schemaVersion: UI_MODULE_SCHEMA_VERSION,
  surface: "chart.symbol-summary",
  version: "1.0.0",
  defaultEnabled: true,
  userConfigurable: true,
  supportedDensities: ["compact", "normal"],
} as const;

const IDENTITY_MANIFEST = {
  ...BASE_MANIFEST,
  id: "core.identity_quote",
  label: "Symbol and price",
  description: "Fixed header",
  requiredCapabilities: ["instrument.identity", "market.quote"],
  defaultOrder: 0,
  userConfigurable: false,
} as const satisfies UiModuleManifestV1;

const PRICE_RANGE_MANIFEST = {
  ...BASE_MANIFEST,
  id: "core.price_range",
  label: "Price range",
  description: "Today and 52 weeks",
  requiredCapabilities: ["market.quote", "market.bars"],
  defaultOrder: 10,
} as const satisfies UiModuleManifestV1;

const KEY_STATISTICS_MANIFEST = {
  ...BASE_MANIFEST,
  id: "core.key_statistics",
  label: "Key statistics",
  description: "Volume and market cap",
  requiredCapabilities: ["market.quote", "fundamentals.normalized"],
  defaultOrder: 20,
} as const satisfies UiModuleManifestV1;

const EARNINGS_MANIFEST = {
  ...BASE_MANIFEST,
  id: "core.earnings",
  label: "Earnings",
  description: "Next report and estimates",
  requiredCapabilities: ["fundamentals.earnings"],
  defaultOrder: 30,
} as const satisfies UiModuleManifestV1;

const FINANCIALS_MANIFEST = {
  ...BASE_MANIFEST,
  id: "core.financials",
  label: "Financials",
  description: "TTM and FY",
  requiredCapabilities: ["fundamentals.normalized"],
  defaultOrder: 40,
} as const satisfies UiModuleManifestV1;

const PERFORMANCE_MANIFEST = {
  ...BASE_MANIFEST,
  id: "core.performance",
  label: "Performance",
  description: "1 week to 1 year",
  requiredCapabilities: ["market.bars"],
  defaultOrder: 50,
} as const satisfies UiModuleManifestV1;

const TECHNICAL_MANIFEST = {
  ...BASE_MANIFEST,
  id: "core.technical_rating",
  label: "Technicals",
  description: "Combined rating",
  requiredCapabilities: ["indicators.summary"],
  defaultOrder: 60,
} as const satisfies UiModuleManifestV1;

const ANALYST_MANIFEST = {
  ...BASE_MANIFEST,
  id: "core.analyst_consensus",
  label: "Analysts",
  description: "Rating and price target",
  requiredCapabilities: ["analyst.consensus"],
  defaultOrder: 70,
} as const satisfies UiModuleManifestV1;

const COMPANY_PROFILE_MANIFEST = {
  ...BASE_MANIFEST,
  id: "core.company_profile",
  label: "Company profile",
  description: "Industry and location",
  requiredCapabilities: ["fundamentals.profile"],
  defaultOrder: 80,
} as const satisfies UiModuleManifestV1;

function SectionTitle({ manifest }: { manifest: UiModuleManifestV1 }) {
  const { t } = useI18n();
  const copy = localizedSummaryManifest(manifest, t);
  return (
    <div className="stock-summary-section-title">
      <strong>{copy.label}</strong>
      <span>{copy.description}</span>
    </div>
  );
}

function moduleDataAttributes(manifest: UiModuleManifestV1) {
  return {
    "data-module-id": manifest.id,
    "data-module-version": manifest.version,
  };
}

function ratingTone(value: string) {
  const normalized = value.trim().toLowerCase();
  if (value.includes("買い") || normalized.includes("buy")) return "positive";
  if (value.includes("売り") || normalized.includes("sell")) return "negative-text";
  return "";
}

function localizedRating(value: string, t: (key: string) => string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "強い買い" || normalized === "strong buy") return t("summary.rating.strongBuy");
  if (normalized === "買い" || normalized === "buy") return t("summary.rating.buy");
  if (normalized === "中立" || normalized === "neutral" || normalized === "hold") return t("summary.rating.neutral");
  if (normalized === "売り" || normalized === "sell") return t("summary.rating.sell");
  if (normalized === "強い売り" || normalized === "strong sell") return t("summary.rating.strongSell");
  return value;
}

function localizedMarketStatus(value: string | undefined, t: (key: string) => string) {
  if (!value) return t("summary.marketOpen");
  const normalized = value.toLowerCase();
  if (normalized.includes("プレマーケット") || normalized.includes("pre-market")) return t("summary.market.preMarket");
  if (normalized.includes("アフター") || normalized.includes("after hour")) return t("summary.market.afterHours");
  if (normalized.includes("取引時間外") || normalized.includes("closed")) return t("summary.market.closed");
  if (normalized.includes("取引中") || normalized.includes("開場中") || normalized.includes("open")) return t("summary.marketOpen");
  return value;
}

function localizedEarningsSession(value: string, t: (key: string) => string) {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("終了後") || normalized.includes("after") || normalized === "amc") {
    return t("summary.earningsSession.afterClose");
  }
  if (normalized.includes("開始前") || normalized.includes("before") || normalized === "bmo") {
    return t("summary.earningsSession.beforeOpen");
  }
  return value;
}

function localizedAssetType(value: string | undefined, t: (key: string) => string) {
  if (!value || value === "普通株" || value.toLowerCase() === "common stock") return t("summary.assetType.commonStock");
  return value;
}

function parseSignedPercent(value: string) {
  const normalized = value.trim().replace(/−/g, "-").replace(/％/g, "%");
  const match = normalized.match(/^([+-]?(?:\d+(?:,\d{3})*|\d+)(?:\.\d+)?)%$/);
  if (!match) return null;

  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function signedValueTone(value: number | null) {
  if (value === null || value === 0) return "";
  return value > 0 ? "positive" : "negative-text";
}

const TECHNICAL_RATING_SCORE: Readonly<Record<string, number>> = {
  "強い売り": -2,
  "strong sell": -2,
  "売り": -1,
  sell: -1,
  "中立": 0,
  neutral: 0,
  "買い": 1,
  buy: 1,
  "強い買い": 2,
  "strong buy": 2,
};

function technicalRatingScore(value: string) {
  return TECHNICAL_RATING_SCORE[value.trim().toLowerCase()] ?? null;
}

function IdentityQuoteModule({
  stock,
  intelligence,
  afterHours,
  watched,
  onToggleWatched,
}: SymbolSummaryModuleProps) {
  const { t } = useI18n();
  const currencyCode = stock.currencyCode ?? (stock.currency === "$" ? "USD" : stock.currency === "¥" ? "JPY" : stock.currency);
  const afterHoursClose = validSummaryAfterHoursClose(stock, afterHours);
  const afterHoursTone = compareSummaryPrices(stock.price, afterHoursClose);
  return (
    <section
      className="right-symbol-summary stock-summary-identity"
      {...moduleDataAttributes(IDENTITY_MANIFEST)}
    >
      <div className="summary-title-row">
        <div><CompanyLogo stock={stock} className="large" eager /></div>
        <div><strong>{stock.ticker}</strong><span>{stock.name}</span></div>
        <button
          type="button"
          className={watched ? "watched" : ""}
          onClick={onToggleWatched}
          aria-label={watched ? t("summary.removeFromWatchlist") : t("summary.addToWatchlist")}
        >
          <Star size={19} weight={watched ? "fill" : "regular"} />
        </button>
      </div>
      <div className="summary-market-meta">
        <span>{stock.market}</span><span>{stock.sector}</span><span>{localizedAssetType(stock.assetTypeLabel, t)}</span>
      </div>
      <div className="summary-quote">
        <strong>{formatSummaryCurrentPrice(stock)}</strong><small>{currencyCode}</small>
        <span className={stock.change >= 0 ? "positive" : "negative-text"}>
          {stock.changeValue >= 0 ? "+" : ""}{stock.changeValue.toFixed(stock.currency === "$" ? 2 : 1)} · {stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)}%
        </span>
      </div>
      <div className="summary-after-hours" data-tone={afterHoursTone}>
        <span>{t("summary.afterHours")}</span>
        <span className="summary-after-hours-value">
          <strong className={afterHoursTone}>{formatSummaryAfterHoursPrice(afterHoursClose)}</strong>
          {afterHoursClose !== null && <small>{currencyCode}</small>}
        </span>
      </div>
      <div className="summary-market-status">
        <i />{localizedMarketStatus(intelligence.marketStatus, t)}<span>{intelligence.dataFreshness}</span>
      </div>
    </section>
  );
}

function PriceRangeModule({ stock, intelligence }: SymbolSummaryModuleProps) {
  const { t } = useI18n();
  return (
    <section className="stock-summary-section" {...moduleDataAttributes(PRICE_RANGE_MANIFEST)}>
      <SectionTitle manifest={PRICE_RANGE_MANIFEST} />
      <div className="summary-range-block">
        <div className="summary-range-heading"><span>{t("summary.todayRange")}</span><strong>{formatSymbolPrice(stock, stock.low)} — {formatSymbolPrice(stock, stock.high)}</strong></div>
        <div className="summary-range-track"><i style={{ left: `${clampPercent(intelligence.dayRangePosition)}%` }} /></div>
        <div className="summary-range-labels"><span>{formatSymbolPrice(stock, stock.low)}</span><b>{formatSymbolPrice(stock)}</b><span>{formatSymbolPrice(stock, stock.high)}</span></div>
      </div>
      <div className="summary-range-block">
        <div className="summary-range-heading"><span>{t("summary.yearRange")}</span><strong>{intelligence.yearLow} — {intelligence.yearHigh}</strong></div>
        <div className="summary-range-track"><i style={{ left: `${clampPercent(intelligence.yearRangePosition)}%` }} /></div>
        <div className="summary-range-labels"><span>{intelligence.yearLow}</span><b>{formatSymbolPrice(stock)}</b><span>{intelligence.yearHigh}</span></div>
      </div>
    </section>
  );
}

function KeyStatisticsModule({ stock, intelligence }: SymbolSummaryModuleProps) {
  const { t } = useI18n();
  return (
    <section className="stock-summary-section" {...moduleDataAttributes(KEY_STATISTICS_MANIFEST)}>
      <SectionTitle manifest={KEY_STATISTICS_MANIFEST} />
      <dl className="summary-stat-list">
        <div><dt>{t("summary.nextEarnings")}</dt><dd>{intelligence.nextEarnings}<small>{localizedEarningsSession(intelligence.earningsSession, t)}</small></dd></div>
        <div><dt>{t("summary.volume")}</dt><dd>{stock.volume}</dd></div>
        <div><dt>{t("summary.averageVolume30d")}</dt><dd>{intelligence.averageVolume30d}</dd></div>
        <div><dt>{t("summary.marketCap")}</dt><dd>{stock.marketCap}</dd></div>
      </dl>
    </section>
  );
}

function EarningsModule({ intelligence }: SymbolSummaryModuleProps) {
  const { t } = useI18n();
  return (
    <section className="stock-summary-section" {...moduleDataAttributes(EARNINGS_MANIFEST)}>
      <SectionTitle manifest={EARNINGS_MANIFEST} />
      <div className="summary-event-card">
        <div><span>{t("summary.nextReport")}</span><strong>{intelligence.nextEarnings}</strong><small>{localizedEarningsSession(intelligence.earningsSession, t)}</small></div>
        <div><span>{t("summary.estimatedEps")}</span><strong>{intelligence.earningsEstimate}</strong></div>
        <div><span>{t("summary.estimatedRevenue")}</span><strong>{intelligence.revenueEstimate}</strong></div>
        <div><span>{t("summary.exDividendDate")}</span><strong>{intelligence.exDividend}</strong></div>
      </div>
    </section>
  );
}

function FinancialsModule({ stock, intelligence }: SymbolSummaryModuleProps) {
  const { t } = useI18n();
  return (
    <section className="stock-summary-section" {...moduleDataAttributes(FINANCIALS_MANIFEST)}>
      <SectionTitle manifest={FINANCIALS_MANIFEST} />
      <dl className="summary-stat-list">
        <div><dt>{t("summary.revenueFy")}</dt><dd>{stock.revenue}<small className={stock.revenueGrowth.startsWith("+") ? "positive" : "negative-text"}>{stock.revenueGrowth} YoY</small></dd></div>
        <div><dt>{t("summary.basicEpsTtm")}</dt><dd>{stock.eps}<small className={stock.epsGrowth.startsWith("+") ? "positive" : "negative-text"}>{stock.epsGrowth} YoY</small></dd></div>
        <div><dt>{t("summary.peTtm")}</dt><dd>{stock.pe}</dd></div>
        <div><dt>{t("summary.dividendYieldForecast")}</dt><dd>{stock.dividend}</dd></div>
        <div><dt>{t("summary.beta1y")}</dt><dd>{intelligence.beta}</dd></div>
      </dl>
    </section>
  );
}

function PerformanceModule({ intelligence }: SymbolSummaryModuleProps) {
  const { t } = useI18n();
  const performance = [
    [t("summary.period.week"), intelligence.performance.week],
    [t("summary.period.month"), intelligence.performance.month],
    [t("summary.period.threeMonths"), intelligence.performance.threeMonths],
    [t("summary.period.yearToDate"), intelligence.performance.yearToDate],
    [t("summary.period.year"), intelligence.performance.year],
  ].map(([period, value]) => ({ period, value, parsed: parseSignedPercent(value) }));
  const meterMagnitude = Math.max(
    1,
    ...performance.flatMap(({ parsed }) => parsed === null ? [] : [Math.abs(parsed)]),
  );

  return (
    <section className="stock-summary-section" {...moduleDataAttributes(PERFORMANCE_MANIFEST)}>
      <SectionTitle manifest={PERFORMANCE_MANIFEST} />
      <div className="summary-performance-grid">
        {performance.map(({ period, value, parsed }) => {
          const magnitude = parsed === null ? 0 : Math.min(50, Math.abs(parsed) / meterMagnitude * 50);
          return (
            <div className="summary-performance-item" key={period}>
              <span>{period}</span>
              <strong className={signedValueTone(parsed)}>{value}</strong>
              {parsed === null ? (
                <span
                  className="summary-performance-meter-placeholder"
                  aria-label={t("summary.performanceUnavailable", { period })}
                >—</span>
              ) : (
                <span
                  className="summary-performance-track"
                  data-tone={signedValueTone(parsed) || "neutral"}
                  role="img"
                  aria-label={t("summary.performanceAria", { period, value })}
                >
                  <i />
                  <b style={{ left: parsed >= 0 ? "50%" : `${50 - magnitude}%`, width: `${magnitude}%` }} />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TechnicalRatingModule({ intelligence }: SymbolSummaryModuleProps) {
  const { t } = useI18n();
  const ratings = [
    [t("summary.overall"), intelligence.technical.overall],
    [t("summary.movingAverages"), intelligence.technical.movingAverages],
    [t("summary.oscillators"), intelligence.technical.oscillators],
  ] as const;

  return (
    <section className="stock-summary-section" {...moduleDataAttributes(TECHNICAL_MANIFEST)}>
      <SectionTitle manifest={TECHNICAL_MANIFEST} />
      <div className="summary-rating-grid">
        {ratings.map(([label, rating]) => {
          const score = technicalRatingScore(rating);
          const displayRating = localizedRating(rating, t);
          const magnitude = score === null ? 0 : Math.min(50, Math.abs(score) / 2 * 50);
          return (
            <div key={label}>
              <span>{label}</span>
              <strong className={ratingTone(rating)}>{displayRating}</strong>
              {score === null ? (
                <span
                  className="summary-technical-meter-placeholder"
                  aria-label={t("summary.ratingUnavailable", { label })}
                >—</span>
              ) : (
                <span
                  className="summary-technical-meter summary-performance-track"
                  data-tone={ratingTone(rating) || "neutral"}
                  role="img"
                  aria-label={t("summary.ratingAria", { label, rating: displayRating })}
                >
                  <i />
                  <b style={{ left: score >= 0 ? "50%" : `${50 - magnitude}%`, width: `${magnitude}%` }} />
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="summary-technical-footer"><span>RSI 14</span><strong>{intelligence.technical.rsi}</strong></div>
    </section>
  );
}

function AnalystConsensusModule({ stock }: SymbolSummaryModuleProps) {
  const { t } = useI18n();
  const analystRating = stock.buy > stock.analysts / 2 ? "buy" : stock.sell > stock.buy ? "sell" : "neutral";
  const displayRating = localizedRating(analystRating, t);
  const upside = ((stock.target / stock.price - 1) * 100).toFixed(1);
  return (
    <section className="stock-summary-section" {...moduleDataAttributes(ANALYST_MANIFEST)}>
      <SectionTitle manifest={ANALYST_MANIFEST} />
      <div className="summary-analyst-head">
        <div><span>{t("summary.consensus")}</span><strong className={ratingTone(analystRating)}>{displayRating}</strong><small>{t("summary.analystCount", { count: stock.analysts })}</small></div>
        <div><span>{t("summary.averagePriceTarget")}</span><strong>{formatSymbolPrice(stock, stock.target)}</strong><small className={Number(upside) >= 0 ? "positive" : "negative-text"}>{Number(upside) >= 0 ? "+" : ""}{upside}%</small></div>
      </div>
      <div className="summary-consensus-bar"><i style={{ flex: Math.max(0, stock.sell) }} /><i style={{ flex: Math.max(0, stock.neutral) }} /><i style={{ flex: Math.max(0, stock.buy) }} /></div>
      <div className="summary-consensus-labels"><span>{t("summary.rating.sell")} {stock.sell}</span><span>{t("summary.rating.neutral")} {stock.neutral}</span><span>{t("summary.rating.buy")} {stock.buy}</span></div>
      <div className="summary-target-range"><span>{t("summary.low")} {formatSymbolPrice(stock, stock.targetLow)}</span><b>{t("summary.average")} {formatSymbolPrice(stock, stock.target)}</b><span>{t("summary.high")} {formatSymbolPrice(stock, stock.targetHigh)}</span></div>
    </section>
  );
}

function CompanyProfileModule({ stock, intelligence }: SymbolSummaryModuleProps) {
  const { t } = useI18n();
  return (
    <section className="stock-summary-section" {...moduleDataAttributes(COMPANY_PROFILE_MANIFEST)}>
      <SectionTitle manifest={COMPANY_PROFILE_MANIFEST} />
      <p className="stock-summary-description">{intelligence.description}</p>
      <dl className="summary-stat-list company-profile-list">
        <div><dt>{t("summary.sector")}</dt><dd>{stock.sector}</dd></div>
        <div><dt>{t("summary.industry")}</dt><dd>{intelligence.industry}</dd></div>
        <div><dt>{t("summary.location")}</dt><dd>{intelligence.country}</dd></div>
        <div><dt>{t("summary.employees")}</dt><dd>{intelligence.employees}</dd></div>
        <div><dt>{t("summary.website")}</dt><dd>{intelligence.website}</dd></div>
      </dl>
    </section>
  );
}

export const CORE_SYMBOL_SUMMARY_MODULES = [
  { manifest: IDENTITY_MANIFEST, Component: IdentityQuoteModule },
  { manifest: PRICE_RANGE_MANIFEST, Component: PriceRangeModule },
  { manifest: KEY_STATISTICS_MANIFEST, Component: KeyStatisticsModule },
  { manifest: EARNINGS_MANIFEST, Component: EarningsModule },
  { manifest: FINANCIALS_MANIFEST, Component: FinancialsModule },
  { manifest: PERFORMANCE_MANIFEST, Component: PerformanceModule },
  { manifest: TECHNICAL_MANIFEST, Component: TechnicalRatingModule },
  { manifest: ANALYST_MANIFEST, Component: AnalystConsensusModule },
  { manifest: COMPANY_PROFILE_MANIFEST, Component: CompanyProfileModule },
] as const satisfies readonly UiModuleRegistration<SymbolSummaryModuleProps>[];
