import {
  STRATEGY_PREFERENCES_SCHEMA_VERSION,
  type StrategyPreferencesResponse,
} from "../../../platform/strategy-preference-contracts";
import {
  strategyPreferenceErrorResponse,
  strategyPreferenceRequestId,
} from "../../../platform/strategy-preference-http.server";
import {
  listStrategyPreferences,
} from "../../../platform/strategy-preferences.server";
import { requestOwnerId } from "../../../platform/request-owner.server";

function responseHeaders(requestId: string) {
  return { "Cache-Control": "private, no-store", "X-Request-Id": requestId };
}

export async function GET(request: Request) {
  const requestId = strategyPreferenceRequestId(request);
  try {
    const ownerId = requestOwnerId(request);
    const response: StrategyPreferencesResponse = {
      schemaVersion: STRATEGY_PREFERENCES_SCHEMA_VERSION,
      ownerId,
      preferences: await listStrategyPreferences(ownerId),
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return strategyPreferenceErrorResponse(error, requestId);
  }
}
