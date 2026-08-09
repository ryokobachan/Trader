/**
 * Deployment-owned product identity.
 *
 * Keep user-visible brand values here so a self-hosted build can rebrand the
 * shell without searching through feature code. Brand artwork is deployment
 * owned and deliberately lives in public/ rather than feature code.
 */
export const UNICORN_BRAND = {
  name: "Unicorn",
  wordmark: "UNICORN",
  logoPath: "/unicorn-logo.png",
  metadataTitle: "Unicorn — Stock Analysis Workspace",
  description:
    "A customizable stock-analysis workspace for charts, fundamentals, analyst ratings, and strategies.",
  faviconPath: "/favicon.png",
  shareOrigin: "https://unicorn.local",
} as const;
