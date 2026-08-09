import {
  STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION,
  normalizeStrategyId,
  normalizeStrategyPortfolioTransactionInput,
  type StrategyPortfolioTransactionMutationResponse,
  type StrategyPortfolioTransactionsResponse,
} from "../../../../../platform/strategy-portfolio-contracts";
import {
  readStrategyTransactionJson,
  strategyTransactionErrorResponse,
  strategyTransactionRequestId,
} from "../../../../../platform/strategy-portfolio-http.server";
import {
  createStrategyPortfolioTransaction,
  listStrategyPortfolioTransactions,
} from "../../../../../platform/strategy-portfolio-transactions.server";
import { requestOwnerId } from "../../../../../platform/request-owner.server";

type RouteContext = { params: Promise<{ strategyId: string }> };

function responseHeaders(requestId: string) {
  return { "Cache-Control": "private, no-store", "X-Request-Id": requestId };
}

async function strategyIdFrom(context: RouteContext): Promise<string> {
  const { strategyId } = await context.params;
  return normalizeStrategyId(strategyId);
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = strategyTransactionRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const strategyId = await strategyIdFrom(context);
    const response: StrategyPortfolioTransactionsResponse = {
      schemaVersion: STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION,
      ownerId,
      strategyId,
      transactions: await listStrategyPortfolioTransactions(strategyId, ownerId),
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return strategyTransactionErrorResponse(error, requestId);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = strategyTransactionRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const [strategyId, payload] = await Promise.all([
      strategyIdFrom(context),
      readStrategyTransactionJson(request),
    ]);
    const result = await createStrategyPortfolioTransaction(
      strategyId,
      normalizeStrategyPortfolioTransactionInput(payload),
      ownerId,
    );
    const response: StrategyPortfolioTransactionMutationResponse = {
      schemaVersion: STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION,
      transaction: result.transaction,
    };
    return Response.json(response, {
      status: result.created ? 201 : 200,
      headers: responseHeaders(requestId),
    });
  } catch (error) {
    return strategyTransactionErrorResponse(error, requestId);
  }
}
