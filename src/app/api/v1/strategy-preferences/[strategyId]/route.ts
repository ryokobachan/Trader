import {
  STRATEGY_PREFERENCES_SCHEMA_VERSION,
  normalizeStrategyPreferenceId,
  normalizeStrategyPreferenceInput,
  type StrategyPreferenceDeleteResponse,
  type StrategyPreferenceMutationResponse,
} from "../../../../platform/strategy-preference-contracts";
import {
  readStrategyPreferenceJson,
  strategyPreferenceErrorResponse,
  strategyPreferenceRequestId,
} from "../../../../platform/strategy-preference-http.server";
import {
  deleteStrategyPreference,
  updateStrategyPreference,
} from "../../../../platform/strategy-preferences.server";
import { requestOwnerId } from "../../../../platform/request-owner.server";

type RouteContext = { params: Promise<{ strategyId: string }> };

function responseHeaders(requestId: string) {
  return { "Cache-Control": "private, no-store", "X-Request-Id": requestId };
}

async function strategyIdFrom(context: RouteContext): Promise<string> {
  const { strategyId } = await context.params;
  return normalizeStrategyPreferenceId(strategyId);
}

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = strategyPreferenceRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const [strategyId, payload] = await Promise.all([
      strategyIdFrom(context),
      readStrategyPreferenceJson(request),
    ]);
    const response: StrategyPreferenceMutationResponse = {
      schemaVersion: STRATEGY_PREFERENCES_SCHEMA_VERSION,
      preference: await updateStrategyPreference(
        strategyId,
        normalizeStrategyPreferenceInput(payload),
        ownerId,
      ),
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return strategyPreferenceErrorResponse(error, requestId);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = strategyPreferenceRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const strategyId = await strategyIdFrom(context);
    const preference = await deleteStrategyPreference(strategyId, ownerId);
    const response: StrategyPreferenceDeleteResponse = {
      schemaVersion: STRATEGY_PREFERENCES_SCHEMA_VERSION,
      deletedId: strategyId,
      preference,
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return strategyPreferenceErrorResponse(error, requestId);
  }
}
