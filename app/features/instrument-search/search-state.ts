export type InstrumentSearchStatus = "idle" | "loading" | "ready" | "error";

export type InstrumentSearchView =
  | "loading"
  | "results"
  | "empty"
  | "error";

/**
 * Resolve one mutually exclusive search result view.
 *
 * Keeping this separate prevents a previous query's rows from appearing under
 * a loading or error message while a newer request is in flight.
 */
export function resolveInstrumentSearchView(
  status: InstrumentSearchStatus,
  resultCount: number,
): InstrumentSearchView {
  if (status === "idle" || status === "loading") return "loading";
  if (status === "error") return "error";
  return resultCount > 0 ? "results" : "empty";
}
