"use client";

import type {
  TechnicalRatingGroup,
  TechnicalRatingSignal,
  TechnicalRatingSignalId,
  TechnicalRatingSignalValue,
  TechnicalRatingSummary,
  TechnicalRatingVerdict,
} from "@api/stock-detail/technical-ratings";
import { useI18n, type Locale } from "../../platform/i18n";

const SIGNAL_LABELS: Readonly<Record<Locale, Readonly<Record<TechnicalRatingSignalId, string>>>> = {
  en: {
    sma10: "SMA 10",
    sma20: "SMA 20",
    sma30: "SMA 30",
    sma50: "SMA 50",
    sma100: "SMA 100",
    sma200: "SMA 200",
    ema10: "EMA 10",
    ema20: "EMA 20",
    ema30: "EMA 30",
    ema50: "EMA 50",
    ema100: "EMA 100",
    ema200: "EMA 200",
    hma9: "Hull MA 9",
    vwma20: "VWMA 20",
    ichimoku: "Ichimoku 9, 26, 52",
    rsi14: "RSI 14",
    stochastic1433: "Stochastic 14, 3, 3",
    cci20: "CCI 20",
    adx1414: "ADX 14, 14",
    awesome_oscillator: "Awesome Oscillator",
    momentum10: "Momentum 10",
    macd12269: "MACD 12, 26, 9",
    stochastic_rsi331414: "Stochastic RSI 3, 3, 14, 14",
    williams_r14: "Williams %R 14",
    bull_bear_power13: "Bull Bear Power 13",
    ultimate_oscillator71428: "Ultimate Oscillator 7, 14, 28",
  },
  ja: {
    sma10: "SMA 10",
    sma20: "SMA 20",
    sma30: "SMA 30",
    sma50: "SMA 50",
    sma100: "SMA 100",
    sma200: "SMA 200",
    ema10: "EMA 10",
    ema20: "EMA 20",
    ema30: "EMA 30",
    ema50: "EMA 50",
    ema100: "EMA 100",
    ema200: "EMA 200",
    hma9: "ハル移動平均 9",
    vwma20: "出来高加重移動平均 20",
    ichimoku: "一目均衡表 9, 26, 52",
    rsi14: "RSI 14",
    stochastic1433: "ストキャスティクス 14, 3, 3",
    cci20: "CCI 20",
    adx1414: "ADX 14, 14",
    awesome_oscillator: "オーサム・オシレーター",
    momentum10: "モメンタム 10",
    macd12269: "MACD 12, 26, 9",
    stochastic_rsi331414: "ストキャスティクスRSI 3, 3, 14, 14",
    williams_r14: "Williams %R 14",
    bull_bear_power13: "ブル・ベア・パワー 13",
    ultimate_oscillator71428: "アルティメット・オシレーター 7, 14, 28",
  },
};

const DUAL_VALUE_LABELS: Partial<Record<TechnicalRatingSignalId, readonly [string, string]>> = {
  ichimoku: ["Conversion", "Base"],
  stochastic1433: ["%K", "%D"],
  adx1414: ["ADX", "+DI"],
  macd12269: ["MACD", "Signal"],
  stochastic_rsi331414: ["%K", "%D"],
  bull_bear_power13: ["Bull", "Bear"],
};

const PRICE_SIGNAL_IDS = new Set<TechnicalRatingSignalId>([
  "sma10",
  "sma20",
  "sma30",
  "sma50",
  "sma100",
  "sma200",
  "ema10",
  "ema20",
  "ema30",
  "ema50",
  "ema100",
  "ema200",
  "hma9",
  "vwma20",
  "ichimoku",
]);

function verdictMessageKey(verdict: TechnicalRatingVerdict) {
  return `detail.technical.rating.verdict.${verdict}`;
}

function signalMessageKey(signal: TechnicalRatingSignalValue) {
  return `detail.technical.rating.signal.${signal}`;
}

function scorePosition(score: number | null) {
  if (score === null || !Number.isFinite(score)) return 50;
  return Math.max(0, Math.min(100, (score + 1) * 50));
}

