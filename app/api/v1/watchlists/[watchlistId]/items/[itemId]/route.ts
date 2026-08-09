import { WATCHLISTS_SCHEMA_VERSION } from "../../../../../../platform/watchlist-contracts";
import {
  requestIdFor,
  routeId,
  watchlistErrorResponse,
} from "../../../../../../platform/watchlist-http.server";
import { deleteWatchlistItem } from "../../../../../../platform/watchlists.server";
import { requestOwnerId } from "../../../../../../platform/request-owner.server";

type RouteContext = { params: Promise<{ watchlistId: string; itemId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = requestIdFor(request);
  try {
    const ownerId = requestOwnerId(request);
    const [watchlistId, itemId] = await Promise.all([
      routeId(context.params, "watchlistId"),
      routeId(context.params, "itemId"),
    ]);
    await deleteWatchlistItem(watchlistId, itemId, ownerId);
    return Response.json(
      { schemaVersion: WATCHLISTS_SCHEMA_VERSION, deletedId: itemId },
      {
        headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
      },
    );
  } catch (error) {
    return watchlistErrorResponse(error, requestId);
  }
}
