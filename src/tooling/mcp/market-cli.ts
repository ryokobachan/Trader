import { readToolDefinitions, ToolDefinitionError } from "./definitions";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { installProviderEnvironmentBindings } from "../../app/platform/provider-environment.server";
import { createTraderMcpServer, McpConfigurationError, type McpDataReader } from "./server";
import { createMarketReader } from "./market-reader";
import { TraderDataError } from "../../../clients/javascript/trader-data.mjs";

const folder = dirname(fileURLToPath(import.meta.url));
const pythonCache = join(homedir(), ".cache", "trader-market", "python", "bin", "python");

// Deliberate personal/local defaults; never read Trader config files, env files or stores.
const providers = {
  TRADER_INSTRUMENT_PROVIDER: "yahoo", TRADER_MARKET_PROVIDER: "tradingview-websocket",
  TRADER_BARS_PROVIDER: "tradingview-websocket", TRADER_PROFILE_PROVIDER: "yahoo",
  TRADER_FUNDAMENTALS_PROVIDER: "tradingview", TRADER_EARNINGS_PROVIDER: "google-finance-earnings",
  TRADER_RESEARCH_PROVIDER: "yahoo", TRADER_ANALYST_PROVIDER: "google-finance-benzinga",
  TRADER_NEWS_PROVIDER: "yahoo", TRADER_USAGE_MODE: "personal", TRADER_ENABLE_YAHOO_COMPAT: "true",
};

function python(setup = false) {
  return process.env.MARKET_PYTHON ?? (!setup && existsSync(pythonCache) ? pythonCache : "python3");
}

function standaloneReader(timeout: number): { reader: McpDataReader; close(): void } {
  let child: ChildProcess | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  installProviderEnvironmentBindings(providers);
  const reader = createMarketReader(timeout);
  const close = () => {
    closed = true;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Our child already exited. */ }
    }
  };
  function ensureHelper(): Promise<void> {
    if (closed) return Promise.reject(new TraderDataError("cancelled", "Market MCP has closed."));
    if (starting) return starting;
    starting = new Promise<void>((resolve, reject) => {
      const token = Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, "0")).join("");
      // -B keeps all distributed files text-only. Child gets no inherited Trader secrets/settings.
      const helper = spawn(python(), ["-B", join(folder, "src", "market.py")], {
        cwd: folder, detached: true, stdio: ["pipe", "pipe", "pipe"],
        env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR, PYTHONDONTWRITEBYTECODE: "1" },
      });
      child = helper;
      let ready = false;
      let received = "";
      const fail = () => {
        clearTimeout(timer);
        reject(new TraderDataError("market_runtime_unavailable", "Market Python runtime is unavailable. Ask Codex to run server.mjs --setup, or set MARKET_PYTHON to a Python with requirements.txt installed."));
      };
      const timer = setTimeout(() => { close(); fail(); }, 20_000);
      helper.on("error", fail);
      helper.on("exit", () => {
        if (!ready) fail();
        starting = undefined;
      });
      // Discard upstream library diagnostics rather than leaking data to protocol stdout/logs.
      helper.stderr?.resume();
      helper.stdin?.on("error", fail);
      helper.stdout?.on("data", chunk => {
        if (ready) return;
        received += String(chunk);
        if (received.length > 1024) { close(); fail(); return; }
        if (!received.includes("\n")) return;
        try {
          const { port } = JSON.parse(received.split("\n", 1)[0]) as { port: number };
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
          installProviderEnvironmentBindings({ ...providers, TRADER_TRADINGVIEW_SIDECAR_URL: `http://127.0.0.1:${port}`, TRADER_TRADINGVIEW_SIDECAR_TOKEN: token });
          ready = true;
          clearTimeout(timer);
          resolve();
        } catch { close(); fail(); }
      });
      helper.stdin?.write(token + "\n");
    });
    return starting;
  }
  return {
    close,
    reader: { async get(dataset, args, options) {
      const deadline = AbortSignal.timeout(timeout);
      const signal = AbortSignal.any([options.signal, deadline]);
      const stopped = () => new TraderDataError(deadline.aborted ? "timeout" : "cancelled", "Market request stopped.");
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(stopped());
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
      const read = async () => {
        if (signal.aborted) throw stopped();
        if (["quote", "bars", "workspace", "financials", "profile", "fundamentals", "earnings", "analyst", "news", "research", "corporate-actions", "analyst-ratings", "technical-indicators", "technicals", "usaspending"].includes(dataset)) await ensureHelper();
        if (signal.aborted) throw stopped();
        return reader.get(dataset, args, { signal });
      };
      try { return await Promise.race([read(), cancelled]); }
      finally { signal.removeEventListener("abort", abort); }
    } },
  };
}

export async function startMarketMcp(args = process.argv.slice(2)) {
  try {
    if (args.length === 1 && args[0] === "--help") {
      process.stdout.write("Trader Market：独立動作する読み取り専用MCP。Traderは不要です。\nNode.js 22.13以上・Python 3.10以上・src/requirements.txtのライブラリが必要です。\n--setup：Pythonライブラリをホームのキャッシュへ導入します。\n--timeout-ms <1..120000>：取得タイムアウト。既定60000ミリ秒。\nMARKET_PYTHONでPythonのパスを指定できます。--base-urlは使いません。\n");
      return;
    }
    if (args.length === 1 && args[0] === "--setup") {
      const setup = spawn(python(true), ["-B", join(folder, "src", "market.py"), "--setup"], { stdio: "inherit" });
      process.exitCode = await new Promise<number>(resolve => { setup.once("error", () => resolve(1)); setup.once("exit", code => resolve(code ?? 1)); });
      return;
    }
    if (args.length && (args.length !== 2 || args[0] !== "--timeout-ms")) throw new McpConfigurationError("Market supports only --setup or --timeout-ms <integer>; it does not use a Trader URL.");
    const value = args[1] ?? process.env.TRADER_MCP_TIMEOUT_MS ?? "60000";
    if (!/^\d+$/.test(value) || +value < 1 || +value > 120000) throw new McpConfigurationError("--timeout-ms must be an integer from 1 to 120000.");
    const definitions = readToolDefinitions("market", new URL("./tools.yaml", import.meta.url));
    const runtime = standaloneReader(+value);
    const handle = serveStdio(() => {
      const server = createTraderMcpServer("market", { reader: runtime.reader, definitions });
      const previous = server.server.onclose;
      server.server.onclose = () => { previous?.(); runtime.close(); };
      return server;
    }, { onerror: () => process.stderr.write("Market MCP protocol error.\n") });
    const close = () => { runtime.close(); void handle.close(); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    process.stdin.once("end", close);
    process.once("exit", runtime.close);
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: { code: "mcp_startup_error", message: error instanceof McpConfigurationError || error instanceof ToolDefinitionError ? error.message : "Market MCP could not start." } }) + "\n");
    process.exitCode = 1;
  }
}
