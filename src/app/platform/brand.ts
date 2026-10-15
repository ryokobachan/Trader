/**
 * Deployment-owned product identity.
 *
 * Keep user-visible brand values here so a self-hosted build can rebrand the
 * shell without searching through feature code. Brand artwork is deployment
 * owned and deliberately lives in public/ rather than feature code.
 *
 * The v6 artwork contains only the ribbon foreground on a transparent 1024 px canvas (SHA-256
 * 1407452f607c3296bfc752ba3ef58c677c17e90463a54d9a5f981e6084fc50b2).
 * Favicon variants are deterministic resizes of that file.
 */
export const TRADER_BRAND = {
  name: "Trader",
  wordmark: "TRADER",
  logoPath: "/trader-logo-v6.png",
  metadataTitle: "Trader — Stock Analysis Workspace",
  description:
    "A customizable stock-analysis workspace for charts, fundamentals, analyst ratings, and strategies.",
  favicon16Path: "/favicon-trader-v6-16.png",
  favicon32Path: "/favicon-trader-v6-32.png",
  faviconIcoPath: "/favicon-trader-v6.ico",
  appleTouchIconPath: "/apple-touch-icon-trader-v6.png",
  shareOrigin: "https://trader.local",
} as const;
