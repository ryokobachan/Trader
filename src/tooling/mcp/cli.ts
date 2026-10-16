import { readToolDefinitions, ToolDefinitionError } from "./definitions";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createTraderMcpServer, localBaseUrl, McpConfigurationError } from "./server";
import { MCP_SERVERS, type McpServerId } from "./servers";

/** The build fixes one server ID per folder; a caller cannot switch to another MCP. */
export async function startMcpServer(id: McpServerId, args = process.argv.slice(2)): Promise<void> {
  try { await serve(id, args); }
  catch (error) {
    const message = error instanceof McpConfigurationError || error instanceof ToolDefinitionError ? error.message : "Trader MCP could not start.";
    process.stderr.write(JSON.stringify({ error: { code: "mcp_startup_error", message } }) + "\n");
    process.exitCode = 1;
  }
}

async function serve(id: McpServerId, args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${MCP_SERVERS[id].title}：読み取り専用MCP\nCodexがNode.jsでserver.mjsを起動・終了します。\n設定：--base-url <このMacの接続先> --timeout-ms <1..120000>\n既定：TRADER_BASE_URL または http://127.0.0.1:3001、TRADER_MCP_TIMEOUT_MS または60000ミリ秒。\n`);
    return;
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--base-url", "--timeout-ms"].includes(key) || options.has(key) || !value || value.startsWith("--")) throw new McpConfigurationError("Use --base-url <origin> and --timeout-ms <integer> at most once.");
    options.set(key, value);
  }
  const baseUrl = localBaseUrl(options.get("--base-url") ?? process.env.TRADER_BASE_URL);
  const timeout = options.get("--timeout-ms") ?? process.env.TRADER_MCP_TIMEOUT_MS ?? "60000";
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 120000) throw new McpConfigurationError("--timeout-ms must be an integer from 1 to 120000.");
  const definitions = readToolDefinitions(id, new URL("./tools.yaml", import.meta.url));
  const handle = serveStdio(() => createTraderMcpServer(id, { baseUrl, timeoutMs: Number(timeout), definitions }), {
    onerror: () => { process.stderr.write("Trader MCP protocol error.\n"); },
  });
  const close = () => { void handle.close().finally(() => { process.exitCode = 0; }); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
}
