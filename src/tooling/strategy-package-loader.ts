import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const STRATEGY_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PERFORMANCE_KEYS = [
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
const MAX_JSON_BYTES = 1_000_000;
const MAX_RUN_BYTES = 1_000_000;
const MAX_EQUITY_BYTES = 4_000_000;
const MAX_TRANSACTIONS_BYTES = 8_000_000;
const MAX_TRANSACTIONS = 50_000;
const MAX_EQUITY_POINTS = 20_000;
const MAX_NUMBER = 1_000_000_000_000;

export type LoadedStrategyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly LoadedStrategyJsonValue[]
  | { readonly [key: string]: LoadedStrategyJsonValue };

type LocaleCopy = Readonly<{
  name: string;
  category: string;
  sourceLabels: readonly string[];
  headline: string;
  auditVerdict: string;
}>;

export type LoadedStrategyTransaction = Readonly<{
  transactionId: string;
  date: string;
  symbol: string;
  side: "buy" | "sell" | "dividend";
  shares: number;
  price: number;
  fee: number;
}>;

export type LoadedStrategyFinalPosition = Readonly<{
  symbol: string;
  shares: number;
  averageCost: number;
  markPrice: number;
  marketValue: number;
  allocationPercent: number;
  unrealizedPnl: number;
}>;

export type LoadedStrategyRun = Readonly<{
  runId: string;
  generatedAt: string;
  metricsDefinitionVersion: "trader.strategy-metrics.v1";
  data: Readonly<{
    provider: string;
    providerVersion: string;
    symbols: readonly string[];
    interval: string;
    requestedStart: string;
    requestedEndExclusive: string;
    evaluationStart: string;
    evaluationEndExclusive: string;
    start: string;
    end: string;
    adjustment: string;
    timezone: string;
    sha256: string;
  }>;
  reproducibility: Readonly<{
    configSha256: string;
    codeSha256: string;
    runnerSha256: string;
    runtime: Readonly<Record<string, string>>;
    effectiveParameters: Readonly<Record<string, LoadedStrategyJsonValue>>;
    annualizationDays: number;
    annualRiskFreeRate: number;
    periodicRiskFreeRate: number;
  }>;
  execution: Readonly<{
    transactionMapping: "vectorbt_filled_orders";
    orderCount: number;
    closedTradeCount: number;
    openTradeCount: number;
    totalTradeCount: number;
    totalFees: number;
    finalValue: number | null;
    finalCashPercent: number | null;
    finalPositions: readonly LoadedStrategyFinalPosition[];
    cagr: number | null;
  }>;
  benchmark: Readonly<{
    symbol: string;
    returnType: string;
    costsApplied: boolean;
    dataSha256: string | null;
    metrics: Readonly<{
      netReturn: number | null;
      maxDrawdown: number | null;
      sharpe: number | null;
      cagr: number | null;
      excessReturn: number | null;
    }>;
  }> | null;
  warnings: readonly string[];
}>;

export type LoadedStrategyEquity = Readonly<{
  frequency: "1d";
  initialValue: number;
  points: readonly Readonly<{
    date: string;
    portfolioValue: number;
    benchmarkValue: number | null;
  }>[];
}>;

export type LoadedStrategyPackage = Readonly<{
  id: string;
  version: string;
  order: number;
  family: "portfolio2" | "rule" | "research";
  status: "pinned" | "research";
  candidateAt: string;
  audit: Readonly<{ overfit: number | null; leakage: number | null }>;
  copy: Readonly<{ en: LocaleCopy; ja: LocaleCopy }>;
  performance: Readonly<{
    provenance: "unavailable" | "backtest_artifact";
    netReturn: number | null;
    maxDrawdown: number | null;
    recoveryFactor: number | null;
    sharpe: number | null;
    forwardReturn: number | null;
    winRate: number | null;
    trades: number | null;
    symbols: number | null;
    cash: number | null;
  }>;
  run: LoadedStrategyRun | null;
  equity: LoadedStrategyEquity | null;
  transactions: readonly LoadedStrategyTransaction[];
}>;

export class StrategyPackageError extends Error {
  constructor(readonly packagePath: string, message: string) {
    super(`${packagePath}: ${message}`);
    this.name = "StrategyPackageError";
  }
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrategyPackageError(location, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], location: string) {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new StrategyPackageError(`${location}.${key}`, "unknown field");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new StrategyPackageError(`${location}.${key}`, "field is required");
    }
  }
}

function text(value: unknown, location: string, maximum = 500): string {
  if (typeof value !== "string") throw new StrategyPackageError(location, "must be a string");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new StrategyPackageError(location, `must contain 1-${maximum} safe characters`);
  }
  return normalized;
}

function nullableMetric(value: unknown, location: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_NUMBER) {
    throw new StrategyPackageError(location, "must be null or a finite supported number");
  }
  return value;
}

function nullableCount(value: unknown, location: string): number | null {
  const parsed = nullableMetric(value, location);
  if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
    throw new StrategyPackageError(location, "must be null or a non-negative integer");
  }
  return parsed;
}

function finiteNumber(
  value: unknown,
  location: string,
  options: Readonly<{ minimum?: number; maximum?: number }> = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_NUMBER) {
    throw new StrategyPackageError(location, "must be a finite supported number");
  }
  if (options.minimum !== undefined && value < options.minimum) {
    throw new StrategyPackageError(location, `must be at least ${options.minimum}`);
  }
  if (options.maximum !== undefined && value > options.maximum) {
    throw new StrategyPackageError(location, `must be at most ${options.maximum}`);
  }
  return value;
}

function approximatelyEqual(left: number, right: number): boolean {
  const tolerance = Math.max(
    1e-8,
    Math.max(Math.abs(left), Math.abs(right)) * 1e-9,
  );
  return Math.abs(left - right) <= tolerance;
}

