import { WATCHLIST_AFTER_HOURS_MAX_SYMBOLS } from "./provider-contracts";

const WATCHLIST_AFTER_HOURS_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

export function watchlistAfterHoursErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
) {
  return Response.json(
    { error: { code, message }, requestId },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    },
  );
}

export function requestedWatchlistAfterHoursSymbols(
  request: Request,
): readonly string[] | null {
  const values = new URL(request.url).searchParams.getAll("symbols");
  if (values.length !== 1 || !values[0]) return null;
  const symbols = values[0].split(",").map(
    (value) => value.normalize("NFKC").trim().toUpperCase(),
  );
  if (
    symbols.length < 1
    || symbols.length > WATCHLIST_AFTER_HOURS_MAX_SYMBOLS
    || symbols.some((symbol) => !WATCHLIST_AFTER_HOURS_SYMBOL_PATTERN.test(symbol))
    || new Set(symbols).size !== symbols.length
  ) return null;
  return Object.freeze(symbols);
}

export function isSameOriginWatchlistStreamRequest(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return (!origin || origin === requestOrigin)
    && (!fetchSite || fetchSite === "same-origin");
}
