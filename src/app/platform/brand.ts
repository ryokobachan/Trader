/**
 * Deployment-owned product identity.
 *
 * Keep user-visible brand values here so a self-hosted build can rebrand the
 * shell without searching through feature code. Brand artwork is deployment
 * owned and deliberately lives in public/ rather than feature code.
 *
 * The v5 artwork is the selected ribbon design, framed on a transparent 1024 px canvas (SHA-256
 * cb6970020b71677586c238490e9af910630a2337cb152239d96b504fe5839fa8).
 * Favicon variants are deterministic resizes of that file.
 */
export const TRADER_BRAND = {
  name: "Trader",
  wordmark: "TRADER",
  logoPath: "/trader-logo-v5.png",
  metadataTitle: "Trader — Stock Analysis Workspace",
  description:
    "A customizable stock-analysis workspace for charts, fundamentals, analyst ratings, and strategies.",
  favicon16Path: "/favicon-trader-v5-16.png",
  favicon32Path: "/favicon-trader-v5-32.png",
  faviconIcoPath: "/favicon-trader-v5.ico",
  appleTouchIconPath: "/apple-touch-icon-trader-v5.png",
  shareOrigin: "https://trader.local",
} as const;
