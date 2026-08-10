import {
  STRATEGIES_SCHEMA_VERSION,
  performanceFromTransactionLedger,
  normalizeExpectedStrategyVersion,
  normalizeStrategyRecordId,
  normalizeUpdateStrategyInput,
  type StrategyDeleteResponse,
  type StrategyDetailResponse,
  type StrategyMutationResponse,
} from "../../../../platform/strategy-contracts";
import {
  readStrategyJson,
  strategyErrorResponse,
  strategyIncludes,
  strategyLocale,
  strategyRequestId,
  strategyResponseHeaders,
} from "../../../../platform/strategy-http.server";
import { listStrategyPortfolioTransactions } from "../../../../platform/strategy-portfolio-transactions.server";
import {
  deleteStrategy,
  getStrategy,
  updateStrategy,
} from "../../../../platform/strategies.server";
import { requestOwnerId } from "../../../../platform/request-owner.server";

type RouteContext = { params: Promise<{ strategyId: string }> };

async function strategyIdFrom(context: RouteContext): Promise<string> {
  return normalizeStrategyRecordId((await context.params).strategyId);
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = strategyRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const [strategyId, locale] = await Promise.all([
      strategyIdFrom(context),
      Promise.resolve(strategyLocale(request)),
    ]);
    const includes = strategyIncludes(request);
    const strategy = await getStrategy(strategyId, locale, ownerId);
    const transactions = includes.has("transactions")
      || (includes.has("performance") && strategy.performance.provenance === "unavailable")
      ? await listStrategyPortfolioTransactions(strategyId, ownerId)
      : undefined;
    const response: StrategyDetailResponse = {
      schemaVersion: STRATEGIES_SCHEMA_VERSION,
      ownerId,
      strategy,
      ...(includes.has("transactions")
        ? { transactions: transactions ?? [] }
        : {}),
      ...(includes.has("performance")
        ? {
            performance: performanceFromTransactionLedger(
              strategy.performance,
              transactions ?? [],
            ),
          }
        : {}),
    };
    return Response.json(response, { headers: strategyResponseHeaders(requestId) });
  } catch (error) {
    return strategyErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = strategyRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const [strategyId, payload] = await Promise.all([
      strategyIdFrom(context),
      readStrategyJson(request),
    ]);
    const response: StrategyMutationResponse = {
      schemaVersion: STRATEGIES_SCHEMA_VERSION,
      strategy: await updateStrategy(
        strategyId,
        normalizeUpdateStrategyInput(payload),
        strategyLocale(request),
        ownerId,
      ),
    };
    return Response.json(response, { headers: strategyResponseHeaders(requestId) });
  } catch (error) {
    return strategyErrorResponse(error, requestId);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = strategyRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const strategyId = await strategyIdFrom(context);
    const rawVersion = new URL(request.url).searchParams.get("expectedVersion");
    const result = await deleteStrategy(
      strategyId,
      rawVersion === null ? undefined : normalizeExpectedStrategyVersion(rawVersion),
      ownerId,
    );
    const response: StrategyDeleteResponse = {
      schemaVersion: STRATEGIES_SCHEMA_VERSION,
      deletedId: strategyId,
      ...result,
    };
    return Response.json(response, { headers: strategyResponseHeaders(requestId) });
  } catch (error) {
    return strategyErrorResponse(error, requestId);
  }
}
