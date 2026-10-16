export const STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION =
  "trader.strategy-portfolio-transactions.v1" as const;

const STRATEGY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_QUANTITY = 1_000_000_000_000;
const MAX_MONEY_VALUE = 1_000_000_000_000;

export type StrategyPortfolioTransactionSide = "buy" | "sell" | "dividend";

export type StrategyPortfolioTransaction = {
  strategyId: string;
  transactionId: string;
  date: string;
  symbol: string;
  side: StrategyPortfolioTransactionSide;
  shares: number;
  price: number;
  fee: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateStrategyPortfolioTransactionInput = {
  transactionId?: string;
  date: string;
  symbol: string;
  side: StrategyPortfolioTransactionSide;
  shares: number;
  price: number;
  fee: number;
};

export type UpdateStrategyPortfolioTransactionInput = Omit<
  CreateStrategyPortfolioTransactionInput,
  "transactionId"
> & {
  /** Exact `updatedAt` token returned by the latest transaction read. */
  expectedUpdatedAt: string;
};

export type StrategyPortfolioTransactionsResponse = {
  schemaVersion: typeof STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION;
  ownerId: string;
  strategyId: string;
  transactions: StrategyPortfolioTransaction[];
};

export type StrategyPortfolioTransactionMutationResponse = {
  schemaVersion: typeof STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION;
  transaction: StrategyPortfolioTransaction;
};

export type StrategyPortfolioTransactionDeleteResponse = {
  schemaVersion: typeof STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION;
  strategyId: string;
  deletedId: string;
  deleted: boolean;
};

export class StrategyPortfolioTransactionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyPortfolioTransactionInputError";
  }
}

export function normalizeStrategyId(value: unknown): string {
  if (typeof value !== "string") {
    throw new StrategyPortfolioTransactionInputError("strategyId is required");
  }
  const strategyId = value.normalize("NFKC").trim();
  if (!STRATEGY_ID_PATTERN.test(strategyId)) {
    throw new StrategyPortfolioTransactionInputError("strategyId is invalid");
  }
  return strategyId;
}

export function normalizeStrategyPortfolioTransactionId(
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new StrategyPortfolioTransactionInputError("transactionId is required");
  }
  const transactionId = value.normalize("NFKC").trim();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new StrategyPortfolioTransactionInputError("transactionId is invalid");
  }
  return transactionId;
}

function normalizeOptionalTransactionId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeStrategyPortfolioTransactionId(value);
}

function normalizeDate(value: unknown): string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new StrategyPortfolioTransactionInputError("date must use YYYY-MM-DD");
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    throw new StrategyPortfolioTransactionInputError("date is not a valid calendar date");
  }
  return value;
}

function normalizeNumber(
  value: unknown,
  field: string,
  options: { positive?: boolean; maximum: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StrategyPortfolioTransactionInputError(`${field} must be a finite number`);
  }
  const minimumValid = options.positive ? value > 0 : value >= 0;
  if (!minimumValid || value > options.maximum) {
    throw new StrategyPortfolioTransactionInputError(`${field} is outside the supported range`);
  }
  return value;
}

export function normalizeStrategyPortfolioTransactionInput(
  value: unknown,
): CreateStrategyPortfolioTransactionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrategyPortfolioTransactionInputError("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.symbol !== "string") {
    throw new StrategyPortfolioTransactionInputError("symbol is required");
  }
  const symbol = input.symbol.normalize("NFKC").trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new StrategyPortfolioTransactionInputError("symbol is invalid");
  }
  if (input.side !== "buy" && input.side !== "sell" && input.side !== "dividend") {
    throw new StrategyPortfolioTransactionInputError("side must be buy, sell, or dividend");
  }

  return {
    transactionId: normalizeOptionalTransactionId(input.transactionId),
    date: normalizeDate(input.date),
    symbol,
    side: input.side,
    shares: normalizeNumber(input.shares, "shares", {
      positive: true,
      maximum: MAX_QUANTITY,
    }),
    price: normalizeNumber(input.price, "price", { maximum: MAX_MONEY_VALUE }),
    fee: normalizeNumber(input.fee ?? 0, "fee", { maximum: MAX_MONEY_VALUE }),
  };
}

export function normalizeStrategyPortfolioTransactionUpdateInput(
  value: unknown,
): UpdateStrategyPortfolioTransactionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrategyPortfolioTransactionInputError("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "date",
    "symbol",
    "side",
    "shares",
    "price",
    "fee",
    "expectedUpdatedAt",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new StrategyPortfolioTransactionInputError(
      "only date, symbol, side, shares, price, fee, and expectedUpdatedAt can be supplied",
    );
  }
  if (
    typeof input.expectedUpdatedAt !== "string"
    || input.expectedUpdatedAt.length === 0
    || input.expectedUpdatedAt.length > 64
    || input.expectedUpdatedAt.trim() !== input.expectedUpdatedAt
    || /[\u0000-\u001f\u007f]/.test(input.expectedUpdatedAt)
  ) {
    throw new StrategyPortfolioTransactionInputError(
      "expectedUpdatedAt must be the exact updatedAt value from the latest transaction read",
    );
  }
  const normalized = normalizeStrategyPortfolioTransactionInput(input);
  return {
    date: normalized.date,
    symbol: normalized.symbol,
    side: normalized.side,
    shares: normalized.shares,
    price: normalized.price,
    fee: normalized.fee,
    expectedUpdatedAt: input.expectedUpdatedAt,
  };
}
