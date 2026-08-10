import type { Locale } from "./i18n";
import { requestOwnerErrorResponse } from "./request-owner.server";
import { StrategyInputError } from "./strategy-contracts";
import { StrategyPortfolioTransactionStoreError } from "./strategy-portfolio-transactions.server";
import { StrategyPreferenceStoreError } from "./strategy-preferences.server";
import { StrategyStoreError } from "./strategies.server";

export function strategyRequestId(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
}

export function strategyResponseHeaders(requestId: string) {
  return { "Cache-Control": "private, no-store", "X-Request-Id": requestId };
}

export async function readStrategyJson(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new StrategyInputError("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrategyInputError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

export function strategyLocale(request: Request): Locale {
  const locale = new URL(request.url).searchParams.get("locale") ?? "en";
  if (locale !== "en" && locale !== "ja") {
    throw new StrategyInputError("locale must be en or ja");
  }
  return locale;
}

export function strategyIncludes(request: Request): Set<"transactions" | "performance"> {
  const raw = new URL(request.url).searchParams.get("include");
  if (!raw) return new Set();
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => entry !== "transactions" && entry !== "performance")) {
    throw new StrategyInputError("include supports only transactions and performance");
  }
  return new Set(entries as Array<"transactions" | "performance">);
}

export function strategyErrorResponse(error: unknown, requestId: string): Response {
  const ownerError = requestOwnerErrorResponse(error, requestId);
  if (ownerError) return ownerError;
  if (error instanceof StrategyInputError) {
    return Response.json(
      { error: { code: "invalid_request", message: error.message }, requestId },
      { status: 400, headers: strategyResponseHeaders(requestId) },
    );
  }
  if (
    error instanceof StrategyStoreError
    || error instanceof StrategyPreferenceStoreError
    || error instanceof StrategyPortfolioTransactionStoreError
  ) {
    return Response.json(
      { error: { code: error.code, message: error.message }, requestId },
      { status: error.status, headers: strategyResponseHeaders(requestId) },
    );
  }
  return Response.json(
    {
      error: {
        code: "persistence_unavailable",
        message: "The strategy store is temporarily unavailable.",
      },
      requestId,
    },
    { status: 500, headers: strategyResponseHeaders(requestId) },
  );
}
