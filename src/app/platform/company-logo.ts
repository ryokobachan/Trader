/**
 * Core-owned company-logo policy.
 *
 * The market/fundamentals providers return canonical data and never decide
 * which arbitrary remote images the browser may load. Developers can replace
 * this resolver (and its allow-list) without changing CompanyLogo or page code.
 * The default resolver uses FMP's keyless symbol-logo endpoint; failed or
 * missing images remain a UI concern and fall back to the stock monogram.
 */
export const COMPANY_LOGO_POLICY = Object.freeze({
  remoteOrigins: Object.freeze(["https://financialmodelingprep.com"]),
  localAssetPattern: /^\/company-logos\/[a-z0-9][a-z0-9-]*\.(?:png|svg|webp)$/,
  remoteAssetPattern: /^\/image-stock\/[A-Z][A-Z0-9-]{0,14}\.png$/,
});

function normalizedUSStockSymbol(value: string): string | null {
  const symbol = value
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/[./]/g, "-");
  return /^[A-Z][A-Z0-9-]{0,14}$/.test(symbol) ? symbol : null;
}

export function companyLogoPathForUSStock(symbol: string): string | undefined {
  const normalized = normalizedUSStockSymbol(symbol);
  if (!normalized) return undefined;
  return `${COMPANY_LOGO_POLICY.remoteOrigins[0]}/image-stock/${normalized}.png`;
}

/**
 * Treat logo paths as untrusted provider data at the final browser boundary.
 * Only reviewed bundled files and exact HTTPS origin/path combinations pass.
 */
export function safeCompanyLogoSource(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  if (COMPANY_LOGO_POLICY.localAssetPattern.test(candidate)) return candidate;

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
      || !COMPANY_LOGO_POLICY.remoteOrigins.includes(url.origin)
      || !COMPANY_LOGO_POLICY.remoteAssetPattern.test(url.pathname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
