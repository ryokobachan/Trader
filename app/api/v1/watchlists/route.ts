import {
  WATCHLISTS_SCHEMA_VERSION,
  normalizeWatchlistName,
  type WatchlistMutationResponse,
  type WatchlistsResponse,
} from "../../../platform/watchlist-contracts";
import {
  readJsonObject,
  requestIdFor,
  watchlistErrorResponse,
} from "../../../platform/watchlist-http.server";
import {
  createWatchlist,
  listWatchlists,
} from "../../../platform/watchlists.server";
import { requestOwnerId } from "../../../platform/request-owner.server";

function responseHeaders(requestId: string) {
  return { "Cache-Control": "private, no-store", "X-Request-Id": requestId };
}

export async function GET(request: Request) {
  const requestId = requestIdFor(request);
  try {
    const ownerId = requestOwnerId(request);
    const response: WatchlistsResponse = {
      schemaVersion: WATCHLISTS_SCHEMA_VERSION,
      ownerId,
      watchlists: await listWatchlists(ownerId),
    };
    return Response.json(response, { headers: responseHeaders(requestId) });
  } catch (error) {
    return watchlistErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = requestIdFor(request);
  try {
    const ownerId = requestOwnerId(request);
    const payload = await readJsonObject(request);
    const response: WatchlistMutationResponse = {
      schemaVersion: WATCHLISTS_SCHEMA_VERSION,
      watchlist: await createWatchlist(normalizeWatchlistName(payload.name), ownerId),
    };
    return Response.json(response, { status: 201, headers: responseHeaders(requestId) });
  } catch (error) {
    return watchlistErrorResponse(error, requestId);
  }
}
