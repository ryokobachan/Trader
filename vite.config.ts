import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { PROVIDER_ENVIRONMENT_KEYS } from "./api/environment.ts";
import { sites } from "./src/tooling/sites-vite-plugin.ts";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// Local Cloudflare workers do not inherit arbitrary shell variables. Forward
// only the reviewed server-side provider allow-list as runtime bindings.
const providerBindings = Object.fromEntries(
  PROVIDER_ENVIRONMENT_KEYS.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }),
);

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./src/worker/index.ts",
  compatibility_flags: ["nodejs_compat", "enable_request_signal"],
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
  process.env.X_LOCAL_OBSERVABILITY ??= "false";
  process.env.WRANGLER_LOG_PATH ??= "var/cloudflare/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= "var/cloudflare/registry";

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
        // Runtime state belongs in ignored var/, never beside source or migrations.
        persistState: { path: "var/cloudflare" },
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