function integer(
  value: unknown,
  location: string,
  options: Readonly<{ minimum?: number; maximum?: number }> = {},
): number {
  const parsed = finiteNumber(value, location, options);
  if (!Number.isSafeInteger(parsed)) {
    throw new StrategyPackageError(location, "must be a safe integer");
  }
  return parsed;
}

function sha256(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new StrategyPackageError(location, "must be a lowercase 64-character SHA-256 digest");
  }
  return value;
}

function jsonValue(value: unknown, location: string, depth = 0): LoadedStrategyJsonValue {
  if (depth > 16) throw new StrategyPackageError(location, "exceeds the supported nesting depth");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumber(value, location);
  if (typeof value === "string") {
    if (value.length > 2_000 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new StrategyPackageError(location, "contains an unsupported string");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new StrategyPackageError(location, "contains too many array items");
    return Object.freeze(value.map((item, index) => jsonValue(item, `${location}[${index}]`, depth + 1)));
  }
  const input = object(value, location);
  const entries = Object.entries(input);
  if (entries.length > 200) throw new StrategyPackageError(location, "contains too many object fields");
  const output: Record<string, LoadedStrategyJsonValue> = {};
  for (const [key, item] of entries) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)
      || key === "__proto__"
      || key === "constructor"
      || key === "prototype"
    ) {
      throw new StrategyPackageError(`${location}.${key}`, "contains an unsupported object key");
    }
    output[key] = jsonValue(item, `${location}.${key}`, depth + 1);
  }
  return Object.freeze(output);
}

async function readJson(filePath: string, maximumBytes: number): Promise<unknown> {
  const file = await lstat(filePath).catch(() => null);
  if (!file?.isFile() || file.isSymbolicLink()) {
    throw new StrategyPackageError(filePath, "required regular file is missing");
  }
  if (file.size > maximumBytes) throw new StrategyPackageError(filePath, "file is too large");
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new StrategyPackageError(filePath, "contains invalid JSON");
  }
}

function nullableRunId(value: unknown, location: string): string | null {
  if (value === null) return null;
  return text(value, location, 128);
}

function nullableTimestamp(value: unknown, location: string): string | null {
  if (value === null) return null;
  const parsed = text(value, location, 64);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new StrategyPackageError(location, "must be null or an ISO timestamp");
  }
  return parsed;
}

