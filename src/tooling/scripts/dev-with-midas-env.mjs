import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const MIDAS_ENV_ALLOWLIST = Object.freeze([
  "FMP_API_KEY",
  "FMP_BASE_URL",
  "FMP_TIMEOUT_SECONDS",
  "BENZINGA_API_TOKEN",
  "BENZINGA_API_KEY",
  "BENZINGA_TIMEOUT_SECONDS",
  "BENZINGA_ANALYST_RATINGS_ENDPOINT",
  "BENZINGA_ANALYST_RATINGS_DISABLED",
]);

const MIDAS_ENV_ALLOWLIST_SET = new Set(MIDAS_ENV_ALLOWLIST);

const TRADER_DEVELOPMENT_DEFAULTS = Object.freeze({
  TRADER_USAGE_MODE: "personal",
  TRADER_ENABLE_YAHOO_COMPAT: "true",
  TRADER_INSTRUMENT_PROVIDER: "yahoo",
  TRADER_MARKET_PROVIDER: "yahoo",
  TRADER_PROFILE_PROVIDER: "fmp",
  TRADER_FUNDAMENTALS_PROVIDER: "fmp",
  TRADER_EARNINGS_PROVIDER: "fmp",
  TRADER_ANALYST_PROVIDER: "benzinga",
  TRADER_NEWS_PROVIDER: "yahoo",
});

function decodeDoubleQuotedValue(value) {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\" || index === value.length - 1) {
      decoded += character;
      continue;
    }

    index += 1;
    const escaped = value[index];
    if (escaped === "n") decoded += "\n";
    else if (escaped === "r") decoded += "\r";
    else if (escaped === "t") decoded += "\t";
    else decoded += escaped;
  }
  return decoded;
}

function parseQuotedValue(rawValue, quote) {
  let escaped = false;
  for (let index = 1; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) {
      const remainder = rawValue.slice(index + 1).trim();
      if (remainder && !remainder.startsWith("#")) return null;
      const value = rawValue.slice(1, index);
      return quote === '"' ? decodeDoubleQuotedValue(value) : value;
    }
    escaped = false;
  }
  return null;
}

function parseUnquotedValue(rawValue) {
  for (let index = 0; index < rawValue.length; index += 1) {
    if (
      rawValue[index] === "#"
      && (index === 0 || /\s/.test(rawValue[index - 1]))
    ) {
      return rawValue.slice(0, index).trim();
    }
  }
  return rawValue.trim();
}

/**
 * Parse only the small, explicitly allowed subset of a dotenv file.
 *
 * Unsupported or malformed lines are ignored and values are never expanded.
 * This keeps unrelated Midas credentials out of the Trader process.
 */
export function parseMidasEnv(contents) {
  const parsed = {};
  const normalizedContents = String(contents).replace(/^\uFEFF/, "");

  for (const sourceLine of normalizedContents.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (!MIDAS_ENV_ALLOWLIST_SET.has(key)) continue;

    const trimmedValue = rawValue.trim();
    let value;
    if (trimmedValue.startsWith('"')) {
      value = parseQuotedValue(trimmedValue, '"');
    } else if (trimmedValue.startsWith("'")) {
      value = parseQuotedValue(trimmedValue, "'");
    } else {
      value = parseUnquotedValue(trimmedValue);
    }

    if (value !== null) parsed[key] = value;
  }

  return parsed;
}

/**
 * Merge the allowlisted Midas values into a child-process environment.
 * Existing values win, and the source dotenv path is deliberately removed.
 */
export function mergeMidasEnv(baseEnvironment, parsedMidasEnvironment) {
  const merged = { ...baseEnvironment };
  delete merged.MIDAS_ENV_FILE;

  for (const key of MIDAS_ENV_ALLOWLIST) {
    if (
      merged[key] === undefined
      && typeof parsedMidasEnvironment[key] === "string"
    ) {
      merged[key] = parsedMidasEnvironment[key];
    }
  }

  for (const [key, value] of Object.entries(TRADER_DEVELOPMENT_DEFAULTS)) {
    if (merged[key] === undefined) merged[key] = value;
  }

  return merged;
}

async function runDevelopmentServer() {
  const envFile = process.env.MIDAS_ENV_FILE;
  if (!envFile) {
    throw new Error("MIDAS_ENV_FILE is required.");
  }

  let contents;
  try {
    contents = await readFile(envFile, "utf8");
  } catch {
    throw new Error("The configured Midas environment file could not be read.");
  }

  const child = spawn("npm", ["run", "dev", "--", "--port", "3001"], {
    env: mergeMidasEnv(process.env, parseMidasEnv(contents)),
    stdio: "inherit",
  });

  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map();

  for (const signal of forwardedSignals) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
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
    process.stderr.write("Trader development server could not be started.\n");
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    removeSignalHandlers();
    if (signal) {
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

if (isDirectExecution) {
  runDevelopmentServer().catch((error) => {
    const message = error instanceof Error
      ? error.message
      : "Trader development server could not be started.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
