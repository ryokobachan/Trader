export const STRATEGIES_SCHEMA_VERSION = "unicorn.strategies.v1" as const;

const STRATEGY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const MAX_METRIC_ABS = 1_000_000_000_000;

export type StrategyOrigin = "built_in" | "custom";
export type StrategyFamily = "portfolio2" | "rule" | "research";
export type StrategyStatus = "pinned" | "research";
export type StrategyPerformanceProvenance =
  | "illustrative_catalog"
  | "user_supplied"
  | "transaction_snapshot"
  | "unavailable";

export type StrategyAudit = {
  overfit: number | null;
  leakage: number | null;
  verdict: string;
};

export type StrategyPerformance = {
  provenance: StrategyPerformanceProvenance;
  netReturn: number | null;
  maxDrawdown: number | null;
  recoveryFactor: number | null;
  sharpe: number | null;
  forwardReturn: number | null;
  winRate: number | null;
  trades: number | null;
  symbols: number | null;
  cash: number | null;
};

export type StrategyRecord = {
  id: string;
  origin: StrategyOrigin;
  version: number;
  family: StrategyFamily;
  status: StrategyStatus;
  candidateAt: string;
  name: string;
  category: string;
  sourceLabels: string[];
  headline: string;
  audit: StrategyAudit;
  performance: StrategyPerformance;
  createdAt: string | null;
  updatedAt: string | null;
};

export type StrategyPerformanceInput = Partial<
  Omit<StrategyPerformance, "provenance">
>;

export type CreateStrategyInput = {
  strategyId?: string;
  name: string;
  headline: string;
  family?: StrategyFamily;
  status?: StrategyStatus;
  candidateAt?: string;
  category?: string;
  sourceLabels?: string[];
  audit?: Partial<StrategyAudit>;
  performance?: StrategyPerformanceInput;
};

export type UpdateStrategyInput = {
  expectedVersion?: number;
  name?: string;
  headline?: string;
  family?: StrategyFamily;
  status?: StrategyStatus;
  candidateAt?: string;
  category?: string;
  sourceLabels?: string[];
  audit?: Partial<StrategyAudit>;
  performance?: StrategyPerformanceInput;
};

export type StrategiesResponse = {
  schemaVersion: typeof STRATEGIES_SCHEMA_VERSION;
  ownerId: string;
  strategies: StrategyRecord[];
};

export type StrategyMutationResponse = {
  schemaVersion: typeof STRATEGIES_SCHEMA_VERSION;
  strategy: StrategyRecord;
};

export type StrategyDetailResponse = StrategyMutationResponse & {
  ownerId: string;
  transactions?: import("./strategy-portfolio-contracts").StrategyPortfolioTransaction[];
  performance?: StrategyPerformance;
};

export type StrategyDeleteResponse = {
  schemaVersion: typeof STRATEGIES_SCHEMA_VERSION;
  deletedId: string;
  origin: StrategyOrigin;
  version: number;
  deletedAt: string;
};

export class StrategyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyInputError";
  }
}

export function normalizeStrategyRecordId(value: unknown): string {
  if (typeof value !== "string") throw new StrategyInputError("strategyId is required");
  const strategyId = value.normalize("NFKC").trim();
  if (!STRATEGY_ID_PATTERN.test(strategyId)) {
    throw new StrategyInputError("strategyId is invalid");
  }
  return strategyId;
}