function formatScore(score: number | null, locale: Locale) {
  if (score === null || !Number.isFinite(score)) return "—";
  return new Intl.NumberFormat(locale === "ja" ? "ja-JP" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(score);
}

function formatSignalNumber(signal: TechnicalRatingSignal, value: number | null, locale: Locale) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (PRICE_SIGNAL_IDS.has(signal.id)) {
    return new Intl.NumberFormat(locale === "ja" ? "ja-JP" : "en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  }
  const magnitude = Math.abs(value);
  return new Intl.NumberFormat(locale === "ja" ? "ja-JP" : "en-US", {
    maximumFractionDigits: magnitude < 1 ? 3 : 2,
  }).format(value);
}

function formatSignalValue(signal: TechnicalRatingSignal, locale: Locale) {
  const primary = formatSignalNumber(signal, signal.value, locale);
  if (signal.secondaryValue === undefined) return primary;
  const secondary = formatSignalNumber(signal, signal.secondaryValue, locale);
  const labels = DUAL_VALUE_LABELS[signal.id];
  return labels
    ? `${labels[0]} ${primary} / ${labels[1]} ${secondary}`
    : `${primary} / ${secondary}`;
}

function formatAsOf(value: string | null, locale: Locale) {
  if (!value) return "—";
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(isDateOnly ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: isDateOnly ? "UTC" : "America/New_York",
  }).format(parsed);
}

function RatingCard({
  label,
  group,
}: {
  label: string;
  group: TechnicalRatingGroup;
}) {
  const { locale, t } = useI18n();
  return (
    <article className="technical-rating-card" data-verdict={group.verdict}>
      <header>
        <span>{label}</span>
        <small>{t("detail.technical.rating.score")} {formatScore(group.score, locale)}</small>
      </header>
      <div className="technical-rating-gauge" aria-label={`${label}: ${t(verdictMessageKey(group.verdict))}`}>
        <div className="technical-rating-gauge-track" aria-hidden="true">
          <i style={{ left: `${scorePosition(group.score)}%` }} />
        </div>
        <strong>{t(verdictMessageKey(group.verdict))}</strong>
      </div>
      <footer>
        <span className="is-sell"><b>{group.sell}</b>{t("detail.technical.rating.sell")}</span>
        <span className="is-neutral"><b>{group.neutral}</b>{t("detail.technical.rating.neutral")}</span>
        <span className="is-buy"><b>{group.buy}</b>{t("detail.technical.rating.buy")}</span>
        {group.unavailable > 0 && <small>{t("detail.technical.rating.unavailableCount", { count: group.unavailable })}</small>}
      </footer>
    </article>
  );
}

function SignalTable({
  title,
  group,
}: {
  title: string;
  group: TechnicalRatingGroup;
}) {
  const { locale, t } = useI18n();
  return (
    <section className="technical-signal-table-card">
      <header>
        <h3>{title}</h3>
        <span>{group.signals.length}</span>
      </header>
      <div className="technical-signal-table-shell">
        <table className="technical-signal-table">
          <thead>
            <tr>
              <th>{t("detail.technical.rating.indicator")}</th>
              <th>{t("detail.technical.rating.value")}</th>
              <th>{t("detail.technical.rating.rating")}</th>
            </tr>
          </thead>
          <tbody>
            {group.signals.map((signal) => (
              <tr key={signal.id}>
                <td>{SIGNAL_LABELS[locale][signal.id] ?? signal.label}</td>
                <td>{formatSignalValue(signal, locale)}</td>
                <td><span className="technical-signal-verdict" data-signal={signal.signal}>{t(signalMessageKey(signal.signal))}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function TechnicalRatingsPanel({ summary }: { summary: TechnicalRatingSummary }) {
  const { locale, t } = useI18n();
  return (
    <section className="technical-ratings-panel" aria-label={t("detail.technical.rating.title")}>
      <header className="technical-ratings-heading">
        <div>
          <span className="eyebrow">26-INDICATOR RATING</span>
          <h2>{t("detail.technical.rating.title")}</h2>
          <p>{t("detail.technical.rating.description")}</p>
        </div>
        <small>{t("detail.technical.rating.dailyMeta", {
          count: summary.barCount,
          date: formatAsOf(summary.asOf, locale),
        })}</small>
      </header>
      <div className="technical-rating-card-grid">
        <RatingCard label={t("detail.technical.rating.overall")} group={summary.overall} />
        <RatingCard label={t("detail.technical.rating.movingAverages")} group={summary.movingAverages} />
        <RatingCard label={t("detail.technical.rating.oscillators")} group={summary.oscillators} />
      </div>
      <div className="technical-signal-table-grid">
        <SignalTable title={t("detail.technical.rating.movingAverages")} group={summary.movingAverages} />
        <SignalTable title={t("detail.technical.rating.oscillators")} group={summary.oscillators} />
      </div>
      <p className="technical-rating-disclaimer">{t("detail.technical.rating.disclaimer")}</p>
    </section>
  );
}
