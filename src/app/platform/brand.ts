/**
 * Deployment-owned product identity.
 *
 * Keep user-visible brand values here so a self-hosted build can rebrand the
 * shell without searching through feature code. Brand artwork is deployment
 * owned and deliberately lives in public/ rather than feature code.
 *
 * The v4 artwork is a tightly framed transparent 1024 px PNG (SHA-256
 * 1680c2e61cfe3cda9eeba7fbcf36377a0769bf2629c1f557f3a435399f3380da).
 * Favicon variants are deterministic resizes of that file.
 */
export const TRADER_BRAND = {
  name: "Trader",
  wordmark: "TRADER",
  logoPath: "/trader-logo-v4.png",
  metadataTitle: "Trader — Stock Analysis Workspace",
  description:
    "A customizable stock-analysis workspace for charts, fundamentals, analyst ratings, and strategies.",
  favicon16Path: "/favicon-trader-v4-16.png",
  favicon32Path: "/favicon-trader-v4-32.png",
  faviconIcoPath: "/favicon-trader-v4.ico",
  appleTouchIconPath: "/apple-touch-icon-trader-v4.png",
  shareOrigin: "https://trader.local",
} as const;
