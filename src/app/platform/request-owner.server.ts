import { DEFAULT_LOCAL_OWNER_ID } from "./watchlist-contracts";

const AUTHENTICATED_USER_ID_HEADER = "oai-authenticated-user-id";
const MAX_OWNER_ID_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export class RequestOwnerError extends Error {
  readonly status = 401;
  readonly code = "authentication_required";

  constructor() {
    super("Authentication is required for persisted workspace data.");
    this.name = "RequestOwnerError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

/**
 * Resolve the owner for one API request.
 *
 * OpenAI Sites supplies a stable, Site-scoped user ID. The fixed local owner
 * remains available only on an actual loopback URL so an accidentally public
 * deployment fails closed instead of sharing one workspace between visitors.
 */
export function requestOwnerId(request: Request): string {
  const authenticatedUserId = request.headers.get(AUTHENTICATED_USER_ID_HEADER);
  if (authenticatedUserId !== null) {
    const ownerId = authenticatedUserId.trim();
    if (
      !ownerId
      || ownerId.length > MAX_OWNER_ID_LENGTH
      || CONTROL_CHARACTERS.test(ownerId)
    ) {
      throw new RequestOwnerError();
    }
    return ownerId;
  }

  try {
    if (isLoopbackHostname(new URL(request.url).hostname)) {
      return DEFAULT_LOCAL_OWNER_ID;
    }
  } catch {
    // Invalid request URLs are never allowed to fall back to shared local data.
  }

  throw new RequestOwnerError();
}

export function requestOwnerErrorResponse(
  error: unknown,
  requestId: string,
): Response | null {
  if (!(error instanceof RequestOwnerError)) return null;
  return Response.json(
    {
      error: { code: error.code, message: error.message },
      requestId,
    },
    {
      status: error.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    },
  );
}