function localeCopy(value: unknown, location: string): LocaleCopy {
  const input = object(value, location);
  exactKeys(input, ["name", "category", "sourceLabels", "headline", "auditVerdict"], location);
  if (!Array.isArray(input.sourceLabels) || input.sourceLabels.length > 24) {
    throw new StrategyPackageError(`${location}.sourceLabels`, "must contain at most 24 labels");
  }
  const sourceLabels = input.sourceLabels.map((item, index) => (
    text(item, `${location}.sourceLabels[${index}]`, 80)
  ));
  if (new Set(sourceLabels).size !== sourceLabels.length) {
    throw new StrategyPackageError(`${location}.sourceLabels`, "must not contain duplicates");
  }
  return Object.freeze({
    name: text(input.name, `${location}.name`, 120),
    category: text(input.category, `${location}.category`, 120),
    sourceLabels: Object.freeze(sourceLabels),
    headline: text(input.headline, `${location}.headline`, 500),
    auditVerdict: text(input.auditVerdict, `${location}.auditVerdict`, 240),
  });
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function transaction(value: unknown, location: string): LoadedStrategyTransaction {
  const input = object(value, location);
  exactKeys(input, ["transactionId", "date", "symbol", "side", "shares", "price", "fee"], location);
  const transactionId = text(input.transactionId, `${location}.transactionId`, 80);
  if (!TRANSACTION_ID.test(transactionId)) {
    throw new StrategyPackageError(`${location}.transactionId`, "has an invalid format");
  }
  const date = text(input.date, `${location}.date`, 10);
  if (!validDate(date)) throw new StrategyPackageError(`${location}.date`, "must be a valid YYYY-MM-DD date");
  const symbol = text(input.symbol, `${location}.symbol`, 15);
  if (symbol !== symbol.toUpperCase() || !SYMBOL.test(symbol)) {
    throw new StrategyPackageError(`${location}.symbol`, "must be an uppercase market symbol");
  }
  if (input.side !== "buy" && input.side !== "sell" && input.side !== "dividend") {
    throw new StrategyPackageError(`${location}.side`, "must be buy, sell, or dividend");
  }
  const shares = nullableMetric(input.shares, `${location}.shares`);
  const price = nullableMetric(input.price, `${location}.price`);
  const fee = nullableMetric(input.fee, `${location}.fee`);
  if (shares === null || shares <= 0 || price === null || price < 0 || fee === null || fee < 0) {
    throw new StrategyPackageError(location, "shares must be positive and price/fee non-negative");
  }
  return Object.freeze({ transactionId, date, symbol, side: input.side, shares, price, fee });
}

function vectorbtOrderId(transactionId: string): bigint | null {
  const match = /^vbt-order-\d+-(\d+)$/.exec(transactionId);
  return match ? BigInt(match[1]) : null;
}

export function newestTransactionFirst(
  left: LoadedStrategyTransaction,
  right: LoadedStrategyTransaction,
): number {
  const byDate = right.date.localeCompare(left.date);
  if (byDate !== 0) return byDate;
  const leftOrderId = vectorbtOrderId(left.transactionId);
  const rightOrderId = vectorbtOrderId(right.transactionId);
  if (leftOrderId !== null && rightOrderId !== null) {
    if (leftOrderId < rightOrderId) return 1;
    if (leftOrderId > rightOrderId) return -1;
    return right.transactionId.localeCompare(left.transactionId);
  }
  if (leftOrderId !== null) return -1;
  if (rightOrderId !== null) return 1;
  return right.transactionId.localeCompare(left.transactionId);
}

function requiredRunId(value: unknown, location: string): string {
  const parsed = nullableRunId(value, location);
  if (parsed === null || !RUN_ID.test(parsed)) {
    throw new StrategyPackageError(location, "must be a supported non-null run ID");
  }
  return parsed;
}

function requiredTimestamp(value: unknown, location: string): string {
  const parsed = nullableTimestamp(value, location);
  if (parsed === null || new Date(parsed).toISOString() !== parsed) {
    throw new StrategyPackageError(location, "must be a canonical UTC ISO timestamp");
  }
  return parsed;
}

function runMetadata(
  value: unknown,
  slug: string,
  version: string,
  expectedRunId: string,
  expectedGeneratedAt: string,
  transactions: readonly LoadedStrategyTransaction[],
  finalCashMetric: number | null,
): LoadedStrategyRun {
  const location = `${slug}/run.json`;
  const input = object(value, location);
  exactKeys(input, [
    "schemaVersion",
    "metricsDefinitionVersion",
    "strategyId",
    "strategyVersion",
    "runId",
    "generatedAt",
    "data",
    "reproducibility",
    "execution",
    "benchmark",
    "warnings",
  ], location);
  if (input.schemaVersion !== "trader.strategy-run.v1") {
    throw new StrategyPackageError(`${location}.schemaVersion`, "unsupported schema");
  }
  if (input.metricsDefinitionVersion !== "trader.strategy-metrics.v1") {
    throw new StrategyPackageError(`${location}.metricsDefinitionVersion`, "unsupported metric definitions");
  }
  if (input.strategyId !== slug || input.strategyVersion !== version) {
    throw new StrategyPackageError(location, "strategy identity does not match config");
  }
  const runId = requiredRunId(input.runId, `${location}.runId`);
  const generatedAt = requiredTimestamp(input.generatedAt, `${location}.generatedAt`);
  if (runId !== expectedRunId || generatedAt !== expectedGeneratedAt) {
    throw new StrategyPackageError(location, "run identity does not match performance and transactions");
  }

  const rawData = object(input.data, `${location}.data`);
  exactKeys(rawData, [
    "provider",
    "providerVersion",
    "symbols",
    "interval",
    "requestedStart",
    "requestedEndExclusive",
    "evaluationStart",
    "evaluationEndExclusive",
    "start",
    "end",
    "adjustment",
    "timezone",
    "sha256",
  ], `${location}.data`);
  if (!Array.isArray(rawData.symbols) || rawData.symbols.length === 0 || rawData.symbols.length > 10_000) {
    throw new StrategyPackageError(`${location}.data.symbols`, "must be a non-empty supported array");
  }
  const symbols = rawData.symbols.map((value, index) => {
    const symbol = text(value, `${location}.data.symbols[${index}]`, 15);
    if (symbol !== symbol.toUpperCase() || !SYMBOL.test(symbol)) {
      throw new StrategyPackageError(`${location}.data.symbols[${index}]`, "must be an uppercase market symbol");
    }
    return symbol;
  });
  if (new Set(symbols).size !== symbols.length) {
    throw new StrategyPackageError(`${location}.data.symbols`, "must not contain duplicates");
  }
  const requestedStart = text(rawData.requestedStart, `${location}.data.requestedStart`, 10);
  const requestedEndExclusive = text(
    rawData.requestedEndExclusive,
    `${location}.data.requestedEndExclusive`,
    10,
  );
  const evaluationStart = text(rawData.evaluationStart, `${location}.data.evaluationStart`, 10);
  const evaluationEndExclusive = text(
    rawData.evaluationEndExclusive,
    `${location}.data.evaluationEndExclusive`,
    10,
  );
  const start = text(rawData.start, `${location}.data.start`, 10);
  const end = text(rawData.end, `${location}.data.end`, 10);
  for (const [field, date] of [
    ["requestedStart", requestedStart],
    ["requestedEndExclusive", requestedEndExclusive],
    ["evaluationStart", evaluationStart],
    ["evaluationEndExclusive", evaluationEndExclusive],
    ["start", start],
    ["end", end],
  ] as const) {
    if (!validDate(date)) {
      throw new StrategyPackageError(`${location}.data.${field}`, "must be a valid YYYY-MM-DD date");
    }
  }
  if (
    requestedStart >= requestedEndExclusive
    || evaluationStart >= evaluationEndExclusive
    || evaluationStart < requestedStart
    || evaluationEndExclusive > requestedEndExclusive
    || start > end
    || start < requestedStart
    || end >= requestedEndExclusive
    || start > evaluationStart
    || end < evaluationStart
    || end >= evaluationEndExclusive
  ) {
    throw new StrategyPackageError(`${location}.data`, "actual and requested date ranges are inconsistent");
  }
  const universe = new Set(symbols);
  if (transactions.some(({ symbol }) => !universe.has(symbol))) {
    throw new StrategyPackageError(`${location}.data.symbols`, "must contain every transaction symbol");
  }
  if (transactions.some(({ date }) => date < evaluationStart || date >= evaluationEndExclusive)) {
    throw new StrategyPackageError(`${location}.data`, "transaction dates must fall within the evaluation range");
  }
  const data = Object.freeze({
    provider: text(rawData.provider, `${location}.data.provider`, 80),
    providerVersion: text(rawData.providerVersion, `${location}.data.providerVersion`, 128),
    symbols: Object.freeze(symbols),
    interval: text(rawData.interval, `${location}.data.interval`, 32),
    requestedStart,
    requestedEndExclusive,
    evaluationStart,
    evaluationEndExclusive,
    start,
    end,
    adjustment: text(rawData.adjustment, `${location}.data.adjustment`, 128),
    timezone: text(rawData.timezone, `${location}.data.timezone`, 80),
    sha256: sha256(rawData.sha256, `${location}.data.sha256`),
  });

  const rawReproducibility = object(input.reproducibility, `${location}.reproducibility`);
  exactKeys(rawReproducibility, [
    "configSha256",
    "codeSha256",
    "runnerSha256",
    "runtime",
    "effectiveParameters",
    "annualizationDays",
    "annualRiskFreeRate",
    "periodicRiskFreeRate",
  ], `${location}.reproducibility`);
  const rawRuntime = object(rawReproducibility.runtime, `${location}.reproducibility.runtime`);
  const requiredRuntimeKeys = [
    "python", "numpy", "pandas", "numba", "scipy", "vectorbt", "talib", "yfinance", "lightgbm",
  ];
  for (const key of requiredRuntimeKeys) {
    if (!Object.hasOwn(rawRuntime, key)) {
      throw new StrategyPackageError(`${location}.reproducibility.runtime.${key}`, "field is required");
    }
  }
  if (Object.keys(rawRuntime).length > 32) {
    throw new StrategyPackageError(`${location}.reproducibility.runtime`, "contains too many fields");
  }
  const runtime: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawRuntime).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) {
      throw new StrategyPackageError(`${location}.reproducibility.runtime.${key}`, "has an invalid key");
    }
    runtime[key] = text(value, `${location}.reproducibility.runtime.${key}`, 128);
  }
  const rawParameters = object(
    rawReproducibility.effectiveParameters,
    `${location}.reproducibility.effectiveParameters`,
  );
  const effectiveParameters = jsonValue(
    rawParameters,
    `${location}.reproducibility.effectiveParameters`,
  ) as Readonly<Record<string, LoadedStrategyJsonValue>>;
  const annualizationDays = integer(
    rawReproducibility.annualizationDays,
    `${location}.reproducibility.annualizationDays`,
    { minimum: 1, maximum: 366 },
  );
  const annualRiskFreeRate = finiteNumber(
    rawReproducibility.annualRiskFreeRate,
    `${location}.reproducibility.annualRiskFreeRate`,
  );
  const periodicRiskFreeRate = finiteNumber(
    rawReproducibility.periodicRiskFreeRate,
    `${location}.reproducibility.periodicRiskFreeRate`,
  );
  if (annualRiskFreeRate <= -1 || periodicRiskFreeRate <= -1) {
    throw new StrategyPackageError(`${location}.reproducibility`, "risk-free rates must be greater than -1");
  }
  const reproducibility = Object.freeze({
    configSha256: sha256(rawReproducibility.configSha256, `${location}.reproducibility.configSha256`),
    codeSha256: sha256(rawReproducibility.codeSha256, `${location}.reproducibility.codeSha256`),
    runnerSha256: sha256(rawReproducibility.runnerSha256, `${location}.reproducibility.runnerSha256`),
    runtime: Object.freeze(runtime),
    effectiveParameters,
    annualizationDays,
    annualRiskFreeRate,
    periodicRiskFreeRate,
  });

  const rawExecution = object(input.execution, `${location}.execution`);
  exactKeys(rawExecution, [
    "transactionMapping",
    "orderCount",
    "closedTradeCount",
    "openTradeCount",
    "totalTradeCount",
    "totalFees",
    "finalValue",
    "finalCashPercent",
    "finalPositions",
    "cagr",
  ], `${location}.execution`);
  if (rawExecution.transactionMapping !== "vectorbt_filled_orders") {
    throw new StrategyPackageError(`${location}.execution.transactionMapping`, "unsupported mapping");
  }
  const orderCount = integer(rawExecution.orderCount, `${location}.execution.orderCount`, {
    minimum: 0,
    maximum: MAX_TRANSACTIONS,
  });
  const closedTradeCount = integer(
    rawExecution.closedTradeCount,
    `${location}.execution.closedTradeCount`,
    { minimum: 0, maximum: MAX_TRANSACTIONS },
  );
  const openTradeCount = integer(
    rawExecution.openTradeCount,
    `${location}.execution.openTradeCount`,
    { minimum: 0, maximum: MAX_TRANSACTIONS },
  );
  const totalTradeCount = integer(
    rawExecution.totalTradeCount,
    `${location}.execution.totalTradeCount`,
    { minimum: 0, maximum: MAX_TRANSACTIONS },
  );
  if (orderCount !== transactions.length) {
    throw new StrategyPackageError(`${location}.execution.orderCount`, "must match transactions.json");
  }
  if (totalTradeCount !== closedTradeCount + openTradeCount) {
    throw new StrategyPackageError(`${location}.execution.totalTradeCount`, "must equal closed plus open trades");
  }
  const finalValue = rawExecution.finalValue === null
    ? null
    : finiteNumber(rawExecution.finalValue, `${location}.execution.finalValue`, { minimum: 0 });
  const finalCashPercent = rawExecution.finalCashPercent === null
    ? null
    : finiteNumber(rawExecution.finalCashPercent, `${location}.execution.finalCashPercent`, {
      minimum: 0,
      maximum: 100,
    });
  if (finalCashPercent !== finalCashMetric) {
    throw new StrategyPackageError(`${location}.execution.finalCashPercent`, "must match performance.json");
  }
  if (!Array.isArray(rawExecution.finalPositions) || rawExecution.finalPositions.length > symbols.length) {
    throw new StrategyPackageError(
      `${location}.execution.finalPositions`,
      "must be an array no longer than the declared universe",
    );
  }
  const finalPositionSymbols = new Set<string>();
  const finalPositions = rawExecution.finalPositions.map((value, index) => {
    const positionLocation = `${location}.execution.finalPositions[${index}]`;
    const position = object(value, positionLocation);
    exactKeys(position, [
      "symbol",
      "shares",
      "averageCost",
      "markPrice",
      "marketValue",
      "allocationPercent",
      "unrealizedPnl",
    ], positionLocation);
    const symbol = text(position.symbol, `${positionLocation}.symbol`, 15);
    if (symbol !== symbol.toUpperCase() || !SYMBOL.test(symbol)) {
      throw new StrategyPackageError(`${positionLocation}.symbol`, "must be an uppercase market symbol");
    }
    if (!universe.has(symbol)) {
      throw new StrategyPackageError(`${positionLocation}.symbol`, "must belong to the declared universe");
    }
    if (finalPositionSymbols.has(symbol)) {
      throw new StrategyPackageError(`${positionLocation}.symbol`, "must be unique");
    }
    finalPositionSymbols.add(symbol);
    const shares = finiteNumber(position.shares, `${positionLocation}.shares`, { minimum: 0 });
    const averageCost = finiteNumber(position.averageCost, `${positionLocation}.averageCost`, { minimum: 0 });
    const markPrice = finiteNumber(position.markPrice, `${positionLocation}.markPrice`, { minimum: 0 });
    const marketValue = finiteNumber(position.marketValue, `${positionLocation}.marketValue`, { minimum: 0 });
    const allocationPercent = finiteNumber(
      position.allocationPercent,
      `${positionLocation}.allocationPercent`,
      { minimum: 0, maximum: 100 },
    );
    const unrealizedPnl = finiteNumber(position.unrealizedPnl, `${positionLocation}.unrealizedPnl`);
    if (shares <= 0 || averageCost <= 0 || markPrice <= 0 || marketValue <= 0 || allocationPercent <= 0) {
      throw new StrategyPackageError(positionLocation, "position quantities, prices, value, and allocation must be positive");
    }
    if (!approximatelyEqual(shares * markPrice, marketValue)) {
      throw new StrategyPackageError(positionLocation, "shares times mark price must equal market value");
    }
    if (!approximatelyEqual(marketValue - shares * averageCost, unrealizedPnl)) {
      throw new StrategyPackageError(positionLocation, "market value less cost basis must equal unrealized PnL");
    }
    if (finalValue === null || finalValue <= 0 || finalCashPercent === null) {
      throw new StrategyPackageError(positionLocation, "requires final value and cash percentage");
    }
    if (!approximatelyEqual(marketValue / finalValue * 100, allocationPercent)) {
      throw new StrategyPackageError(`${positionLocation}.allocationPercent`, "must equal its share of final value");
    }
    return Object.freeze({
      symbol,
      shares,
      averageCost,
      markPrice,
      marketValue,
      allocationPercent,
      unrealizedPnl,
    });
  });
  if (finalPositions.length !== openTradeCount) {
    throw new StrategyPackageError(
      `${location}.execution.finalPositions`,
      "must contain exactly one row per open trade",
    );
  }
  if (finalValue !== null && finalCashPercent !== null) {
    const holdingsValue = finalPositions.reduce((sum, position) => sum + position.marketValue, 0);
    const expectedHoldingsValue = finalValue * (1 - finalCashPercent / 100);
    if (!approximatelyEqual(holdingsValue, expectedHoldingsValue)) {
      throw new StrategyPackageError(
        `${location}.execution.finalPositions`,
        "market values and cash must reconcile to final value",
      );
    }
    const totalAllocation = finalPositions.reduce(
      (sum, position) => sum + position.allocationPercent,
      finalCashPercent,
    );
    if (!approximatelyEqual(totalAllocation, 100)) {
      throw new StrategyPackageError(
        `${location}.execution.finalPositions`,
        "allocations and cash must total 100%",
      );
    }
  }
  const execution = Object.freeze({
    transactionMapping: "vectorbt_filled_orders" as const,
    orderCount,
    closedTradeCount,
    openTradeCount,
    totalTradeCount,
    totalFees: finiteNumber(rawExecution.totalFees, `${location}.execution.totalFees`, { minimum: 0 }),
    finalValue,
    finalCashPercent,
    finalPositions: Object.freeze(finalPositions),
    cagr: rawExecution.cagr === null
      ? null
      : finiteNumber(rawExecution.cagr, `${location}.execution.cagr`),
  });

  let benchmark: LoadedStrategyRun["benchmark"] = null;
  if (input.benchmark !== null) {
    const rawBenchmark = object(input.benchmark, `${location}.benchmark`);
    exactKeys(rawBenchmark, ["symbol", "returnType", "costsApplied", "dataSha256", "metrics"], `${location}.benchmark`);
    if (typeof rawBenchmark.costsApplied !== "boolean") {
      throw new StrategyPackageError(`${location}.benchmark.costsApplied`, "must be a boolean");
    }
    const rawBenchmarkMetrics = object(rawBenchmark.metrics, `${location}.benchmark.metrics`);
    exactKeys(rawBenchmarkMetrics, [
      "netReturn", "maxDrawdown", "sharpe", "cagr", "excessReturn",
    ], `${location}.benchmark.metrics`);
    const maxDrawdown = nullableMetric(
      rawBenchmarkMetrics.maxDrawdown,
      `${location}.benchmark.metrics.maxDrawdown`,
    );
    if (maxDrawdown !== null && maxDrawdown > 0) {
      throw new StrategyPackageError(`${location}.benchmark.metrics.maxDrawdown`, "must be non-positive");
    }
    benchmark = Object.freeze({
      symbol: text(rawBenchmark.symbol, `${location}.benchmark.symbol`, 32),
      returnType: text(rawBenchmark.returnType, `${location}.benchmark.returnType`, 32),
      costsApplied: rawBenchmark.costsApplied,
      dataSha256: rawBenchmark.dataSha256 === null
        ? null
        : sha256(rawBenchmark.dataSha256, `${location}.benchmark.dataSha256`),
      metrics: Object.freeze({
        netReturn: nullableMetric(rawBenchmarkMetrics.netReturn, `${location}.benchmark.metrics.netReturn`),
        maxDrawdown,
        sharpe: nullableMetric(rawBenchmarkMetrics.sharpe, `${location}.benchmark.metrics.sharpe`),
        cagr: nullableMetric(rawBenchmarkMetrics.cagr, `${location}.benchmark.metrics.cagr`),
        excessReturn: nullableMetric(
          rawBenchmarkMetrics.excessReturn,
          `${location}.benchmark.metrics.excessReturn`,
        ),
      }),
    });
  }

  if (!Array.isArray(input.warnings) || input.warnings.length > 100) {
    throw new StrategyPackageError(`${location}.warnings`, "must contain at most 100 warning strings");
  }
  const warnings = input.warnings.map((warning, index) => (
    text(warning, `${location}.warnings[${index}]`, 500)
  ));

  return Object.freeze({
    runId,
    generatedAt,
    metricsDefinitionVersion: "trader.strategy-metrics.v1" as const,
    data,
    reproducibility,
    execution,
    benchmark,
    warnings: Object.freeze(warnings),
  });
}

