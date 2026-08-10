/**
 * Deployment-owned product identity.
 *
 * Keep user-visible brand values here so a self-hosted build can rebrand the
 * shell without searching through feature code. Brand artwork is deployment
 * owned and deliberately lives in public/ rather than feature code.
 *
 * The v3 artwork is the user-supplied transparent PNG (SHA-256
 * e94f959b2882dab682c50589b91b01cecd501855497ef97a685d94fb64e9a9a3).
 * Favicon variants are deterministic alpha-preserving resizes of that file.
 */
export const UNICORN_BRAND = {
  name: "Unicorn",
  wordmark: "UNICORN",
  logoPath: "/unicorn-logo-v3.png",
  metadataTitle: "Unicorn — Stock Analysis Workspace",
  description:
    "A customizable stock-analysis workspace for charts, fundamentals, analyst ratings, and strategies.",
  favicon16Path: "/favicon-unicorn-v3-16.png",
  favicon32Path: "/favicon-unicorn-v3-32.png",
  faviconIcoPath: "/favicon-unicorn-v3.ico",
  appleTouchIconPath: "/apple-touch-icon-unicorn-v3.png",
  shareOrigin: "https://unicorn.local",
} as const;
