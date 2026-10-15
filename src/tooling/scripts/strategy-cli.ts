import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://localhost:3001";
const MAX_INPUT_BYTES = 1_048_576;

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_INPUT_BYTES) {
      throw new CliUsageError("stdin exceeds the 1 MiB input limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type OutputWriter = { write(chunk: string): unknown };

export type StrategyCliDependencies = Readonly<{
  fetch: typeof globalThis.fetch;
  readTextFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
  stdout: OutputWriter;
  stderr: OutputWriter;
  env: Readonly<Record<string, string | undefined>>;
}>;

type ParsedArguments = Readonly<{
  positionals: readonly string[];
  options: ReadonlyMap<string, string | true>;
}>;

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

class CliOutputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "CliOutputError";
  }
}

const STRATEGY_SORT_FIELDS = [
  "id",
  "name",
  "candidateAt",
  "updatedAt",
  "netReturn",
  "maxDrawdown",
  "recoveryFactor",
  "sharpe",
  "forwardReturn",
  "winRate",
  "trades",
  "symbols",
  "cash",
] as const;

type StrategySortField = (typeof STRATEGY_SORT_FIELDS)[number];
type SortOrder = "asc" | "desc";
type JsonObject = Record<string, unknown>;

const STRATEGY_ORIGINS = ["built_in", "custom"] as const;
const STRATEGY_FAMILIES = ["portfolio2", "rule", "research"] as const;
const STRATEGY_STATUSES = ["pinned", "research"] as const;
const STRATEGY_PROVENANCE = [
  "illustrative_catalog",
  "user_supplied",
  "transaction_snapshot",
  "unavailable",
] as const;

const HELP = `Trader strategy CLI

Usage:
  npm run strategy -- list [discovery options]
  npm run strategy -- compare <strategy-id> <strategy-id> [...] [--sort <field>] [--order asc|desc]
  npm run strategy -- get <strategy-id> [--include transactions,performance]
  npm run strategy -- create --file <path|->
  npm run strategy -- create --name <name> --headline <headline> [--category <value>]
  npm run strategy -- edit <strategy-id> --file <path|-> [--version <number>]
  npm run strategy -- delete <strategy-id> [--version <number>] --yes
  npm run strategy -- performance get <strategy-id>
  npm run strategy -- transactions list <strategy-id>
  npm run strategy -- transactions get <strategy-id> <transaction-id>
  npm run strategy -- transactions add <strategy-id> --file <path|->
  npm run strategy -- transactions edit <strategy-id> <transaction-id> --file <path|-> [--updated-at <value>]
  npm run strategy -- transactions delete <strategy-id> <transaction-id> --yes

Global option:
  --base-url <url>  API origin (default: TRADER_BASE_URL or http://localhost:3001)

Discovery options for list:
  --query <text>          Search ID, name, headline, category, and source labels
  --origin <value>       built_in | custom
  --family <value>       portfolio2 | rule | research
  --status <value>       pinned | research
  --provenance <value>   illustrative_catalog | user_supplied | transaction_snapshot | unavailable
  --category <text>      Match a category exactly (case-insensitive)
  --source <text>        Match a source label exactly (case-insensitive)
  --sort <field>         ${STRATEGY_SORT_FIELDS.join(" | ")}
  --order <value>        asc | desc (requires --sort)
  --limit <number>       Return at most 1-1000 matches

Transaction edit option:
  --updated-at <value>   Exact updatedAt returned by the latest transaction get
`;

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const separator = argument.indexOf("=");
    const key = argument.slice(2, separator === -1 ? undefined : separator);
    if (!key || options.has(key)) {
      throw new CliUsageError(key ? `--${key} may only be supplied once` : "option name is missing");
    }
    if (separator !== -1) {
      options.set(key, argument.slice(separator + 1));
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && (!next.startsWith("--") || next === "-")) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }

  return { positionals, options };
}

function optionString(options: ParsedArguments["options"], key: string): string | undefined {
  const value = options.get(key);
  if (value === undefined) return undefined;
  if (value === true || value.length === 0) {
    throw new CliUsageError(`--${key} requires a value`);
  }
  return value;
}

function requireConfirmation(options: ParsedArguments["options"]): void {
  if (options.get("yes") !== true) {
    throw new CliUsageError("destructive commands require an explicit --yes");
  }
}

