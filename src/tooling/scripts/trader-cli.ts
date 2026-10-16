import { pathToFileURL } from "node:url";
import { dataOpenApi, describeData, discoverData } from "../../../api/data/discovery";
import { DataRequestError, dataDefinition, prepareDataRequest } from "../../../api/data/request";
import { runStrategyCli, type StrategyCliDependencies } from "./strategy-cli";

type Writer = { write(value: string): unknown };
export type TraderCliDependencies = {
  fetch: typeof globalThis.fetch;
  stdout: Writer;
  stderr: Writer;
  env: Readonly<Record<string, string | undefined>>;
  strategy?: (args: readonly string[]) => Promise<number>;
};
const defaults: TraderCliDependencies = { fetch: globalThis.fetch, stdout: process.stdout, stderr: process.stderr, env: process.env };
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const HELP = `Trader CLI

Usage:
  trader data sources [--category input|result|snapshot|metadata] [--subject <subject>] [--backtest <suitability>]
  trader data openapi
  trader data describe <dataset>
  trader data get <dataset> [dataset options] [--base-url http://localhost:3001] [--timeout-ms 60000]
  trader strategy <existing strategy CLI arguments>

Examples:
  trader data get options-history --symbol NBIS --contract NBIS270115C00200000 --from 2026-01-01 --to 2026-03-31
  trader data get options-history --symbol NBIS --expiration 2026-04-17 --side put --strike 89
  trader data get options-chain --symbol NBIS --expiration 2026-09-11
  trader data get bars --symbol NBIS --range 5y --interval 1d
  trader data get financials --symbol NBIS
  trader data get x-posts --account example --from 2026-01-01 --limit 100
  trader data get institutional-holdings --institution 1067983 --period 2026-06-30
  trader data get strategy-equity --strategy portfolio-golden-cross
  trader data get finra-short-volume --symbol NBIS --date 2026-09-03

data sources/describe/openapi return machine-readable discovery without a server request.
data get uses GET /api/v1/data/<dataset>, returns its original JSON to stdout and never saves a file.
Errors are JSON on stderr. Exit codes: 0 success (possibly partial/empty), 1 API/network error, 2 invalid arguments.
Inspect source/provenance, dataMode, coverage, warnings and timestamps before analysis.
The source controls historical availability; no unlimited history or publication-time accuracy is promised.
Base URL: --base-url > TRADER_BASE_URL > http://localhost:3001.
Without installation, use ./bin/trader or npm run --silent trader -- <arguments>.
`;

class CliError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message); }
}
const fail = (message: string): never => { throw new CliError("invalid_arguments", message); };
const json = (writer: Writer, value: unknown) => writer.write(`${JSON.stringify(value, null, 2)}\n`);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function parse(argv: readonly string[]) {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const equal = token.indexOf("=");
    const key = token.slice(2, equal < 0 ? undefined : equal);
    if (!key || options.has(key)) fail(`Duplicate or empty option: --${key}`);
    const value = equal >= 0 ? token.slice(equal + 1) : key === "fresh" ? "1" : argv[++i];
    if (!value || value.startsWith("--")) fail(`--${key} requires a value`);
    if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 2048) fail(`Invalid value for --${key}`);
    options.set(key, value);
  }
  return { positionals, options };
}


function baseOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return fail("--base-url must be an HTTP(S) origin"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("--base-url must be an HTTP(S) origin without credentials, path, query or fragment");
  return url.origin;
}

async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new CliError("invalid_response", "API response exceeds 20 MiB", response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new CliError("invalid_response", "API response has no JSON body", response.status);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new CliError("invalid_response", "API response exceeds 20 MiB", response.status);
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CliError("invalid_response", "Trader returned a non-JSON response", response.status); }
}

export async function runTraderCli(argv: readonly string[], dependencies: TraderCliDependencies = defaults): Promise<number> {
  try {
    if (argv[0] === "strategy") {
      if (dependencies.strategy) return dependencies.strategy(argv.slice(1));
      // Preserve the existing strategy command's validation, confirmations and I/O.
      return runStrategyCli(argv.slice(1), { ...dependencies, readTextFile: async path => (await import("node:fs/promises")).readFile(path, "utf8"), readStdin: async () => {
        let body = "";
        for await (const chunk of process.stdin) { body += chunk; if (Buffer.byteLength(body) > 1_048_576) fail("stdin exceeds 1 MiB"); }
        return body;
      } } satisfies StrategyCliDependencies);
    }
    if (!argv.length || argv.includes("--help") || argv[0] === "help") { dependencies.stdout.write(HELP); return 0; }
    const { positionals, options } = parse(argv);
    const [group, action, id, ...extra] = positionals;
    if (group !== "data" || extra.length) fail("Use data sources, data describe <dataset>, or data get <dataset>");
    if (action === "sources") {
      if (id) fail("data sources takes no dataset argument");
      json(dependencies.stdout, discoverData(options)); return 0;
    }
    if (action === "openapi") {
      if (id || options.size) fail("data openapi takes no arguments");
      json(dependencies.stdout, dataOpenApi()); return 0;
    }
    const definition = dataDefinition(id ?? "");
    if (action === "describe") {
      if (options.size) fail("data describe takes no options");
      json(dependencies.stdout, describeData(definition.id)); return 0;
    }
    if (action !== "get") fail("Unknown data action");
    const datasetOptions = [...options].filter(([key]) => !["base-url", "timeout-ms"].includes(key));
    const path = prepareDataRequest(definition, datasetOptions).canonicalPath;
    const origin = baseOrigin(options.get("base-url") ?? dependencies.env.TRADER_BASE_URL ?? "http://localhost:3001");
    const timeoutText = options.get("timeout-ms") ?? "60000";
    if (!/^\d+$/.test(timeoutText) || Number(timeoutText) < 1 || Number(timeoutText) > 120000) fail("--timeout-ms must be an integer from 1 to 120000");
    const signal = AbortSignal.timeout(Number(timeoutText));
    let payload: unknown;
    let response: Response;
    try {
      response = await dependencies.fetch(`${origin}${path}`, { method: "GET", headers: { Accept: "application/json", "Cache-Control": "no-store" }, cache: "no-store", redirect: "error", signal });
      payload = await readJson(response);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(signal.aborted ? "timeout" : "network_error", signal.aborted ? "Trader request timed out" : "Trader API could not be reached. Check its server and --base-url.");
    }
    if (!response.ok || isRecord(payload) && isRecord(payload.error)) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      throw new CliError(typeof error.code === "string" ? error.code : "api_error", typeof error.message === "string" ? error.message : "Trader API request failed", response.status);
    }
    if (!isRecord(payload)) throw new CliError("invalid_response", "Trader API returned an unexpected JSON shape", response.status);
    json(dependencies.stdout, payload);
    return 0;
  } catch (error) {
    const failure = error instanceof CliError ? error : error instanceof DataRequestError ? new CliError("invalid_arguments", error.message) : new CliError("internal_error", "Trader CLI could not complete the request");
    json(dependencies.stderr, { ok: false, code: failure.code, status: failure.status, message: failure.message });
    return failure.code === "invalid_arguments" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runTraderCli(process.argv.slice(2));