function equityArtifact(
  value: unknown,
  slug: string,
  version: string,
  expectedRunId: string,
  expectedGeneratedAt: string,
  run: LoadedStrategyRun,
  performance: Omit<LoadedStrategyPackage["performance"], "provenance">,
): LoadedStrategyEquity {
  const location = `${slug}/equity.json`;
  const input = object(value, location);
  exactKeys(input, [
    "schemaVersion",
    "strategyId",
    "strategyVersion",
    "runId",
    "generatedAt",
    "frequency",
    "initialValue",
    "points",
  ], location);
  if (input.schemaVersion !== "trader.strategy-equity.v1") {
    throw new StrategyPackageError(`${location}.schemaVersion`, "unsupported schema");
  }
  if (
    input.strategyId !== slug
    || input.strategyVersion !== version
    || input.runId !== expectedRunId
    || input.generatedAt !== expectedGeneratedAt
  ) {
    throw new StrategyPackageError(location, "run identity does not match the other artifacts");
  }
  if (input.frequency !== "1d") {
    throw new StrategyPackageError(`${location}.frequency`, "must be 1d");
  }
  const initialValue = finiteNumber(
    input.initialValue,
    `${location}.initialValue`,
    { minimum: 0 },
  );
  if (initialValue === 0) {
    throw new StrategyPackageError(`${location}.initialValue`, "must be greater than zero");
  }
  if (!Array.isArray(input.points) || input.points.length === 0 || input.points.length > MAX_EQUITY_POINTS) {
    throw new StrategyPackageError(
      `${location}.points`,
      `must contain 1-${MAX_EQUITY_POINTS} daily points`,
    );
  }
  let previousDate: string | null = null;
  const points = input.points.map((value, index) => {
    const pointLocation = `${location}.points[${index}]`;
    const point = object(value, pointLocation);
    exactKeys(point, ["date", "portfolioValue", "benchmarkValue"], pointLocation);
    const date = text(point.date, `${pointLocation}.date`, 10);
    if (!validDate(date)) {
      throw new StrategyPackageError(`${pointLocation}.date`, "must be a valid YYYY-MM-DD date");
    }
    if (
      date < run.data.evaluationStart
      || date >= run.data.evaluationEndExclusive
      || date < run.data.start
      || date > run.data.end
      || (previousDate !== null && date <= previousDate)
    ) {
      throw new StrategyPackageError(`${pointLocation}.date`, "must be unique, increasing, and within the run range");
    }
    previousDate = date;
    const portfolioValue = finiteNumber(
      point.portfolioValue,
      `${pointLocation}.portfolioValue`,
      { minimum: 0 },
    );
    const benchmarkValue = point.benchmarkValue === null
      ? null
      : finiteNumber(point.benchmarkValue, `${pointLocation}.benchmarkValue`, { minimum: 0 });
    if ((run.benchmark === null) !== (benchmarkValue === null)) {
      throw new StrategyPackageError(
        `${pointLocation}.benchmarkValue`,
        "must match benchmark availability in run.json",
      );
    }
    return Object.freeze({ date, portfolioValue, benchmarkValue });
  });
  const finalPoint = points[points.length - 1];
  const finalValue = run.execution.finalValue;
  if (finalValue === null || !approximatelyEqual(finalPoint.portfolioValue, finalValue)) {
    throw new StrategyPackageError(
      `${location}.points`,
      "final portfolio value must match run.json",
    );
  }
  if (finalPoint.date !== run.data.end) {
    throw new StrategyPackageError(
      `${location}.points`,
      "final point date must match the run's final data date",
    );
  }
  const netReturn = (finalPoint.portfolioValue / initialValue - 1) * 100;
  if (performance.netReturn === null || !approximatelyEqual(netReturn, performance.netReturn)) {
    throw new StrategyPackageError(
      `${location}.points`,
      "portfolio values must reproduce performance netReturn",
    );
  }
  if (run.benchmark !== null) {
    if (finalPoint.benchmarkValue === null) {
      throw new StrategyPackageError(`${location}.points`, "benchmark values are incomplete");
    }
    const benchmarkReturn = (finalPoint.benchmarkValue / initialValue - 1) * 100;
    if (
      run.benchmark.metrics.netReturn === null
      || !approximatelyEqual(benchmarkReturn, run.benchmark.metrics.netReturn)
    ) {
      throw new StrategyPackageError(
        `${location}.points`,
        "benchmark values must reproduce run.json netReturn",
      );
    }
  }
  return Object.freeze({
    frequency: "1d" as const,
    initialValue,
    points: Object.freeze(points),
  });
}

