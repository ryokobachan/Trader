import { ensureTransactionDatabase, getD1 } from "../../db";
import { DEFAULT_LOCAL_OWNER_ID } from "./watchlist-contracts";
import {
  type CreateStrategyPortfolioTransactionInput,
  type StrategyPortfolioTransaction,
  type UpdateStrategyPortfolioTransactionInput,
} from "./strategy-portfolio-contracts";
import { assertStrategyTransactionAccess, StrategyStoreError } from "./strategies.server";

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

async function assertStrategy(strategyId: string, ownerId: string): Promise<void> {
  try {
    await assertStrategyTransactionAccess(strategyId, ownerId);
  } catch (error) {
    if (error instanceof StrategyStoreError) {
      throw new StrategyPortfolioTransactionStoreError(error.status, error.code, error.message);
    }
    throw error;
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function nextTransactionTimestamp(previous: string): string {
  const candidate = timestamp();
  if (candidate !== previous) return candidate;
  return new Date(new Date(candidate).getTime() + 1).toISOString();
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

/** The preceding statement must be the guarded INSERT/UPDATE/DELETE. */
function auditAfterPreviousChangeStatement(
  db: D1Database,
  ownerId: string,
  action: string,
  strategyId: string,
  payload: Record<string, unknown>,
  createdAt: string,
) {
  return db
    .prepare(
      `INSERT INTO app_audit_events
        (id, owner_id, action, entity_type, entity_id, payload_json, created_at)
       SELECT ?, ?, ?, 'strategy_portfolio', ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      crypto.randomUUID(),
      ownerId,
      action,
      strategyId,
      JSON.stringify(payload),
      createdAt,
    );
}

async function prepareStore(): Promise<D1Database> {
  await ensureTransactionDatabase();
  return getD1();
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
  await assertStrategy(strategyId, ownerId);
  const db = await prepareStore();
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
  await assertStrategy(strategyId, ownerId);
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
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO strategy_portfolio_transactions
          (owner_id, strategy_id, transaction_id, date, symbol, side, shares, price, fee,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, strategy_id, transaction_id) DO NOTHING`,
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
    auditAfterPreviousChangeStatement(
      db,
      ownerId,
      "strategy_portfolio.transaction.created",
      strategyId,
      {
        transactionId,
        date: input.date,
        symbol: input.symbol,
        side: input.side,
        shares: input.shares,
        price: input.price,
        fee: input.fee,
      },
      now,
    ),
  ]);

  const inserted = await transactionById(db, ownerId, strategyId, transactionId);
  if (!inserted) {
    throw new StrategyPortfolioTransactionStoreError(
      500,
      "write_failed",
      "取引を保存できませんでした。",
    );
  }
  if (!transactionMatchesInput(inserted, input)) {
    throw new StrategyPortfolioTransactionStoreError(
      409,
      "transaction_id_conflict",
      "同じ取引IDに異なる内容が保存されています。",
    );
  }
  return {
    transaction: toTransaction(inserted),
    created: (results[0].meta.changes ?? 0) === 1,
  };
}

export async function getStrategyPortfolioTransaction(
  strategyId: string,
  transactionId: string,
  ownerId = currentStrategyPortfolioOwnerId(),
): Promise<StrategyPortfolioTransaction> {
  await assertStrategy(strategyId, ownerId);
  const row = await transactionById(await prepareStore(), ownerId, strategyId, transactionId);
  if (!row) {
    throw new StrategyPortfolioTransactionStoreError(
      404,
      "transaction_not_found",
      "The transaction was not found.",
    );
  }
  return toTransaction(row);
}

export async function updateStrategyPortfolioTransaction(
  strategyId: string,
  transactionId: string,
  input: UpdateStrategyPortfolioTransactionInput,
  ownerId = currentStrategyPortfolioOwnerId(),
): Promise<StrategyPortfolioTransaction> {
  await assertStrategy(strategyId, ownerId);
  const db = await prepareStore();
  const existing = await transactionById(db, ownerId, strategyId, transactionId);
  if (!existing) {
    throw new StrategyPortfolioTransactionStoreError(
      404,
      "transaction_not_found",
      "The transaction was not found.",
    );
  }

  const mutationTime = nextTransactionTimestamp(existing.updated_at);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE strategy_portfolio_transactions
         SET date = ?, symbol = ?, side = ?, shares = ?, price = ?, fee = ?, updated_at = ?
         WHERE owner_id = ? AND strategy_id = ? AND transaction_id = ? AND updated_at = ?`,
      )
      .bind(
        input.date, input.symbol, input.side, input.shares, input.price, input.fee,
        mutationTime, ownerId, strategyId, transactionId, input.expectedUpdatedAt,
      ),
    auditAfterPreviousChangeStatement(
      db,
      ownerId,
      "strategy_portfolio.transaction.updated",
      strategyId,
      {
        transactionId,
        date: input.date,
        symbol: input.symbol,
        side: input.side,
        shares: input.shares,
        price: input.price,
        fee: input.fee,
      },
      mutationTime,
    ),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1) {
    const current = await transactionById(db, ownerId, strategyId, transactionId);
    if (!current) {
      throw new StrategyPortfolioTransactionStoreError(
        404,
        "transaction_not_found",
        "The transaction was not found.",
      );
    }
    throw new StrategyPortfolioTransactionStoreError(
      409,
      "transaction_changed",
      "The transaction changed after it was read. Fetch it again before editing.",
    );
  }
  const updated = await transactionById(db, ownerId, strategyId, transactionId);
  if (!updated) {
    throw new StrategyPortfolioTransactionStoreError(
      500,
      "write_failed",
      "The transaction could not be updated.",
    );
  }
  return toTransaction(updated);
}

async function hasDeleteMarker(
  db: D1Database,
  ownerId: string,
  strategyId: string,
  transactionId: string,
): Promise<boolean> {
  const marker = await db
    .prepare(
      `SELECT id FROM app_audit_events
       WHERE owner_id = ?
         AND action = 'strategy_portfolio.transaction.deleted'
         AND entity_type = 'strategy_portfolio'
         AND entity_id = ?
         AND json_extract(payload_json, '$.transactionId') = ?
       LIMIT 1`,
    )
    .bind(ownerId, strategyId, transactionId)
    .first<{ id: string }>();
  return Boolean(marker);
}

export async function deleteStrategyPortfolioTransaction(
  strategyId: string,
  transactionId: string,
  ownerId = currentStrategyPortfolioOwnerId(),
): Promise<{ deleted: boolean }> {
  await assertStrategy(strategyId, ownerId);
  const db = await prepareStore();
  const existing = await transactionById(db, ownerId, strategyId, transactionId);
  if (!existing) {
    if (await hasDeleteMarker(db, ownerId, strategyId, transactionId)) {
      return { deleted: false };
    }
    throw new StrategyPortfolioTransactionStoreError(
      404,
      "transaction_not_found",
      "The transaction was not found.",
    );
  }
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM strategy_portfolio_transactions
         WHERE owner_id = ? AND strategy_id = ? AND transaction_id = ?`,
      )
      .bind(ownerId, strategyId, transactionId),
    auditAfterPreviousChangeStatement(
      db,
      ownerId,
      "strategy_portfolio.transaction.deleted",
      strategyId,
      {
        transactionId,
        date: existing.date,
        symbol: existing.symbol,
      },
      timestamp(),
    ),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1) {
    if (await hasDeleteMarker(db, ownerId, strategyId, transactionId)) {
      return { deleted: false };
    }
    throw new StrategyPortfolioTransactionStoreError(
      409,
      "transaction_changed",
      "The transaction changed before it could be deleted.",
    );
  }
  return { deleted: true };
}
