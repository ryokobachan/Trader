import { readFileSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SIDECAR_PATH = path.join(PROJECT_ROOT, "api", "tradingview-websocket", "sidecar.py");
const LOCAL_PROVIDER_PROFILE = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "api", "local-provider-profile.json"), "utf8"));
const LOCAL_PROVIDER_ENVIRONMENT = Object.fromEntries(Object.entries(LOCAL_PROVIDER_PROFILE)
  .map(([role, provider]) => [`TRADER_${role.toUpperCase()}_PROVIDER`, provider]));

export function tradingViewDevelopmentProfile(baseEnvironment, token, port = 8791) {
  return {
    ...baseEnvironment,
    TRADER_MARKET_PROVIDER: "tradingview-websocket",
    TRADER_BARS_PROVIDER: "tradingview-websocket",
    TRADER_TRADINGVIEW_SIDECAR_URL: `http://127.0.0.1:${port}`,
    TRADER_TRADINGVIEW_SIDECAR_TOKEN: token,
    TRADER_TRADINGVIEW_SIDECAR_TIMEOUT_MS:
      baseEnvironment.TRADER_TRADINGVIEW_SIDECAR_TIMEOUT_MS ?? "25000",
    TRADER_TRADINGVIEW_MAX_CANDLES:
      baseEnvironment.TRADER_TRADINGVIEW_MAX_CANDLES ?? "10000",
  };
}

export function selectedDevelopmentProfile(argv = process.argv.slice(2), environment = process.env) {
  const explicit = argv.find((argument) => argument.startsWith("--profile="))?.slice("--profile=".length);
  if (explicit === "yahoo") return "yahoo";
  // Preserve old LaunchAgent/npm arguments as aliases without reading Midas.
  if (explicit === "midas" || explicit === "standalone") return "standalone";
  void environment;
  return "standalone";
}

export function standaloneDevelopmentEnvironment(environment) {
  const own = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("MIDAS_") && !key.startsWith("FMP_")));
  return {
    TRADER_USAGE_MODE: "personal", TRADER_ENABLE_YAHOO_COMPAT: "true",
    ...LOCAL_PROVIDER_ENVIRONMENT,
    ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== "")),
    TRADER_SHARED_DATA_ROOT: own.TRADER_SHARED_DATA_ROOT?.trim() || path.resolve(PROJECT_ROOT, "..", ".data"),
  };
}

function childCommand(profile) {
  return {
    executable: process.platform === "win32" ? "npm.cmd" : "npm",
    args: profile === "standalone" ? ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3001"]
      : ["run", "dev:yahoo:app"],
  };
}

export function isTradingViewSidecarHealth(payload) {
  return Boolean(
    payload
    && payload.schemaVersion === "trader.tradingview-sidecar.v1"
    && payload.status === "ok"
    && payload.backend === "tradingview-websocket"
  );
}

async function waitUntilHealthy(url, token, sidecar) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (sidecar.exitCode !== null) throw new Error("sidecar_exit");
    try {
      const response = await fetch(new URL("/healthz", url), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (isTradingViewSidecarHealth(payload)) return;
      }
    } catch {
      // The process may still be importing its dependency. Retry until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("sidecar_timeout");
}

export function findAvailableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function forwardAndCleanUp(children) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      for (const child of children) {
        if (!child.killed && child.exitCode === null) child.kill(signal);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

async function run() {
  const profile = selectedDevelopmentProfile();
  let ownSettings = {};
  if (profile === "standalone") {
    try { ownSettings = parseEnv(await readFile(path.join(PROJECT_ROOT, ".env.local"), "utf8")); }
    catch (error) { if (error?.code !== "ENOENT") throw new Error("Trader's local configuration could not be read."); }
  }
  const baseEnvironment = profile === "standalone" ? standaloneDevelopmentEnvironment({ ...ownSettings, ...process.env }) : process.env;
  const configuredPort = baseEnvironment.TRADER_TRADINGVIEW_SIDECAR_PORT?.trim();
  const portValue = Number(configuredPort);
  const port = configuredPort && Number.isInteger(portValue) && portValue >= 1 && portValue <= 65_535
    ? portValue
    : await findAvailableLoopbackPort();
  const token = randomBytes(32).toString("base64url");
  const environment = tradingViewDevelopmentProfile(baseEnvironment, token, port);
  const python = baseEnvironment.TRADER_TRADINGVIEW_PYTHON?.trim() || "python3";
  const sidecar = spawn(python, [SIDECAR_PATH, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: PROJECT_ROOT,
    env: environment,
    shell: false,
    stdio: "inherit",
  });
  sidecar.once("error", () => {
    process.stderr.write("TradingView sidecar could not be started.\n");
  });

  try {
    await waitUntilHealthy(environment.TRADER_TRADINGVIEW_SIDECAR_URL, token, sidecar);
  } catch {
    if (!sidecar.killed && sidecar.exitCode === null) sidecar.kill("SIGTERM");
    throw new Error("TradingView sidecar did not become ready.");
  }

  const command = childCommand(profile);
  const app = spawn(command.executable, command.args, {
    cwd: PROJECT_ROOT,
    env: environment,
    shell: false,
    stdio: "inherit",
  });
  const removeHandlers = forwardAndCleanUp([app, sidecar]);

  const exitCode = await new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    };
    app.once("error", () => {
      process.stderr.write("Trader development server could not be started.\n");
      finish(1);
    });
    app.once("exit", (code) => finish(code));
    sidecar.once("exit", (code) => {
      if (app.exitCode === null && !app.killed) {
        process.stderr.write("TradingView sidecar stopped unexpectedly.\n");
        app.kill("SIGTERM");
        finish(code || 1);
      }
    });
  });

  removeHandlers();
  if (!app.killed && app.exitCode === null) app.kill("SIGTERM");
  if (!sidecar.killed && sidecar.exitCode === null) sidecar.kill("SIGTERM");
  process.exitCode = exitCode;
}

const isDirectExecution = Boolean(
  process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectExecution) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Development startup failed."}\n`);
    process.exitCode = 1;
  });
}