async function loadOne(rootRealPath: string, slug: string): Promise<LoadedStrategyPackage> {
  if (!STRATEGY_SLUG.test(slug)) throw new StrategyPackageError(slug, "invalid strategy directory name");
  const packagePath = path.join(rootRealPath, slug);
  const packageRealPath = await realpath(packagePath);
  if (!packageRealPath.startsWith(`${rootRealPath}${path.sep}`)) {
    throw new StrategyPackageError(packagePath, "resolves outside strategies root");
  }
  const main = await lstat(path.join(packagePath, "main.py")).catch(() => null);
  if (!main?.isFile() || main.isSymbolicLink()) {
    throw new StrategyPackageError(`${slug}/main.py`, "required regular file is missing");
  }

  const [rawConfig, rawPerformance, rawTransactions] = await Promise.all([
    readJson(path.join(packagePath, "config.json"), MAX_JSON_BYTES),
    readJson(path.join(packagePath, "performance.json"), MAX_JSON_BYTES),
    readJson(path.join(packagePath, "transactions.json"), MAX_TRANSACTIONS_BYTES),
  ]);

  const config = object(rawConfig, `${slug}/config.json`);
  exactKeys(config, [
    "schemaVersion", "id", "name", "version", "display", "entrypoint",
    "runtimeProfile", "interface", "marketData", "parameters", "backtest",
  ], `${slug}/config.json`);
  if (config.schemaVersion !== "trader.strategy-package.v1") {
    throw new StrategyPackageError(`${slug}/config.json.schemaVersion`, "unsupported schema");
  }
  if (config.id !== slug) throw new StrategyPackageError(`${slug}/config.json.id`, "must match directory name");
  const version = text(config.version, `${slug}/config.json.version`, 64);
  if (!SEMVER.test(version)) throw new StrategyPackageError(`${slug}/config.json.version`, "must use semantic versioning");
  if (config.entrypoint !== "main.py:generate") {
    throw new StrategyPackageError(`${slug}/config.json.entrypoint`, "must be main.py:generate");
  }

  const display = object(config.display, `${slug}/config.json.display`);
  exactKeys(display, ["order", "family", "status", "candidateAt", "audit", "copy"], `${slug}/config.json.display`);
  if (!Number.isSafeInteger(display.order) || (display.order as number) < 0) {
    throw new StrategyPackageError(`${slug}/config.json.display.order`, "must be a non-negative integer");
  }
  if (display.family !== "portfolio2" && display.family !== "rule" && display.family !== "research") {
    throw new StrategyPackageError(`${slug}/config.json.display.family`, "unsupported family");
  }
  if (display.status !== "pinned" && display.status !== "research") {
    throw new StrategyPackageError(`${slug}/config.json.display.status`, "unsupported status");
  }
  const audit = object(display.audit, `${slug}/config.json.display.audit`);
  exactKeys(audit, ["overfit", "leakage"], `${slug}/config.json.display.audit`);
  const copy = object(display.copy, `${slug}/config.json.display.copy`);
  exactKeys(copy, ["en", "ja"], `${slug}/config.json.display.copy`);

  const performance = object(rawPerformance, `${slug}/performance.json`);
  exactKeys(performance, [
    "schemaVersion", "strategyId", "strategyVersion", "runId", "generatedAt",
    "provenance", "metrics",
  ], `${slug}/performance.json`);
  if (performance.schemaVersion !== "trader.strategy-performance.v1") {
    throw new StrategyPackageError(`${slug}/performance.json.schemaVersion`, "unsupported schema");
  }
  if (performance.strategyId !== slug || performance.strategyVersion !== version) {
    throw new StrategyPackageError(`${slug}/performance.json`, "strategy identity does not match config");
  }
  if (performance.provenance !== "unavailable" && performance.provenance !== "backtest_artifact") {
    throw new StrategyPackageError(`${slug}/performance.json.provenance`, "unsupported provenance");
  }
  const metrics = object(performance.metrics, `${slug}/performance.json.metrics`);
  exactKeys(metrics, PERFORMANCE_KEYS, `${slug}/performance.json.metrics`);
  const normalizedMetrics = Object.fromEntries(PERFORMANCE_KEYS.map((key) => [
    key,
    key === "trades" || key === "symbols"
      ? nullableCount(metrics[key], `${slug}/performance.json.metrics.${key}`)
      : nullableMetric(metrics[key], `${slug}/performance.json.metrics.${key}`),
  ])) as unknown as Omit<LoadedStrategyPackage["performance"], "provenance">;
  if (normalizedMetrics.maxDrawdown !== null && normalizedMetrics.maxDrawdown > 0) {
    throw new StrategyPackageError(`${slug}/performance.json.metrics.maxDrawdown`, "must be non-positive");
  }
  for (const key of ["winRate", "cash"] as const) {
    const value = normalizedMetrics[key];
    if (value !== null && (value < 0 || value > 100)) {
      throw new StrategyPackageError(`${slug}/performance.json.metrics.${key}`, "must be between 0 and 100");
    }
  }

  const transactionsFile = object(rawTransactions, `${slug}/transactions.json`);
  exactKeys(transactionsFile, [
    "schemaVersion", "strategyId", "strategyVersion", "runId", "generatedAt", "transactions",
  ], `${slug}/transactions.json`);
  if (transactionsFile.schemaVersion !== "trader.strategy-transactions.v1") {
    throw new StrategyPackageError(`${slug}/transactions.json.schemaVersion`, "unsupported schema");
  }
  if (transactionsFile.strategyId !== slug || transactionsFile.strategyVersion !== version) {
    throw new StrategyPackageError(`${slug}/transactions.json`, "strategy identity does not match config");
  }
  const performanceRunId = nullableRunId(performance.runId, `${slug}/performance.json.runId`);
  const transactionsRunId = nullableRunId(transactionsFile.runId, `${slug}/transactions.json.runId`);
  const performanceGeneratedAt = nullableTimestamp(performance.generatedAt, `${slug}/performance.json.generatedAt`);
  const transactionsGeneratedAt = nullableTimestamp(transactionsFile.generatedAt, `${slug}/transactions.json.generatedAt`);
  if (performanceRunId !== transactionsRunId || performanceGeneratedAt !== transactionsGeneratedAt) {
    throw new StrategyPackageError(slug, "performance and transactions run metadata must match");
  }
  if (!Array.isArray(transactionsFile.transactions) || transactionsFile.transactions.length > MAX_TRANSACTIONS) {
    throw new StrategyPackageError(`${slug}/transactions.json.transactions`, `must contain at most ${MAX_TRANSACTIONS} rows`);
  }
  const transactions = transactionsFile.transactions.map((item, index) => (
    transaction(item, `${slug}/transactions.json.transactions[${index}]`)
  ));
  const ids = new Set(transactions.map(({ transactionId }) => transactionId));
  if (ids.size !== transactions.length) {
    throw new StrategyPackageError(`${slug}/transactions.json.transactions`, "transaction IDs must be unique");
  }
  transactions.sort(newestTransactionFirst);

  const runPath = path.join(packagePath, "run.json");
  const equityPath = path.join(packagePath, "equity.json");
  let run: LoadedStrategyRun | null = null;
  let equity: LoadedStrategyEquity | null = null;
  if (performanceRunId === null) {
    if (
      performanceGeneratedAt !== null
      || performance.provenance !== "unavailable"
      || Object.values(normalizedMetrics).some((value) => value !== null)
      || transactions.length > 0
    ) {
      throw new StrategyPackageError(slug, "an unexecuted package must contain only unavailable empty artifacts");
    }
    if (await lstat(runPath).catch(() => null)) {
      throw new StrategyPackageError(`${slug}/run.json`, "must be absent for an unexecuted package");
    }
    if (await lstat(equityPath).catch(() => null)) {
      throw new StrategyPackageError(`${slug}/equity.json`, "must be absent for an unexecuted package");
    }
  } else {
    if (performanceGeneratedAt === null || performance.provenance !== "backtest_artifact") {
      throw new StrategyPackageError(slug, "an executed package requires backtest_artifact provenance and generatedAt");
    }
    if (normalizedMetrics.trades !== null && normalizedMetrics.trades !== transactions.length) {
      throw new StrategyPackageError(slug, "performance trade count does not match transactions");
    }
    const symbolCount = new Set(transactions.map(({ symbol }) => symbol)).size;
    if (normalizedMetrics.symbols !== null && normalizedMetrics.symbols !== symbolCount) {
      throw new StrategyPackageError(slug, "performance symbol count does not match transactions");
    }
    run = runMetadata(
      await readJson(runPath, MAX_RUN_BYTES),
      slug,
      version,
      performanceRunId,
      performanceGeneratedAt,
      transactions,
      normalizedMetrics.cash,
    );
    const equityFile = await lstat(equityPath).catch(() => null);
    if (equityFile !== null) {
      if (!equityFile.isFile() || equityFile.isSymbolicLink()) {
        throw new StrategyPackageError(`${slug}/equity.json`, "must be a regular file");
      }
      equity = equityArtifact(
        await readJson(equityPath, MAX_EQUITY_BYTES),
        slug,
        version,
        performanceRunId,
        performanceGeneratedAt,
        run,
        normalizedMetrics,
      );
    }
  }

  return Object.freeze({
    id: slug,
    version,
    order: display.order as number,
    family: display.family,
    status: display.status,
    candidateAt: text(display.candidateAt, `${slug}/config.json.display.candidateAt`, 64),
    audit: Object.freeze({
      overfit: nullableMetric(audit.overfit, `${slug}/config.json.display.audit.overfit`),
      leakage: nullableMetric(audit.leakage, `${slug}/config.json.display.audit.leakage`),
    }),
    copy: Object.freeze({
      en: localeCopy(copy.en, `${slug}/config.json.display.copy.en`),
      ja: localeCopy(copy.ja, `${slug}/config.json.display.copy.ja`),
    }),
    performance: Object.freeze({
      provenance: performance.provenance,
      ...normalizedMetrics,
    }),
    run,
    equity,
    transactions: Object.freeze(transactions),
  });
}

