import {
  WATCHLISTS_SCHEMA_VERSION,
  normalizeWatchlistItemInput,
  type WatchlistItemMutationResponse,
} from "../../../../../platform/watchlist-contracts";
import {
  readJsonObject,
  requestIdFor,
  routeId,
  watchlistErrorResponse,
} from "../../../../../platform/watchlist-http.server";
import { addWatchlistItem, getWatchlist } from "../../../../../platform/watchlists.server";
import { requestOwnerId } from "../../../../../platform/request-owner.server";

type RouteContext = { params: Promise<{ watchlistId: string }> };

function responseHeaders(requestId: string) {
  return { "Cache-Control": "private, no-store", "X-Request-Id": requestId };
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = requestIdFor(request);
  try {
    const ownerId = requestOwnerId(request);
    const watchlistId = await routeId(context.params, "watchlistId");
    const watchlist = await getWatchlist(watchlistId, ownerId);
    return Response.json(
      { schemaVersion: WATCHLISTS_SCHEMA_VERSION, watchlistId, items: watchlist.items },
      { headers: responseHeaders(requestId) },
    );
  } catch (error) {
    return watchlistErrorResponse(error, requestId);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = requestIdFor(request);
  try {
    const ownerId = requestOwnerId(request);
    const [watchlistId, payload] = await Promise.all([
      routeId(context.params, "watchlistId"),
      readJsonObject(request),
    ]);
    const response: WatchlistItemMutationResponse = {
      schemaVersion: WATCHLISTS_SCHEMA_VERSION,
      item: await addWatchlistItem(
        watchlistId,
        normalizeWatchlistItemInput(payload),
        ownerId,
      ),
    };
    return Response.json(response, { status: 201, headers: responseHeaders(requestId) });
  } catch (error) {
    return watchlistErrorResponse(error, requestId);
  }
}
