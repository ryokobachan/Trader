/**
 * Deployment-owned product identity.
 *
 * Keep user-visible brand values here so a self-hosted build can rebrand the
 * shell without searching through feature code. Brand artwork is deployment
 * owned and deliberately lives in public/ rather than feature code.
 *
 * The v3 artwork is the user-supplied 1024 px PNG (SHA-256
 * 407f2a3b6c6132ba61d1572790196ba22398634aed6e76fa30e2843de20e5a9d).
 * Favicon variants are deterministic resizes of that file.
 */
export const TRADER_BRAND = {
  name: "Trader",
  wordmark: "TRADER",
  logoPath: "/trader-logo-v3.png",
  metadataTitle: "Trader — Stock Analysis Workspace",
  description:
    "A customizable stock-analysis workspace for charts, fundamentals, analyst ratings, and strategies.",
  favicon16Path: "/favicon-trader-v3-16.png",
  favicon32Path: "/favicon-trader-v3-32.png",
  faviconIcoPath: "/favicon-trader-v3.ico",
  appleTouchIconPath: "/apple-touch-icon-trader-v3.png",
  shareOrigin: "https://trader.local",
} as const;
