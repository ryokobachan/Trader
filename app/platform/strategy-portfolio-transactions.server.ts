import { ensureTransactionDatabase, getD1 } from "../../db";
import { SAMPLE_STRATEGY_DEFINITIONS } from "../features/strategy/sample-strategies";
import { DEFAULT_LOCAL_OWNER_ID } from "./watchlist-contracts";
import {
  INITIAL_STRATEGY_PORTFOLIO_TRANSACTIONS,
  type CreateStrategyPortfolioTransactionInput,
  type StrategyPortfolioTransaction,
} from "./strategy-portfolio-contracts";

const SEED_AUDIT_ACTION = "strategy_portfolio.transactions.seeded.v1";
const BUILT_IN_STRATEGY_IDS = new Set<string>(
  SAMPLE_STRATEGY_DEFINITIONS.map((strategy) => strategy.id),
);

type TransactionRow = {
  owner_id: string;
  strategy_id: string;
  transaction_id: string;
  date: string;
  symbol: string;
  side: "buy" | "sell" | "dividend";
  shares: number;
  price: number;
  fee: number;
  created_at: string;
  updated_at: string;
};

export class StrategyPortfolioTransactionStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StrategyPortfolioTransactionStoreError";
  }
}

export function currentStrategyPortfolioOwnerId(): string {
  return DEFAULT_LOCAL_OWNER_ID;
}

function assertBuiltInStrategy(strategyId: string): void {
  if (!BUILT_IN_STRATEGY_IDS.has(strategyId)) {
    throw new StrategyPortfolioTransactionStoreError(
      404,
      "strategy_not_found",
      "The built-in strategy was not found.",
    );
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function toTransaction(row: TransactionRow): StrategyPortfolioTransaction {
  return {
    strategyId: row.strategy_id,
    transactionId: row.transaction_id,
    date: row.date,
    symbol: row.symbol,
    side: row.side,
    shares: row.shares,
    price: row.price,
    fee: row.fee,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditStatement(
  db: D1Database,
  ownerId: string,
  action: string,
  strategyId: string,
  payload: Record<string, unknown>,
) {
  return db
    .prepare(
      `INSERT INTO app_audit_events
        (id, owner_id, action, entity_type, entity_id, payload_json, created_at)
       VALUES (?, ?, ?, 'strategy_portfolio', ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      ownerId,
      action,
      strategyId,
      JSON.stringify(payload),
      timestamp(),
    );
}

async function prepareStore(): Promise<D1Database> {
  await ensureTransactionDatabase();
  return getD1();
}

async function hasSeedMarker(
  db: D1Database,
  ownerId: string,
  strategyId: string,
): Promise<boolean> {
  const marker = await db
    .prepare(
      `SELECT id FROM app_audit_events
       WHERE owner_id = ?
         AND entity_type = 'strategy_portfolio'
         AND entity_id = ?
         AND action = ?
       LIMIT 1`,
    )
    .bind(ownerId, strategyId, SEED_AUDIT_ACTION)
    .first<{ id: string }>();
  return Boolean(marker);
}

async function seedInitialTransactionsOnce(
  db: D1Database,
  ownerId: string,
  strategyId: string,
): Promise<void> {
  if (await hasSeedMarker(db, ownerId, strategyId)) return;

  const now = timestamp();
  const statements = INITIAL_STRATEGY_PORTFOLIO_TRANSACTIONS.map((transaction, index) =>
    db
      .prepare(
        `INSERT INTO strategy_portfolio_transactions
          (owner_id, strategy_id, transaction_id, date, symbol, side, shares, price, fee,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ownerId,
        strategyId,
        `initial-v1-${String(index + 1).padStart(3, "0")}`,
        transaction.date,
        transaction.symbol,
        transaction.side,
        transaction.shares,
        transaction.price,
        transaction.fee,
        now,
        now,
      ),
  );

  try {
    await db.batch([
      ...statements,
      auditStatement(db, ownerId, SEED_AUDIT_ACTION, strategyId, {
        transactionCount: INITIAL_STRATEGY_PORTFOLIO_TRANSACTIONS.length,
      }),
    ]);
  } catch (error) {
    // A concurrent first GET can win the deterministic seed IDs. Its marker
    // makes this request successful without duplicating the fixture rows.
    if (await hasSeedMarker(db, ownerId, strategyId)) return;
    throw error;
  }
}

async function transactionById(
  db: D1Database,
  ownerId: string,
  strategyId: string,
  transactionId: string,
): Promise<TransactionRow | null> {
  return db
    .prepare(
      `SELECT * FROM strategy_portfolio_transactions
       WHERE owner_id = ? AND strategy_id = ? AND transaction_id = ? LIMIT 1`,
    )
    .bind(ownerId, strategyId, transactionId)
    .first<TransactionRow>();
}

export async function listStrategyPortfolioTransactions(
  strategyId: string,
  ownerId = currentStrategyPortfolioOwnerId(),
): Promise<StrategyPortfolioTransaction[]> {
  assertBuiltInStrategy(strategyId);
  const db = await prepareStore();
  await seedInitialTransactionsOnce(db, ownerId, strategyId);
  const result = await db
    .prepare(
      `SELECT * FROM strategy_portfolio_transactions
       WHERE owner_id = ? AND strategy_id = ?
       ORDER BY date DESC, created_at DESC, transaction_id DESC`,
    )
    .bind(ownerId, strategyId)
    .all<TransactionRow>();
  return result.results.map(toTransaction);
}

function transactionMatchesInput(
  transaction: TransactionRow,
  input: CreateStrategyPortfolioTransactionInput,
): boolean {
  return transaction.date === input.date
    && transaction.symbol === input.symbol
    && transaction.side === input.side
    && transaction.shares === input.shares
    && transaction.price === input.price
    && transaction.fee === input.fee;
}

export async function createStrategyPortfolioTransaction(
  strategyId: string,
  input: CreateStrategyPortfolioTransactionInput,
  ownerId = currentStrategyPortfolioOwnerId(),
): Promise<{ transaction: StrategyPortfolioTransaction; created: boolean }> {
  assertBuiltInStrategy(strategyId);
  const db = await prepareStore();
  const transactionId = input.transactionId ?? crypto.randomUUID();
  const existing = await transactionById(db, ownerId, strategyId, transactionId);
  if (existing) {
    if (!transactionMatchesInput(existing, input)) {
      throw new StrategyPortfolioTransactionStoreError(
        409,
        "transaction_id_conflict",
        "同じ取引IDに異なる内容が保存されています。",
      );
    }
    return { transaction: toTransaction(existing), created: false };
  }

  const now = timestamp();
  await db.batch([
    db
      .prepare(
        `INSERT INTO strategy_portfolio_transactions
          (owner_id, strategy_id, transaction_id, date, symbol, side, shares, price, fee,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ownerId,
        strategyId,
        transactionId,
        input.date,
        input.symbol,
        input.side,
        input.shares,
        input.price,
        input.fee,
        now,
        now,
      ),
    auditStatement(db, ownerId, "strategy_portfolio.transaction.created", strategyId, {
      transactionId,
      date: input.date,
      symbol: input.symbol,
      side: input.side,
      shares: input.shares,
      price: input.price,
      fee: input.fee,
    }),
  ]);

  const inserted = await transactionById(db, ownerId, strategyId, transactionId);
  if (!inserted) {
    throw new StrategyPortfolioTransactionStoreError(
      500,
      "write_failed",
      "取引を保存できませんでした。",
    );
  }
  return { transaction: toTransaction(inserted), created: true };
}
