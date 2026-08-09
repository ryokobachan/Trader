/**
 * Deployment-owned, non-secret build-time configuration.
 *
 * Developers customize this file to select reviewed modules and providers.
 * API keys remain in `.env.local`; never add them here or expose them through
 * a `NEXT_PUBLIC_*` variable.
 */
export const unicornConfig = {
  universe: {
    policyId: "us_equity_v1",
  },
  providers: {
    instrument: "mock",
    market: "mock",
    bars: null,
    fundamentals: null,
    analyst: null,
    news: null,
  },
  ui: {
    symbolSummary: {
      density: "compact",
      modules: [
        "core.identity_quote@1.0.0",
        "core.price_range@1.0.0",
        "core.key_statistics@1.0.0",
        "core.earnings@1.0.0",
        "core.financials@1.0.0",
        "core.performance@1.0.0",
        "core.technical_rating@1.0.0",
        "core.analyst_consensus@1.0.0",
        "core.company_profile@1.0.0",
      ],
    },
  },
} as const;

export type UnicornConfig = typeof unicornConfig;
