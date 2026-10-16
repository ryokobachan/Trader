import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const YAHOO_DEVELOPMENT_PROFILE = Object.freeze({
  TRADER_USAGE_MODE: "personal",
  TRADER_ENABLE_YAHOO_COMPAT: "true",
  TRADER_INSTRUMENT_PROVIDER: "yahoo",
  TRADER_MARKET_PROVIDER: "tradingview-websocket",
  TRADER_PROFILE_PROVIDER: "yahoo",
  TRADER_FUNDAMENTALS_PROVIDER: "yahoo",
  TRADER_EARNINGS_PROVIDER: "yahoo",
  TRADER_RESEARCH_PROVIDER: "yahoo",
  TRADER_ANALYST_PROVIDER: "google-finance-benzinga",
  TRADER_NEWS_PROVIDER: "yahoo",
});

function isMidasOrFmpVariable(key) {
  return key === "MIDAS_ENV_FILE"
    || key.startsWith("MIDAS_")
    || key.startsWith("FMP_");
}

/**
 * Build a keyless, personal-use child environment for the Yahoo adapters.
 *
 * Provider choices are intentionally forced so an existing terminal profile
 * cannot silently turn this command into an FMP-backed session. Midas/FMP
 * variables are removed by name without inspecting or logging their values.
 */
export function buildYahooDevelopmentEnvironment(baseEnvironment) {
  const environment = {};

  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (!isMidasOrFmpVariable(key)) environment[key] = value;
  }

  return {
    ...environment,
    ...YAHOO_DEVELOPMENT_PROFILE,
  };
}

/** Return argv separately so command construction stays shell-free and testable. */
export function yahooDevelopmentCommand(platform = process.platform) {
  return Object.freeze({
    executable: platform === "win32" ? "npm.cmd" : "npm",
    args: Object.freeze(["run", "dev", "--", "--port", "3001"]),
  });
}

function runDevelopmentServer() {
  const { executable, args } = yahooDevelopmentCommand();
  const child = spawn(executable, args, {
    env: buildYahooDevelopmentEnvironment(process.env),
    shell: false,
    stdio: "inherit",
  });

  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map();

  for (const signal of forwardedSignals) {
    const handler = () => {
      if (child.killed) return;
      try {
        child.kill(signal);
      } catch {
        child.kill();
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  };

  child.once("error", () => {
    removeSignalHandlers();
    process.stderr.write("Trader Yahoo development server could not be started.\n");
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    removeSignalHandlers();
    if (signal && process.platform !== "win32") {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

const isDirectExecution = Boolean(
  process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectExecution) runDevelopmentServer();
