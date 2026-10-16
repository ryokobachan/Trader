import type { DataProvenance, Instrument } from "@/app/platform/provider-contracts";

export type JapaneseCompanyProfileText = Readonly<{
  description?: string;
  sector?: string;
  industry?: string;
  provenance: DataProvenance;
  descriptionProvenance?: DataProvenance;
}>;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function japaneseText(value: unknown, maximum = 8_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= maximum && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)
    && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text) ? text : undefined;
}

/** The exchange comes from the identified listing, never a guess based on ticker. */
export function tradingViewProfileListing(instrument: Instrument): { symbol: string; url: string } | null {
  if (instrument.listingCountry !== "US" || instrument.currency !== "USD" || !instrument.active
    || !["common_stock", "adr"].includes(instrument.assetType)
    || !/^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)?$/.test(instrument.symbol) || instrument.symbol.length > 10) return null;
  const exchange = ({ XNAS: "NASDAQ", XNYS: "NYSE", XASE: "AMEX", ARCX: "AMEX", BATS: "CBOE" } as Record<string, string>)[instrument.exchangeMic];
  if (!exchange) return null;
  const ticker = instrument.symbol.replaceAll("-", ".");
  return { symbol: `${exchange}:${ticker}`, url: `https://jp.tradingview.com/symbols/${exchange}-${ticker}/` };
}

function businessDescription(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  if (typeof value === "string") return value;
  if (!record(value) || !Array.isArray(value.children) || value.children.length > 100) return undefined;
  const children = value.children.map(child => businessDescription(child, depth + 1));
  return children.some(child => child === undefined) ? undefined : children.join(" ");
}

/** Only the site's company-info payload is consumed: never SEO copy, news or user ideas. */
export function extractTradingViewJapaneseProfile(
  html: string,
  listing: { symbol: string; url: string },
  observedAt: string,
): JapaneseCompanyProfileText | null {
  let result: JapaneseCompanyProfileText | null = null;
  const scripts = html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/prs\.init-data\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    let payload: unknown;
    try { payload = JSON.parse(match[1]); } catch { continue; }
    if (!record(payload)) continue;
    for (const item of Object.values(payload)) {
      if (!record(item) || !record(item.context) || !record(item.context.request_context)
        || item.context.request_context.locale !== "ja" || !record(item.data) || !record(item.data.symbol)) continue;
      const company = item.data.symbol;
      if (company.pro_symbol !== listing.symbol || company.type !== "stock" || company.currency !== "USD") continue;
      const description = japaneseText(businessDescription(company.ast_business_description));
      const sector = japaneseText(company.sector, 200);
      const industry = japaneseText(company.industry, 200);
      if (!description && !sector && !industry) continue;
      const provenance = {
        providerId: "tradingview", sourceId: `tradingview:company-profile:${listing.symbol}:ja`,
        sourceUrl: listing.url, asOf: observedAt, ingestedAt: observedAt,
      };
      result = { ...(result ?? {}), ...(description ? { description, descriptionProvenance: provenance } : {}),
        ...(sector ? { sector } : {}), ...(industry ? { industry } : {}), provenance };
    }
  }
  return result;
}
