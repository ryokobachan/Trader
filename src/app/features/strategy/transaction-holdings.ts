import type { PortfolioHoldingLot } from "./sample-portfolio";

export type { PortfolioHoldingLot } from "./sample-portfolio";

export type StrategyHoldingTransaction = Readonly<{
  transactionId: string;
  date: string;
  createdAt?: string;
  symbol: string;
  side: "buy" | "sell" | "dividend";
  shares: number;
  price: number;
  fee: number;
}>;

export type DerivePortfolioHoldingLotsOptions = Readonly<{
  includeClosed?: boolean;
}>;

type HoldingState = {
  shares: number;
  average: number;
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

type SortableTransaction = Readonly<{
  transaction: StrategyHoldingTransaction;
  originalIndex: number;
  createdAtTimestamp: number | null;
}>;

function validCreatedAtTimestamp(createdAt: string | undefined): number | null {
  if (typeof createdAt !== "string" || createdAt.trim() === "") return null;
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function orderTransactions(
  transactions: readonly StrategyHoldingTransaction[],
): StrategyHoldingTransaction[] {
  const sortable = transactions.map((transaction, originalIndex): SortableTransaction => ({
    transaction,
    originalIndex,
    createdAtTimestamp: validCreatedAtTimestamp(transaction.createdAt),
  }));
  const dateHasCompleteCreatedAt = new Map<string, boolean>();
  for (const item of sortable) {
    dateHasCompleteCreatedAt.set(
      item.transaction.date,
      (dateHasCompleteCreatedAt.get(item.transaction.date) ?? true)
        && item.createdAtTimestamp !== null,
    );
  }

  sortable.sort((left, right) => {
    const dateOrder = compareText(left.transaction.date, right.transaction.date);
    if (dateOrder !== 0) return dateOrder;

    if (dateHasCompleteCreatedAt.get(left.transaction.date)) {
      const createdAtOrder = left.createdAtTimestamp! - right.createdAtTimestamp!;
      if (createdAtOrder !== 0) return createdAtOrder;
    }

    return compareText(left.transaction.transactionId, right.transaction.transactionId)
      || left.originalIndex - right.originalIndex;
  });
  return sortable.map(({ transaction }) => transaction);
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Floating-point subtraction can leave a tiny residual after an otherwise
 * complete sale (for example, 0.3 - 0.1 - 0.2). Keep the tolerance relative
 * to the operands so genuine fractional positions are not rounded globally.
 */
function isEffectivelyClosed(
  remainingShares: number,
  previousShares: number,
  soldShares: number,
): boolean {
  if (remainingShares <= 0) return true;
  const scale = Math.max(1, Math.abs(previousShares), Math.abs(soldShares));
  return remainingShares <= Number.EPSILON * scale * 8;
}

function emptyHolding(lastAverage = 0): HoldingState {
  return { shares: 0, average: lastAverage };
}

/**
 * Rebuild current long-only holding lots from a transaction ledger.
 *
 * Transactions are applied oldest-first. Valid creation timestamps order
 * entries on the same date, with the transaction ID acting as a deterministic
 * tie-breaker. A date whose entries do not all have valid creation timestamps
 * falls back to transaction-ID order, as package transaction ledgers do. Buy
 * fees are part of acquisition cost. Sales reduce quantity without changing
 * the cost per remaining share, and dividends do not affect the lot.
 */
export function derivePortfolioHoldingLots(
  transactions: readonly StrategyHoldingTransaction[],
  options: DerivePortfolioHoldingLotsOptions = {},
): readonly PortfolioHoldingLot[] {
  const holdings = new Map<string, HoldingState>();
  const orderedTransactions = orderTransactions(transactions);

  for (const transaction of orderedTransactions) {
    if (transaction.side === "dividend") continue;
    if (!transaction.symbol || !isPositiveFinite(transaction.shares)) continue;

    const current = holdings.get(transaction.symbol) ?? emptyHolding();

    if (transaction.side === "sell") {
      const remainingShares = current.shares - transaction.shares;
      holdings.set(
        transaction.symbol,
        isEffectivelyClosed(remainingShares, current.shares, transaction.shares)
          ? emptyHolding(current.average)
          : { shares: remainingShares, average: current.average },
      );
      continue;
    }

    if (
      !isNonNegativeFinite(transaction.price)
      || !isNonNegativeFinite(transaction.fee)
    ) {
      continue;
    }

    const nextShares = current.shares + transaction.shares;
    const nextCost = current.shares * current.average
      + transaction.shares * transaction.price
      + transaction.fee;
    if (!Number.isFinite(nextShares) || !Number.isFinite(nextCost)) continue;

    holdings.set(transaction.symbol, {
      shares: nextShares,
      average: nextCost / nextShares,
    });
  }

  return [...holdings.entries()]
    .filter(([, holding]) => options.includeClosed || holding.shares > 0)
    .sort(([leftTicker], [rightTicker]) => compareText(leftTicker, rightTicker))
    .map(([ticker, holding]) => ({
      ticker,
      shares: holding.shares,
      average: holding.average,
      beta: null,
      rsi: null,
      performance1M: null,
      technicalRating: null,
    }));
}
