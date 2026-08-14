import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "next-env.d.ts",
    // Generated application and desktop build outputs:
    "dist/**",
    "src/desktop/frontend-dist/**",
    "src/desktop/tauri/target/**",
    "src/desktop/tauri/gen/**",
    "src/desktop/runtime/tradingview-sidecar/.venv/**",
    "src/desktop/runtime/tradingview-sidecar/build/**",
    "src/desktop/runtime/tradingview-sidecar/dist/**",
  ]),
]);

export default eslintConfig;