function assertAllowedOptions(
  options: ParsedArguments["options"],
  allowed: readonly string[],
): void {
  const allowedSet = new Set(["base-url", ...allowed]);
  for (const key of options.keys()) {
    if (!allowedSet.has(key)) throw new CliUsageError(`unknown option --${key}`);
  }
}

function parsePositiveInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new CliUsageError(`${field} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseFiniteNumber(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CliUsageError(`${field} must be a finite number`);
  return parsed;
}

function parseChoice<const Values extends readonly string[]>(
  value: string | undefined,
  field: string,
  values: Values,
): Values[number] | undefined {
  if (value === undefined) return undefined;
  if (!(values as readonly string[]).includes(value)) {
    throw new CliUsageError(`${field} must be one of: ${values.join(", ")}`);
  }
  return value as Values[number];
}

function parseLocale(options: ParsedArguments["options"]): "en" | "ja" | undefined {
  return parseChoice(optionString(options, "locale"), "locale", ["en", "ja"] as const);
}

function parseSort(
  options: ParsedArguments["options"],
): Readonly<{ field: StrategySortField; order: SortOrder }> | undefined {
  const field = parseChoice(
    optionString(options, "sort"),
    "sort",
    STRATEGY_SORT_FIELDS,
  );
  const order = parseChoice(
    optionString(options, "order"),
    "order",
    ["asc", "desc"] as const,
  );
  if (order && !field) throw new CliUsageError("--order requires --sort");
  if (!field) return undefined;
  return {
    field,
    order: order ?? (field === "id" || field === "name" ? "asc" : "desc"),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strategyListPayload(payload: unknown): JsonObject & { strategies: JsonObject[] } {
  if (!isJsonObject(payload) || !Array.isArray(payload.strategies)) {
    throw new CliOutputError(
      "invalid_response",
      "The Trader API response does not contain a strategies array.",
    );
  }
  if (!payload.strategies.every(isJsonObject)) {
    throw new CliOutputError(
      "invalid_response",
      "The Trader API returned an invalid strategy record.",
    );
  }
  return payload as JsonObject & { strategies: JsonObject[] };
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").toLocaleLowerCase("en-US") : "";
}

function strategyPerformance(strategy: JsonObject): JsonObject {
  return isJsonObject(strategy.performance) ? strategy.performance : {};
}

function strategySortValue(
  strategy: JsonObject,
  field: StrategySortField,
): string | number | null {
  const value = [
    "netReturn",
    "maxDrawdown",
    "recoveryFactor",
    "sharpe",
    "forwardReturn",
    "winRate",
    "trades",
    "symbols",
    "cash",
  ].includes(field)
    ? strategyPerformance(strategy)[field]
    : strategy[field];
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : null;
}

function compareStrategyValues(
  left: JsonObject,
  right: JsonObject,
  sort: Readonly<{ field: StrategySortField; order: SortOrder }>,
): number {
  const leftValue = strategySortValue(left, sort.field);
  const rightValue = strategySortValue(right, sort.field);
  if (leftValue === null && rightValue !== null) return 1;
  if (leftValue !== null && rightValue === null) return -1;
  if (leftValue === null || rightValue === null) {
    return normalizedText(left.id).localeCompare(normalizedText(right.id), "en");
  }
  const comparison = typeof leftValue === "number" && typeof rightValue === "number"
    ? leftValue - rightValue
    : String(leftValue).localeCompare(String(rightValue), "en", { sensitivity: "base" });
  if (comparison !== 0) return sort.order === "asc" ? comparison : -comparison;
  return normalizedText(left.id).localeCompare(normalizedText(right.id), "en");
}

type ListDiscovery = Readonly<{
  query?: string;
  origin?: (typeof STRATEGY_ORIGINS)[number];
  family?: (typeof STRATEGY_FAMILIES)[number];
  status?: (typeof STRATEGY_STATUSES)[number];
  provenance?: (typeof STRATEGY_PROVENANCE)[number];
  category?: string;
  source?: string;
  sort?: Readonly<{ field: StrategySortField; order: SortOrder }>;
  limit?: number;
}>;

function parseListDiscovery(options: ParsedArguments["options"]): ListDiscovery {
  const limit = parsePositiveInteger(optionString(options, "limit"), "limit");
  if (limit !== undefined && limit > 1000) {
    throw new CliUsageError("limit must be between 1 and 1000");
  }
  const query = optionString(options, "query");
  const origin = parseChoice(optionString(options, "origin"), "origin", STRATEGY_ORIGINS);
  const family = parseChoice(optionString(options, "family"), "family", STRATEGY_FAMILIES);
  const status = parseChoice(optionString(options, "status"), "status", STRATEGY_STATUSES);
  const provenance = parseChoice(
    optionString(options, "provenance"),
    "provenance",
    STRATEGY_PROVENANCE,
  );
  const category = optionString(options, "category");
  const source = optionString(options, "source");
  const sort = parseSort(options);
  return {
    ...(query === undefined ? {} : { query }),
    ...(origin === undefined ? {} : { origin }),
    ...(family === undefined ? {} : { family }),
    ...(status === undefined ? {} : { status }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(category === undefined ? {} : { category }),
    ...(source === undefined ? {} : { source }),
    ...(sort === undefined ? {} : { sort }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function strategyMatchesDiscovery(strategy: JsonObject, discovery: ListDiscovery): boolean {
  const performance = strategyPerformance(strategy);
  if (discovery.origin && strategy.origin !== discovery.origin) return false;
  if (discovery.family && strategy.family !== discovery.family) return false;
  if (discovery.status && strategy.status !== discovery.status) return false;
  if (discovery.provenance && performance.provenance !== discovery.provenance) return false;
  if (discovery.category && normalizedText(strategy.category) !== normalizedText(discovery.category)) {
    return false;
  }
  const sourceLabels = Array.isArray(strategy.sourceLabels) ? strategy.sourceLabels : [];
  if (
    discovery.source
    && !sourceLabels.some((label) => normalizedText(label) === normalizedText(discovery.source))
  ) {
    return false;
  }
  if (discovery.query) {
    const haystack = [
      strategy.id,
      strategy.name,
      strategy.headline,
      strategy.category,
      ...sourceLabels,
    ].map(normalizedText).join("\n");
    if (!haystack.includes(normalizedText(discovery.query))) return false;
  }
  return true;
}

function selectStrategies(payload: unknown, discovery: ListDiscovery): unknown {
  const response = strategyListPayload(payload);
  const matched = response.strategies.filter((strategy) => strategyMatchesDiscovery(strategy, discovery));
  const { sort } = discovery;
  if (sort) matched.sort((left, right) => compareStrategyValues(left, right, sort));
  const selected = discovery.limit === undefined ? matched : matched.slice(0, discovery.limit);
  const filters = {
    ...(discovery.query === undefined ? {} : { query: discovery.query }),
    ...(discovery.origin === undefined ? {} : { origin: discovery.origin }),
    ...(discovery.family === undefined ? {} : { family: discovery.family }),
    ...(discovery.status === undefined ? {} : { status: discovery.status }),
    ...(discovery.provenance === undefined ? {} : { provenance: discovery.provenance }),
    ...(discovery.category === undefined ? {} : { category: discovery.category }),
    ...(discovery.source === undefined ? {} : { source: discovery.source }),
  };
  return {
    ...response,
    strategies: selected,
    selection: {
      totalCount: response.strategies.length,
      matchedCount: matched.length,
      returnedCount: selected.length,
      filters,
      sort: sort ?? null,
      limit: discovery.limit ?? null,
    },
  };
}

function compareStrategies(
  payload: unknown,
  requestedIds: readonly string[],
  sort: Readonly<{ field: StrategySortField; order: SortOrder }> | undefined,
): unknown {
  const response = strategyListPayload(payload);
  const byId = new Map(response.strategies.map((strategy) => [strategy.id, strategy]));
  const missing = requestedIds.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new CliOutputError(
      "strategy_not_found",
      `Strategy IDs were not found: ${missing.join(", ")}`,
      404,
    );
  }
  const strategies = requestedIds.map((id) => byId.get(id)!);
  if (sort) strategies.sort((left, right) => compareStrategyValues(left, right, sort));
  const provenanceGroups: Record<string, string[]> = {};
  for (const strategy of strategies) {
    const provenance = strategyPerformance(strategy).provenance;
    const key = typeof provenance === "string" ? provenance : "unknown";
    (provenanceGroups[key] ??= []).push(String(strategy.id));
  }
  return {
    schemaVersion: "trader.strategy-comparison.v1",
    sourceSchemaVersion: response.schemaVersion ?? null,
    strategies,
    comparison: {
      requestedIds,
      sort: sort ?? null,
      provenanceGroups,
      execution: "not_run",
      disclosures: [
        "Compare numeric performance only when provenance and methodology are compatible.",
        "Illustrative catalog and user-supplied metrics are not verified backtest results.",
        "This command does not run strategy rules, candidate search, or a backtest.",
      ],
    },
  };
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliUsageError("--base-url must be an absolute URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliUsageError("--base-url must use HTTPS, except for a loopback development server");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliUsageError("--base-url must not contain credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function parseJsonObject(text: string, source: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    throw new CliUsageError(`${source} exceeds the 1 MiB input limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliUsageError(`${source} must contain valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(`${source} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function payloadFromFile(
  file: string,
  dependencies: StrategyCliDependencies,
): Promise<Record<string, unknown>> {
  const text = file === "-" ? await dependencies.readStdin() : await dependencies.readTextFile(file);
  return parseJsonObject(text, file === "-" ? "stdin" : file);
}

async function strategyPayload(
  options: ParsedArguments["options"],
  dependencies: StrategyCliDependencies,
  mode: "create" | "edit",
): Promise<Record<string, unknown>> {
  const file = optionString(options, "file");
  const payload = file ? await payloadFromFile(file, dependencies) : {};
  const mappings = [
    ["strategy-id", "strategyId"],
    ["name", "name"],
    ["headline", "headline"],
    ["category", "category"],
    ["family", "family"],
    ["status", "status"],
    ["candidate-at", "candidateAt"],
  ] as const;
  for (const [option, field] of mappings) {
    const value = optionString(options, option);
    if (value !== undefined) payload[field] = value;
  }
  const sources = optionString(options, "sources");
  if (sources !== undefined) {
    payload.sourceLabels = sources.split(",").map((item) => item.trim()).filter(Boolean);
  }
  const version = parsePositiveInteger(optionString(options, "version"), "version");
  if (version !== undefined) payload.expectedVersion = version;

  const meaningfulKeys = Object.keys(payload).filter((key) => key !== "expectedVersion");
  if (mode === "create" && (typeof payload.name !== "string" || typeof payload.headline !== "string")) {
    throw new CliUsageError("create requires name and headline (in --file or flags)");
  }
  if (mode === "edit" && meaningfulKeys.length === 0) {
    throw new CliUsageError("edit requires at least one field to change");
  }
  return payload;
}

async function transactionPayload(
  options: ParsedArguments["options"],
  dependencies: StrategyCliDependencies,
  mode: "add" | "edit",
): Promise<Record<string, unknown>> {
  const file = optionString(options, "file");
  const payload = file ? await payloadFromFile(file, dependencies) : {};
  const textMappings = [
    ["transaction-id", "transactionId"],
    ["date", "date"],
    ["symbol", "symbol"],
    ["side", "side"],
  ] as const;
  for (const [option, field] of textMappings) {
    const value = optionString(options, option);
    if (value !== undefined) payload[field] = value;
  }
  for (const [option, field] of [["shares", "shares"], ["price", "price"], ["fee", "fee"]] as const) {
    const value = parseFiniteNumber(optionString(options, option), option);
    if (value !== undefined) payload[field] = value;
  }
  const expectedUpdatedAt = optionString(options, "updated-at");
  if (expectedUpdatedAt !== undefined) payload.expectedUpdatedAt = expectedUpdatedAt;
  if (Object.keys(payload).length === 0) {
    throw new CliUsageError("transaction command requires a payload file or transaction fields");
  }
  if (
    mode === "edit"
    && (typeof payload.expectedUpdatedAt !== "string" || payload.expectedUpdatedAt.length === 0)
  ) {
    throw new CliUsageError(
      "transactions edit requires expectedUpdatedAt in the payload or --updated-at from the latest transaction get",
    );
  }
  return payload;
}

function encodePath(value: string, label: string): string {
  if (!value.trim()) throw new CliUsageError(`${label} is required`);
  return encodeURIComponent(value.trim());
}

type RequestPlan = Readonly<{
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  transform?: (payload: unknown) => unknown;
}>;

async function buildRequest(
  parsed: ParsedArguments,
  dependencies: StrategyCliDependencies,
): Promise<RequestPlan | "help"> {
  const [command, ...rest] = parsed.positionals;
  if (!command || command === "help" || parsed.options.has("help")) return "help";

  if (command === "list") {
    assertAllowedOptions(parsed.options, [
      "locale",
      "query",
      "origin",
      "family",
      "status",
      "provenance",
      "category",
      "source",
      "sort",
      "order",
      "limit",
    ]);
    if (rest.length) throw new CliUsageError("list does not accept positional arguments");
    const locale = parseLocale(parsed.options);
    const discovery = parseListDiscovery(parsed.options);
    const hasDiscovery = Object.keys(discovery).length > 0;
    return {
      path: `/api/v1/strategies${locale ? `?locale=${locale}` : ""}`,
      ...(hasDiscovery ? { transform: (payload: unknown) => selectStrategies(payload, discovery) } : {}),
    };
  }

  if (command === "compare") {
    assertAllowedOptions(parsed.options, ["locale", "sort", "order"]);
    if (rest.length < 2) throw new CliUsageError("compare requires at least two strategy IDs");
    if (rest.length > 20) throw new CliUsageError("compare accepts at most 20 strategy IDs");
    const strategyIds = rest.map((id) => id.trim());
    if (strategyIds.some((id) => !id)) throw new CliUsageError("strategy ID is required");
    if (new Set(strategyIds).size !== strategyIds.length) {
      throw new CliUsageError("compare strategy IDs must be unique");
    }
    const locale = parseLocale(parsed.options);
    const sort = parseSort(parsed.options);
    return {
      path: `/api/v1/strategies${locale ? `?locale=${locale}` : ""}`,
      transform: (payload) => compareStrategies(payload, strategyIds, sort),
    };
  }

  if (command === "get") {
    assertAllowedOptions(parsed.options, ["include", "locale"]);
    if (rest.length !== 1) throw new CliUsageError("get requires one strategy ID");
    const query = new URLSearchParams();
    const include = optionString(parsed.options, "include");
    if (include) query.set("include", include === "all" ? "transactions,performance" : include);
    const locale = parseLocale(parsed.options);
    if (locale) query.set("locale", locale);
    const suffix = query.size ? `?${query}` : "";
    return { path: `/api/v1/strategies/${encodePath(rest[0], "strategy ID")}${suffix}` };
  }

  if (command === "create") {
    assertAllowedOptions(parsed.options, ["file", "strategy-id", "name", "headline", "category", "family", "status", "candidate-at", "sources"]);
    if (rest.length) throw new CliUsageError("create does not accept positional arguments");
    return { method: "POST", path: "/api/v1/strategies", body: await strategyPayload(parsed.options, dependencies, "create") };
  }

  if (command === "edit") {
    assertAllowedOptions(parsed.options, ["file", "name", "headline", "category", "family", "status", "candidate-at", "sources", "version"]);
    if (rest.length !== 1) throw new CliUsageError("edit requires one strategy ID");
    return {
      method: "PATCH",
      path: `/api/v1/strategies/${encodePath(rest[0], "strategy ID")}`,
      body: await strategyPayload(parsed.options, dependencies, "edit"),
    };
  }

  if (command === "delete") {
    assertAllowedOptions(parsed.options, ["yes", "version"]);
    if (rest.length !== 1) throw new CliUsageError("delete requires one strategy ID");
    requireConfirmation(parsed.options);
    const version = parsePositiveInteger(optionString(parsed.options, "version"), "version");
    return {
      method: "DELETE",
      path: `/api/v1/strategies/${encodePath(rest[0], "strategy ID")}${version ? `?expectedVersion=${version}` : ""}`,
    };
  }

  if (command === "performance") {
    assertAllowedOptions(parsed.options, ["locale"]);
    if (rest.length !== 2 || rest[0] !== "get") {
      throw new CliUsageError("performance requires: performance get <strategy-id>");
    }
    const locale = parseLocale(parsed.options);
    const query = new URLSearchParams({ include: "performance" });
    if (locale) query.set("locale", locale);
    return { path: `/api/v1/strategies/${encodePath(rest[1], "strategy ID")}?${query}` };
  }

  if (command === "transactions") {
    const [action, strategyId, transactionId, ...extra] = rest;
    if (!action || !strategyId || extra.length) {
      throw new CliUsageError("transactions requires an action and strategy ID");
    }
    const collection = `/api/v1/strategy-portfolios/${encodePath(strategyId, "strategy ID")}/transactions`;
    if (action === "list") {
      assertAllowedOptions(parsed.options, []);
      if (transactionId) throw new CliUsageError("transactions list accepts only a strategy ID");
      return { path: collection };
    }
    if (action === "get") {
      assertAllowedOptions(parsed.options, []);
      if (!transactionId) throw new CliUsageError("transactions get requires a transaction ID");
      return { path: `${collection}/${encodePath(transactionId, "transaction ID")}` };
    }
    if (action === "add") {
      assertAllowedOptions(parsed.options, ["file", "transaction-id", "date", "symbol", "side", "shares", "price", "fee"]);
      if (transactionId) throw new CliUsageError("transactions add accepts only a strategy ID");
      return {
        method: "POST",
        path: collection,
        body: await transactionPayload(parsed.options, dependencies, "add"),
      };
    }
    if (action === "edit") {
      assertAllowedOptions(parsed.options, [
        "file",
        "date",
        "symbol",
        "side",
        "shares",
        "price",
        "fee",
        "updated-at",
      ]);
      if (!transactionId) throw new CliUsageError("transactions edit requires a transaction ID");
      return {
        method: "PATCH",
        path: `${collection}/${encodePath(transactionId, "transaction ID")}`,
        body: await transactionPayload(parsed.options, dependencies, "edit"),
      };
    }
    if (action === "delete") {
      assertAllowedOptions(parsed.options, ["yes"]);
      if (!transactionId) throw new CliUsageError("transactions delete requires a transaction ID");
      requireConfirmation(parsed.options);
      return { method: "DELETE", path: `${collection}/${encodePath(transactionId, "transaction ID")}` };
    }
    throw new CliUsageError(`unknown transactions action: ${action}`);
  }

  throw new CliUsageError(`unknown command: ${command}`);
}

function writeJson(writer: OutputWriter, value: unknown): void {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function executeRequest(
  plan: RequestPlan,
  baseUrl: string,
  dependencies: StrategyCliDependencies,
): Promise<number> {
  let response: Response;
  try {
    response = await dependencies.fetch(`${baseUrl}${plan.path}`, {
      method: plan.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(plan.body ? { "Content-Type": "application/json" } : {}),
      },
      body: plan.body ? JSON.stringify(plan.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    writeJson(dependencies.stderr, {
      ok: false,
      status: 0,
      code: "network_error",
      message: error instanceof Error ? error.message : "The Trader API could not be reached.",
    });
    return 1;
  }

  const requestId = response.headers.get("x-request-id") ?? undefined;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    writeJson(dependencies.stderr, {
      ok: false,
      status: response.status,
      code: "invalid_response",
      message: "The Trader API returned a non-JSON response.",
      ...(requestId ? { requestId } : {}),
    });
    return 1;
  }

  if (!response.ok) {
    const errorPayload = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: unknown }).error
      : undefined;
    const apiError = errorPayload && typeof errorPayload === "object"
      ? errorPayload as { code?: unknown; message?: unknown }
      : {};
    const responseRequestId = payload && typeof payload === "object" && "requestId" in payload
      ? (payload as { requestId?: unknown }).requestId
      : undefined;
    writeJson(dependencies.stderr, {
      ok: false,
      status: response.status,
      code: typeof apiError.code === "string" ? apiError.code : "api_error",
      message: typeof apiError.message === "string" ? apiError.message : response.statusText,
      ...(typeof responseRequestId === "string" ? { requestId: responseRequestId } : requestId ? { requestId } : {}),
    });
    return 1;
  }

  let output = payload;
  try {
    output = plan.transform ? plan.transform(payload) : payload;
  } catch (error) {
    const outputError = error instanceof CliOutputError ? error : undefined;
    writeJson(dependencies.stderr, {
      ok: false,
      status: outputError?.status ?? response.status,
      code: outputError?.code ?? "invalid_response",
      message: outputError?.message ?? "The Trader API returned an invalid response.",
      ...(requestId ? { requestId } : {}),
    });
    return 1;
  }

  writeJson(dependencies.stdout, output);
  return 0;
}

const defaultDependencies: StrategyCliDependencies = {
  fetch: globalThis.fetch,
  readTextFile: (path) => readFile(path, "utf8"),
  readStdin: readProcessStdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
};

export async function runStrategyCli(
  argv: readonly string[],
  dependencies: StrategyCliDependencies = defaultDependencies,
): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    const plan = await buildRequest(parsed, dependencies);
    if (plan === "help") {
      dependencies.stdout.write(HELP);
      return 0;
    }
    const baseUrl = normalizeBaseUrl(
      optionString(parsed.options, "base-url") ?? dependencies.env.TRADER_BASE_URL ?? DEFAULT_BASE_URL,
    );
    return await executeRequest(plan, baseUrl, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI error";
    writeJson(dependencies.stderr, { ok: false, status: 0, code: "invalid_arguments", message });
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = await runStrategyCli(process.argv.slice(2));
}
