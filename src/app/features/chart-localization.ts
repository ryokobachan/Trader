import type { Locale } from "../platform/i18n";

/**
 * Lightweight Charts otherwise falls back to navigator.language, which can
 * make an English Unicorn workspace render Japanese year/month tick labels.
 */
export function chartLocaleTag(locale: Locale): "en-US" | "ja-JP" {
  return locale === "ja" ? "ja-JP" : "en-US";
}

/** Format date-only chart values without allowing the host time zone to shift the day. */
export function formatChartDate(date: string, locale: Locale): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(chartLocaleTag(locale), {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parsed);
}