export async function loadStrategyPackages(strategiesRoot: string): Promise<readonly LoadedStrategyPackage[]> {
  const rootRealPath = await realpath(strategiesRoot).catch(() => null);
  if (!rootRealPath) throw new StrategyPackageError(strategiesRoot, "strategies directory is missing");
  const entries = await readdir(rootRealPath, { withFileTypes: true });
  if (entries.length === 0) throw new StrategyPackageError(strategiesRoot, "must contain at least one strategy");
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new StrategyPackageError(entry.name, "strategies root may contain strategy directories only");
    }
  }
  const packages = await Promise.all(entries.map(({ name }) => loadOne(rootRealPath, name)));
  packages.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  if (new Set(packages.map(({ id }) => id)).size !== packages.length) {
    throw new StrategyPackageError(strategiesRoot, "strategy IDs must be unique");
  }
  return Object.freeze(packages);
}

export function renderGeneratedStrategyPackages(packages: readonly LoadedStrategyPackage[]): string {
  const payload = JSON.stringify(packages)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const payloadLiteral = JSON.stringify(payload);
  return [
    "/* Generated by npm run strategies:generate. Do not edit. */",
    "import type { LoadedStrategyPackage } from \"../../tooling/strategy-package-loader\";",
    "",
    "export const GENERATED_STRATEGY_PACKAGES =",
    `  JSON.parse(${payloadLiteral}) as readonly LoadedStrategyPackage[];`,
    "",
  ].join("\n");
}
