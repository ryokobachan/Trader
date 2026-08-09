import {
  WATCHLISTS_SCHEMA_VERSION,
  normalizeReorderItemIds,
  type WatchlistMutationResponse,
} from "../../../../../../platform/watchlist-contracts";
import {
  readJsonObject,
  requestIdFor,
  routeId,
  watchlistErrorResponse,
} from "../../../../../../platform/watchlist-http.server";
import { reorderWatchlistItems } from "../../../../../../platform/watchlists.server";
import { requestOwnerId } from "../../../../../../platform/request-owner.server";

type RouteContext = { params: Promise<{ watchlistId: string }> };

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
      watchlist: await reorderWatchlistItems(
        watchlistId,
        normalizeReorderItemIds(payload.itemIds),
        ownerId,
      ),
    };
    return Response.json(response, {
      headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
    });
  } catch (error) {
    return watchlistErrorResponse(error, requestId);
  }
}
