import {
  STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION,
  normalizeStrategyId,
  normalizeStrategyPortfolioTransactionId,
  normalizeStrategyPortfolioTransactionUpdateInput,
  type StrategyPortfolioTransactionDeleteResponse,
  type StrategyPortfolioTransactionMutationResponse,
} from "../../../../../../platform/strategy-portfolio-contracts";
import {
  readStrategyTransactionJson,
  strategyTransactionErrorResponse,
  strategyTransactionRequestId,
} from "../../../../../../platform/strategy-portfolio-http.server";
import {
  deleteStrategyPortfolioTransaction,
  getStrategyPortfolioTransaction,
  updateStrategyPortfolioTransaction,
} from "../../../../../../platform/strategy-portfolio-transactions.server";
import { requestOwnerId } from "../../../../../../platform/request-owner.server";

type RouteContext = {
  params: Promise<{ strategyId: string; transactionId: string }>;
};

function responseHeaders(requestId: string) {
  return { "Cache-Control": "private, no-store", "X-Request-Id": requestId };
}

async function routeIds(context: RouteContext): Promise<[string, string]> {
  const params = await context.params;
  return [
    normalizeStrategyId(params.strategyId),
    normalizeStrategyPortfolioTransactionId(params.transactionId),
  ];
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = strategyTransactionRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const [strategyId, transactionId] = await routeIds(context);
    const response: StrategyPortfolioTransactionMutationResponse = {
      schemaVersion: STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION,
      transaction: await getStrategyPortfolioTransaction(
        strategyId,
        transactionId,
        ownerId,
      ),
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return strategyTransactionErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = strategyTransactionRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const [[strategyId, transactionId], payload] = await Promise.all([
      routeIds(context),
      readStrategyTransactionJson(request),
    ]);
    const response: StrategyPortfolioTransactionMutationResponse = {
      schemaVersion: STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION,
      transaction: await updateStrategyPortfolioTransaction(
        strategyId,
        transactionId,
        normalizeStrategyPortfolioTransactionUpdateInput(payload),
        ownerId,
      ),
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return strategyTransactionErrorResponse(error, requestId);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = strategyTransactionRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const [strategyId, transactionId] = await routeIds(context);
    const result = await deleteStrategyPortfolioTransaction(
      strategyId,
      transactionId,
      ownerId,
    );
    const response: StrategyPortfolioTransactionDeleteResponse = {
      schemaVersion: STRATEGY_PORTFOLIO_TRANSACTIONS_SCHEMA_VERSION,
      strategyId,
      deletedId: transactionId,
      deleted: result.deleted,
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return strategyTransactionErrorResponse(error, requestId);
  }
}
