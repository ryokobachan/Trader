import { StrategyPortfolioTransactionInputError } from "./strategy-portfolio-contracts";
import { StrategyPortfolioTransactionStoreError } from "./strategy-portfolio-transactions.server";
import { requestOwnerErrorResponse } from "./request-owner.server";

export function strategyTransactionRequestId(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
}

export async function readStrategyTransactionJson(
  request: Request,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new StrategyPortfolioTransactionInputError("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrategyPortfolioTransactionInputError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

export function strategyTransactionErrorResponse(error: unknown, requestId: string): Response {
  const ownerError = requestOwnerErrorResponse(error, requestId);
  if (ownerError) return ownerError;
  if (error instanceof StrategyPortfolioTransactionInputError) {
    return Response.json(
      { error: { code: "invalid_request", message: error.message }, requestId },
      { status: 400, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  }
  if (error instanceof StrategyPortfolioTransactionStoreError) {
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
        message: "取引履歴を保存できませんでした。しばらくしてから再度お試しください。",
      },
      requestId,
    },
    { status: 500, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
  );
}
