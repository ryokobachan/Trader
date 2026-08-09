import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./tooling/sites-vite-plugin.ts";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

const PROVIDER_BINDING_NAMES = [
  "UNICORN_INSTRUMENT_PROVIDER",
  "UNICORN_MARKET_PROVIDER",
  "UNICORN_BARS_PROVIDER",
  "UNICORN_PROFILE_PROVIDER",
  "UNICORN_FUNDAMENTALS_PROVIDER",
  "UNICORN_FUNDAMENTALS_PROVIDERS",
  "UNICORN_EARNINGS_PROVIDER",
  "UNICORN_ANALYST_PROVIDER",
  "UNICORN_NEWS_PROVIDER",
  "UNICORN_USAGE_MODE",
  "UNICORN_ENABLE_YAHOO_COMPAT",
  "UNICORN_YAHOO_TIMEOUT_MS",
  "UNICORN_TRADINGVIEW_SIDECAR_URL",
  "UNICORN_TRADINGVIEW_SIDECAR_TOKEN",
  "UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS",
  "UNICORN_TRADINGVIEW_MAX_CANDLES",
  "UNICORN_ALLOW_RESTRICTED_PUBLIC_DISPLAY",
  "FMP_API_KEY",
  "FMP_BASE_URL",
  "FMP_TIMEOUT_SECONDS",
  "SEC_EDGAR_USER_AGENT",
  "BENZINGA_API_TOKEN",
  "BENZINGA_API_KEY",
  "BENZINGA_TIMEOUT_SECONDS",
  "BENZINGA_ANALYST_RATINGS_ENDPOINT",
  "BENZINGA_ANALYST_RATINGS_DISABLED",
] as const;

// Local Cloudflare workers do not inherit arbitrary shell variables. Forward
// only the reviewed server-side provider allow-list as runtime bindings.
const providerBindings = Object.fromEntries(
  PROVIDER_BINDING_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }),
);

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  vars: providerBindings,
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