function normalizeText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new StrategyInputError(`${field} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max || CONTROL_CHARACTERS.test(normalized)) {
    throw new StrategyInputError(`${field} must be between 1 and ${max} characters`);
  }
  return normalized;
}

function normalizeMetric(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_METRIC_ABS) {
    throw new StrategyInputError(`${field} must be null or a finite supported number`);
  }
  return value;
}

function normalizeCount(value: unknown, field: string): number | null {
  const normalized = normalizeMetric(value, field);
  if (normalized !== null && (!Number.isInteger(normalized) || normalized < 0)) {
    throw new StrategyInputError(`${field} must be null or a non-negative integer`);
  }
  return normalized;
}

function normalizeFamily(value: unknown): StrategyFamily {
  if (value !== "portfolio2" && value !== "rule" && value !== "research") {
    throw new StrategyInputError("family must be portfolio2, rule, or research");
  }
  return value;
}

function normalizeStatus(value: unknown): StrategyStatus {
  if (value !== "pinned" && value !== "research") {
    throw new StrategyInputError("status must be pinned or research");
  }
  return value;
}

function normalizeSourceLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 24) {
    throw new StrategyInputError("sourceLabels must be an array with at most 24 items");
  }
  const labels = value.map((label) => normalizeText(label, "sourceLabels item", 80));
  if (new Set(labels).size !== labels.length) {
    throw new StrategyInputError("sourceLabels must not contain duplicates");
  }
  return labels;
}

function own(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function normalizeAudit(value: unknown): Partial<StrategyAudit> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrategyInputError("audit must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["overfit", "leakage", "verdict"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new StrategyInputError("audit contains an unsupported field");
  }
  return {
    ...(own(input, "overfit") ? { overfit: normalizeMetric(input.overfit, "audit.overfit") } : {}),
    ...(own(input, "leakage") ? { leakage: normalizeMetric(input.leakage, "audit.leakage") } : {}),
    ...(own(input, "verdict")
      ? { verdict: normalizeText(input.verdict, "audit.verdict", 240) }
      : {}),
  };
}

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

function normalizePerformance(value: unknown): StrategyPerformanceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrategyInputError("performance must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !PERFORMANCE_KEYS.includes(key as never))) {
    throw new StrategyInputError("performance contains an unsupported field");
  }
  const output: StrategyPerformanceInput = {};
  for (const key of PERFORMANCE_KEYS) {
    if (!own(input, key)) continue;
    output[key] = key === "trades" || key === "symbols"
      ? normalizeCount(input[key], `performance.${key}`)
      : normalizeMetric(input[key], `performance.${key}`);
  }
  return output;
}

const CREATE_KEYS = new Set([
  "strategyId", "name", "headline", "family", "status", "candidateAt", "category",
  "sourceLabels", "audit", "performance",
]);
const UPDATE_KEYS = new Set([...CREATE_KEYS].filter((key) => key !== "strategyId").concat("expectedVersion"));

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrategyInputError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

export function normalizeCreateStrategyInput(value: unknown): CreateStrategyInput {
  const input = assertObject(value);
  if (Object.keys(input).some((key) => !CREATE_KEYS.has(key))) {
    throw new StrategyInputError("request body contains an unsupported field");
  }
  return {
    ...(own(input, "strategyId") ? { strategyId: normalizeStrategyRecordId(input.strategyId) } : {}),
    name: normalizeText(input.name, "name", 120),
    headline: normalizeText(input.headline, "headline", 500),
    ...(own(input, "family") ? { family: normalizeFamily(input.family) } : {}),
    ...(own(input, "status") ? { status: normalizeStatus(input.status) } : {}),
    ...(own(input, "candidateAt")
      ? { candidateAt: normalizeText(input.candidateAt, "candidateAt", 64) }
      : {}),
    ...(own(input, "category") ? { category: normalizeText(input.category, "category", 120) } : {}),
    ...(own(input, "sourceLabels") ? { sourceLabels: normalizeSourceLabels(input.sourceLabels) } : {}),
    ...(own(input, "audit") ? { audit: normalizeAudit(input.audit) } : {}),
    ...(own(input, "performance") ? { performance: normalizePerformance(input.performance) } : {}),
  };
}

export function normalizeUpdateStrategyInput(value: unknown): UpdateStrategyInput {
  const input = assertObject(value);
  if (Object.keys(input).some((key) => !UPDATE_KEYS.has(key))) {
    throw new StrategyInputError("request body contains an unsupported field");
  }
  const editableKeys = [...UPDATE_KEYS].filter((key) => key !== "expectedVersion");
  if (!editableKeys.some((key) => own(input, key))) {
    throw new StrategyInputError("at least one editable field is required");
  }
  let expectedVersion: number | undefined;
  if (own(input, "expectedVersion")) {
    if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
      throw new StrategyInputError("expectedVersion must be a positive integer");
    }
    expectedVersion = input.expectedVersion as number;
  }
  return {
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    ...(own(input, "name") ? { name: normalizeText(input.name, "name", 120) } : {}),
    ...(own(input, "headline") ? { headline: normalizeText(input.headline, "headline", 500) } : {}),
    ...(own(input, "family") ? { family: normalizeFamily(input.family) } : {}),
    ...(own(input, "status") ? { status: normalizeStatus(input.status) } : {}),
    ...(own(input, "candidateAt")
      ? { candidateAt: normalizeText(input.candidateAt, "candidateAt", 64) }
      : {}),
    ...(own(input, "category") ? { category: normalizeText(input.category, "category", 120) } : {}),
    ...(own(input, "sourceLabels") ? { sourceLabels: normalizeSourceLabels(input.sourceLabels) } : {}),
    ...(own(input, "audit") ? { audit: normalizeAudit(input.audit) } : {}),
    ...(own(input, "performance") ? { performance: normalizePerformance(input.performance) } : {}),
  };
}

export function normalizeExpectedStrategyVersion(value: unknown): number {
  const version = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new StrategyInputError("expectedVersion must be a positive integer");
  }
  return version as number;
}

/**
 * A transaction ledger alone cannot prove returns or risk statistics. It can,
 * however, provide exact activity and symbol counts without fabricating the
 * remaining fields.
 */
export function performanceFromTransactionLedger(
  current: StrategyPerformance,
  transactions: readonly Pick<
    import("./strategy-portfolio-contracts").StrategyPortfolioTransaction,
    "symbol"
  >[],
): StrategyPerformance {
  if (current.provenance !== "unavailable" || transactions.length === 0) return current;
  return {
    ...current,
    provenance: "transaction_snapshot",
    trades: transactions.length,
    symbols: new Set(transactions.map((transaction) => transaction.symbol)).size,
  };
}
