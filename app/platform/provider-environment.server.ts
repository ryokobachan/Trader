import type { ProviderEnvironment } from "./provider-contracts";

let runtimeBindings: Readonly<Record<string, unknown>> = Object.freeze({});

/** Called by the worker entry for each request before route dispatch. */
export function installProviderEnvironmentBindings(bindings: Readonly<Record<string, unknown>>) {
  runtimeBindings = bindings;
}

function binding(name: string, nodeValue: string | undefined) {
  const value = runtimeBindings[name];
  return typeof value === "string" ? value : nodeValue;
}

/**
 * Vinext can keep statically addressed environment variables server-only.
 * Keep this allow-list explicit: dynamic `process.env` access is not portable
 * to the Cloudflare worker runtime and makes secret review impossible.
 */
export function providerEnvironment(): ProviderEnvironment {
  return Object.freeze({
    UNICORN_INSTRUMENT_PROVIDER: binding("UNICORN_INSTRUMENT_PROVIDER", process.env.UNICORN_INSTRUMENT_PROVIDER),
    UNICORN_MARKET_PROVIDER: binding("UNICORN_MARKET_PROVIDER", process.env.UNICORN_MARKET_PROVIDER),
    UNICORN_BARS_PROVIDER: binding("UNICORN_BARS_PROVIDER", process.env.UNICORN_BARS_PROVIDER),
    UNICORN_PROFILE_PROVIDER: binding("UNICORN_PROFILE_PROVIDER", process.env.UNICORN_PROFILE_PROVIDER),
    UNICORN_FUNDAMENTALS_PROVIDER: binding("UNICORN_FUNDAMENTALS_PROVIDER", process.env.UNICORN_FUNDAMENTALS_PROVIDER),
    UNICORN_FUNDAMENTALS_PROVIDERS: binding("UNICORN_FUNDAMENTALS_PROVIDERS", process.env.UNICORN_FUNDAMENTALS_PROVIDERS),
    UNICORN_EARNINGS_PROVIDER: binding("UNICORN_EARNINGS_PROVIDER", process.env.UNICORN_EARNINGS_PROVIDER),
    UNICORN_ANALYST_PROVIDER: binding("UNICORN_ANALYST_PROVIDER", process.env.UNICORN_ANALYST_PROVIDER),
    UNICORN_NEWS_PROVIDER: binding("UNICORN_NEWS_PROVIDER", process.env.UNICORN_NEWS_PROVIDER),
    UNICORN_USAGE_MODE: binding("UNICORN_USAGE_MODE", process.env.UNICORN_USAGE_MODE),
    UNICORN_ENABLE_YAHOO_COMPAT: binding("UNICORN_ENABLE_YAHOO_COMPAT", process.env.UNICORN_ENABLE_YAHOO_COMPAT),
    UNICORN_YAHOO_TIMEOUT_MS: binding("UNICORN_YAHOO_TIMEOUT_MS", process.env.UNICORN_YAHOO_TIMEOUT_MS),
    UNICORN_TRADINGVIEW_SIDECAR_URL: binding("UNICORN_TRADINGVIEW_SIDECAR_URL", process.env.UNICORN_TRADINGVIEW_SIDECAR_URL),
    UNICORN_TRADINGVIEW_SIDECAR_TOKEN: binding("UNICORN_TRADINGVIEW_SIDECAR_TOKEN", process.env.UNICORN_TRADINGVIEW_SIDECAR_TOKEN),
    UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS: binding("UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS", process.env.UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS),
    UNICORN_TRADINGVIEW_MAX_CANDLES: binding("UNICORN_TRADINGVIEW_MAX_CANDLES", process.env.UNICORN_TRADINGVIEW_MAX_CANDLES),
    UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES: binding("UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES", process.env.UNICORN_TRADINGVIEW_SYNTHETIC_EXCHANGES),
    UNICORN_ALLOW_RESTRICTED_PUBLIC_DISPLAY: binding("UNICORN_ALLOW_RESTRICTED_PUBLIC_DISPLAY", process.env.UNICORN_ALLOW_RESTRICTED_PUBLIC_DISPLAY),
    FMP_API_KEY: binding("FMP_API_KEY", process.env.FMP_API_KEY),
    FMP_BASE_URL: binding("FMP_BASE_URL", process.env.FMP_BASE_URL),
    FMP_TIMEOUT_SECONDS: binding("FMP_TIMEOUT_SECONDS", process.env.FMP_TIMEOUT_SECONDS),
    SEC_EDGAR_USER_AGENT: binding("SEC_EDGAR_USER_AGENT", process.env.SEC_EDGAR_USER_AGENT),
    BENZINGA_API_TOKEN: binding("BENZINGA_API_TOKEN", process.env.BENZINGA_API_TOKEN),
    BENZINGA_API_KEY: binding("BENZINGA_API_KEY", process.env.BENZINGA_API_KEY),
    BENZINGA_TIMEOUT_SECONDS: binding("BENZINGA_TIMEOUT_SECONDS", process.env.BENZINGA_TIMEOUT_SECONDS),
    BENZINGA_ANALYST_RATINGS_ENDPOINT: binding("BENZINGA_ANALYST_RATINGS_ENDPOINT", process.env.BENZINGA_ANALYST_RATINGS_ENDPOINT),
    BENZINGA_ANALYST_RATINGS_DISABLED: binding("BENZINGA_ANALYST_RATINGS_DISABLED", process.env.BENZINGA_ANALYST_RATINGS_DISABLED),
  });
}
