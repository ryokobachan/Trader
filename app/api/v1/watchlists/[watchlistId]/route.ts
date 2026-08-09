import {
  WATCHLISTS_SCHEMA_VERSION,
  normalizeWatchlistName,
  type WatchlistDeletionResponse,
  type WatchlistMutationResponse,
} from "../../../../platform/watchlist-contracts";
import {
  readJsonObject,
  requestIdFor,
  routeId,
  watchlistErrorResponse,
} from "../../../../platform/watchlist-http.server";
import { deleteWatchlist, renameWatchlist } from "../../../../platform/watchlists.server";
import { requestOwnerId } from "../../../../platform/request-owner.server";

type RouteContext = { params: Promise<{ watchlistId: string }> };

function responseHeaders(requestId: string) {
  return { "Cache-Control": "private, no-store", "X-Request-Id": requestId };
}

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = requestIdFor(request);
  try {
    const ownerId = requestOwnerId(request);
    const [watchlistId, payload] = await Promise.all([
      routeId(context.params, "watchlistId"),
      readJsonObject(request),
    ]);
    const response: WatchlistMutationResponse = {
      schemaVersion: WATCHLISTS_SCHEMA_VERSION,
      watchlist: await renameWatchlist(watchlistId, normalizeWatchlistName(payload.name), ownerId),
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return watchlistErrorResponse(error, requestId);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = requestIdFor(request);
  try {
    const ownerId = requestOwnerId(request);
    const watchlistId = await routeId(context.params, "watchlistId");
    const deletion = await deleteWatchlist(watchlistId, ownerId);
    const response: WatchlistDeletionResponse = {
      schemaVersion: WATCHLISTS_SCHEMA_VERSION,
      ...deletion,
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return watchlistErrorResponse(error, requestId);
  }
}
