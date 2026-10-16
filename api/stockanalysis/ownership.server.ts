import type { Instrument, OwnershipSnapshot } from "@/app/platform/provider-contracts";

const MAX_HTML_BYTES = 2_000_000;
const LABELS = {
  "Owned by Insiders (%)": ["insiderOwnership", "percent"],
  "Owned by Institutions (%)": ["institutionalOwnership", "percent"],
  "Short Interest": ["sharesShort", "shares"],
  "Short Previous Month": ["sharesShortPriorMonth", "shares"],
  "Short % of Shares Out": ["shortOutstandingRatio", "percent"],
  "Short % of Float": ["shortFloatRatio", "percent"],
  "Short Ratio (days to cover)": ["shortRatio", "ratio"],
} as const;

export class StockAnalysisOwnershipError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_response" | "timeout" | "upstream", readonly status?: number) {
    super(`Stock Analysis ownership ${code.replaceAll("_", " ")}.`);
    this.name = "StockAnalysisOwnershipError";
  }
}

function listing(instrument: Instrument) {
  const symbol = instrument.symbol.normalize("NFKC").trim().toUpperCase().replaceAll("-", ".");
  if (!/^[A-Z][A-Z0-9.]{0,14}$/.test(symbol) || instrument.currency !== "USD" || instrument.listingCountry !== "US") {
    throw new StockAnalysisOwnershipError("invalid_request");
  }
  return { symbol, url: `https://stockanalysis.com/stocks/${encodeURIComponent(symbol.toLowerCase())}/statistics/` };
}

function plain(html: string) {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&minus;|&#8722;/g, "−")
    .replace(/\s+/g, " ").trim();
}

function invalid(): never { throw new StockAnalysisOwnershipError("invalid_response"); }

function parsedNumber(text: string, kind: "percent" | "shares" | "ratio") {
  if (/^(?:n\/a|—|–|-)$/i.test(text)) return undefined;
  let value: number;
  if (kind === "percent") {
    if (!/^\d+(?:\.\d+)?%$/.test(text)) invalid();
    value = Number(text.slice(0, -1)) / 100;
  } else if (kind === "shares") {
    const match = /^(\d+(?:,\d{3})*(?:\.\d+)?)([KMBT])?$/.exec(text);
    if (!match) invalid();
    const multiplier = ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>)[match[2] ?? ""] ?? 1;
    value = Number(match[1].replaceAll(",", "")) * multiplier;
  } else {
    if (!/^\d+(?:\.\d+)?$/.test(text)) invalid();
    value = Number(text);
  }
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) invalid();
  return value;
}

/** Read only public table cells. Script data and subscription-only fields are ignored. */
export function extractStockAnalysisOwnership(html: string, instrument: Instrument, ingestedAt: string): OwnershipSnapshot {
  const { symbol, url } = listing(instrument);
  const document = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const title = plain(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(document)?.[1] ?? "");
  const titleSymbol = /\(([A-Z][A-Z0-9.-]*)\) Statistics\b/.exec(title)?.[1]?.replaceAll("-", ".");
  const canonical = [...document.matchAll(/<link\b([^>]+)>/gi)].find((match) => /\brel=["']canonical["']/i.test(match[1]))?.[1];
  const canonicalUrl = canonical ? /\bhref=["']([^"']+)["']/i.exec(canonical)?.[1] : undefined;
  if (titleSymbol !== symbol || canonicalUrl !== url || /Just a moment|Attention Required|Access Denied/i.test(title)) invalid();
  const values: Record<string, number> = {};
  const seen = new Set<string>();
  for (const table of document.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
      if (cells.length !== 2) continue;
      const label = plain(cells[0][2]);
      if (!Object.hasOwn(LABELS, label)) continue;
      if (seen.has(label)) invalid();
      seen.add(label);
      const [field, kind] = LABELS[label as keyof typeof LABELS];
      const visible = plain(cells[1][2]);
      // Never read hidden/paywalled values when the visible cell has no public number.
      const visibleValue = parsedNumber(visible, kind);
      if (visibleValue === undefined) continue;
      const titleValue = /\btitle=["']([^"']*)["']/i.exec(cells[1][1])?.[1];
      const preciseValue = titleValue ? parsedNumber(plain(titleValue), kind) : undefined;
      // Hover titles carry exact share counts, but must agree with the visible rounded value.
      if (preciseValue !== undefined && Math.abs(preciseValue - visibleValue) > Math.max(0.0001, Math.abs(visibleValue) * 0.005)) invalid();
      values[field] = preciseValue ?? visibleValue;
    }
  }
  if (seen.size === 0 || Object.keys(values).length === 0) invalid();
  return Object.freeze({
    ...values,
    // Page-wide last-updated labels are not the underlying short-interest reporting date.
    provenance: Object.freeze({
      providerId: "stockanalysis", sourceId: `stockanalysis:${symbol}:ownership`, sourceUrl: url,
      asOf: ingestedAt, ingestedAt,
    }),
  });
}

async function limitedHtml(response: Response) {
  if (Number(response.headers.get("content-length")) > MAX_HTML_BYTES) invalid();
  if (!response.body) invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_HTML_BYTES) {
        void reader.cancel().catch(() => undefined);
        invalid();
      }
      html += decoder.decode(chunk.value, { stream: true });
    }
    return html + decoder.decode();
  } finally { reader.releaseLock(); }
}

export function createStockAnalysisOwnershipClient(options: Readonly<{ fetch?: typeof globalThis.fetch; now?: () => Date; timeoutMs?: number }> = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(15_000, options.timeoutMs!)) : 10_000;
  return Object.freeze({ getOwnership: async (instrument: Instrument): Promise<OwnershipSnapshot> => {
    const { url } = listing(instrument);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new StockAnalysisOwnershipError("timeout"));
        controller.abort();
      }, timeoutMs);
    });
    const operation = async () => {
      const response = await fetchImplementation(url, {
        // Workerd does not implement redirect:error; manual + the status guard
        // preserves the same fixed-origin boundary on Node and Workers.
        redirect: "manual", signal: controller.signal,
        headers: { accept: "text/html", "user-agent": "Mozilla/5.0 TraderWorkspace/1.0" },
      });
      if (!response.ok) throw new StockAnalysisOwnershipError("upstream", response.status);
      return extractStockAnalysisOwnership(await limitedHtml(response), instrument, now().toISOString());
    };
    try { return await Promise.race([operation(), timeout]); }
    catch (error) {
      if (error instanceof StockAnalysisOwnershipError) throw error;
      throw new StockAnalysisOwnershipError("upstream");
    } finally { if (timer !== undefined) clearTimeout(timer); }
  } });
}
