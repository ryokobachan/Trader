import { safeCompanyLogoSource } from "@/app/platform/company-logo";

const MAX_CACHE_ITEMS = 512;
const cache = new Map<string, { source: string | null; expiresAt: number }>();
const inflight = new Map<string, Promise<string | null>>();

export async function resolveTradingViewLogo(
  symbol: string,
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || symbol.includes("..")) return null;
  const shared = fetchImplementation === globalThis.fetch;
  const saved = shared ? cache.get(symbol) : undefined;
  if (saved && saved.expiresAt > Date.now()) return saved.source;
  const pending = shared ? inflight.get(symbol) : undefined;
  if (pending) return pending;
  const load = async () => {
    const sourceSymbol = symbol.replace(/-([A-Z])$/, ".$1");
    const tickers = ["NASDAQ", "NYSE", "AMEX"].map(exchange => `${exchange}:${sourceSymbol}`);
    const response = await fetchImplementation.call(globalThis, "https://scanner.tradingview.com/america/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: { tickers }, columns: ["name", "logoid"] }),
      signal: AbortSignal.timeout(8_000),
      redirect: "manual",
    });
    if (!response.ok) throw new Error("Logo source unavailable");
    const body = await response.text();
    if (body.length > 64_000) throw new Error("Unexpected logo response");
    const payload = JSON.parse(body) as { data?: { s?: string; d?: unknown[] }[] };
    if (!Array.isArray(payload.data)) throw new Error("Unexpected logo response");
    let source: string | null = null;
    for (const row of payload.data) {
      if (!row.s || !tickers.includes(row.s) || row.d?.[0] !== sourceSymbol) continue;
      const id = row.d[1];
      if (typeof id !== "string" || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(id)) continue;
      source = safeCompanyLogoSource(`https://s3-symbol-logo.tradingview.com/${id}.svg`);
      if (source) break;
    }
    if (shared) {
      if (cache.size >= MAX_CACHE_ITEMS) cache.delete(cache.keys().next().value!);
      cache.set(symbol, { source, expiresAt: Date.now() + (source ? 86_400_000 : 300_000) });
    }
    return source;
  };
  const promise = load().finally(() => { if (shared) inflight.delete(symbol); });
  if (shared && inflight.size < MAX_CACHE_ITEMS) inflight.set(symbol, promise);
  return promise;
}
