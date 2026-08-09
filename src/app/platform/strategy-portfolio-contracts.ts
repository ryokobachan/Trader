export const STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION =
  "unicorn.strategy-portfolio-transactions.v1" as const;

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

export { SAMPLE_STRATEGY_TRANSACTIONS as INITIAL_STRATEGY_PORTFOLIO_TRANSACTIONS } from "@strategies/sample-transactions";

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

function normalizeTransactionId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new StrategyPortfolioTransactionInputError("transactionId is invalid");
  }
  const transactionId = value.normalize("NFKC").trim();
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new StrategyPortfolioTransactionInputError("transactionId is invalid");
  }
  return transactionId;
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
    transactionId: normalizeTransactionId(input.transactionId),
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
