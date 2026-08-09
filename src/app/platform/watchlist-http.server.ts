import {
  WatchlistInputError,
  normalizeWatchlistEntityId,
} from "./watchlist-contracts";
import { WatchlistStoreError } from "./watchlists.server";
import { requestOwnerErrorResponse } from "./request-owner.server";

export function requestIdFor(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new WatchlistInputError("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WatchlistInputError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

export async function routeId(
  params: Promise<Record<string, string>>,
  key: string,
): Promise<string> {
  const resolved = await params;
  return normalizeWatchlistEntityId(resolved[key], key);
}

export function watchlistErrorResponse(error: unknown, requestId: string): Response {
  const ownerError = requestOwnerErrorResponse(error, requestId);
  if (ownerError) return ownerError;
  if (error instanceof WatchlistInputError) {
    return Response.json(
      { error: { code: "invalid_request", message: error.message }, requestId },
      { status: 400, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  }
  if (error instanceof WatchlistStoreError) {
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
        message: "ウォッチリストを保存できませんでした。しばらくしてから再度お試しください。",
      },
      requestId,
    },
    { status: 500, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
  );
}
