import { StrategyPreferenceInputError } from "./strategy-preference-contracts";
import { StrategyPreferenceStoreError } from "./strategy-preferences.server";
import { requestOwnerErrorResponse } from "./request-owner.server";

export function strategyPreferenceRequestId(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
}

export async function readStrategyPreferenceJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new StrategyPreferenceInputError("request body must be valid JSON");
  }
}

export function strategyPreferenceErrorResponse(
  error: unknown,
  requestId: string,
): Response {
  const ownerError = requestOwnerErrorResponse(error, requestId);
  if (ownerError) return ownerError;
  if (error instanceof StrategyPreferenceInputError) {
    return Response.json(
      { error: { code: "invalid_request", message: error.message }, requestId },
      {
        status: 400,
        headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
      },
    );
  }
  if (error instanceof StrategyPreferenceStoreError) {
    return Response.json(
      { error: { code: error.code, message: error.message }, requestId },
      {
        status: error.status,
        headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
      },
    );
  }
  return Response.json(
    {
      error: {
        code: "persistence_unavailable",
        message: "The strategy preference could not be saved. Try again shortly.",
      },
      requestId,
    },
    {
      status: 500,
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    },
  );
}
