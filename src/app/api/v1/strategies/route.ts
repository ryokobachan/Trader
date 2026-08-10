import {
  STRATEGIES_SCHEMA_VERSION,
  normalizeCreateStrategyInput,
  type StrategiesResponse,
  type StrategyMutationResponse,
} from "../../../platform/strategy-contracts";
import {
  readStrategyJson,
  strategyErrorResponse,
  strategyLocale,
  strategyRequestId,
  strategyResponseHeaders,
} from "../../../platform/strategy-http.server";
import { createStrategy, listStrategies } from "../../../platform/strategies.server";
import { requestOwnerId } from "../../../platform/request-owner.server";

export async function GET(request: Request) {
  const requestId = strategyRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const response: StrategiesResponse = {
      schemaVersion: STRATEGIES_SCHEMA_VERSION,
      ownerId,
      strategies: await listStrategies(strategyLocale(request), ownerId),
    };
    return Response.json(response, { headers: strategyResponseHeaders(requestId) });
  } catch (error) {
    return strategyErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = strategyRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const payload = await readStrategyJson(request);
    const response: StrategyMutationResponse = {
      schemaVersion: STRATEGIES_SCHEMA_VERSION,
      strategy: await createStrategy(normalizeCreateStrategyInput(payload), ownerId),
    };
    return Response.json(response, {
      status: 201,
      headers: strategyResponseHeaders(requestId),
    });
  } catch (error) {
    return strategyErrorResponse(error, requestId);
  }
}
