import type { SymbolWorkspace } from "../../platform/provider-contracts";

export type LatestRequestResult<T> = Readonly<
  | { status: "success"; current: boolean; value: T }
  | { status: "aborted"; current: false }
  | { status: "error"; current: boolean; error: unknown }
>;

export type LatestRequestCoordinator = Readonly<{
  run<T>(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
  ): Promise<LatestRequestResult<T>>;
  abort(): void;
}>;

export type WorkspaceRefreshSection = "financials" | "analyst" | "news";

/**
 * Keeps one workspace request active, shares duplicate requests, and prevents
 * a superseded response from committing after a newer symbol/section request.
 */
export function createLatestRequestCoordinator(): LatestRequestCoordinator {
  let sequence = 0;
  let active: Readonly<{
    key: string;
    sequence: number;
    controller: AbortController;
    promise: Promise<LatestRequestResult<unknown>>;
  }> | null = null;

  return Object.freeze({
    run<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
      if (active?.key === key) {
        return active.promise as Promise<LatestRequestResult<T>>;
      }
      active?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++sequence;
      const promise: Promise<LatestRequestResult<T>> = Promise.resolve()
        .then(() => load(controller.signal))
        .then((value) => Object.freeze({
          status: "success" as const,
          current: !controller.signal.aborted && requestSequence === sequence,
          value,
        }))
        .catch((error: unknown) => controller.signal.aborted
          ? Object.freeze({ status: "aborted" as const, current: false as const })
          : Object.freeze({
              status: "error" as const,
              current: requestSequence === sequence,
              error,
            }))
        .finally(() => {
          if (active?.sequence === requestSequence) active = null;
        });
      active = Object.freeze({
        key,
        sequence: requestSequence,
        controller,
        promise: promise as Promise<LatestRequestResult<unknown>>,
      });
      return promise;
    },
    abort() {
      sequence += 1;
      active?.controller.abort();
      active = null;
    },
  });
}

const SECTION_WARNING_PREFIXES: Readonly<Record<WorkspaceRefreshSection, readonly string[]>> = Object.freeze({
  financials: Object.freeze(["profile:", "fundamentals:", "earnings:"]),
  analyst: Object.freeze(["analyst:"]),
  news: Object.freeze(["news:"]),
});

type RefreshableWorkspaceRole = "profile" | "fundamentals" | "earnings" | "analyst" | "news";

function hasTransientUpstreamFailure(
  refreshed: SymbolWorkspace,
  role: RefreshableWorkspaceRole,
): boolean {
  return refreshed.warnings.includes(`${role}: upstream_unavailable`);
}

/**
 * Merge only the requested section, retaining unrelated workspace fields.
 * Temporary upstream failures keep the last good value and its provider;
 * provider_not_configured deliberately accepts the empty response so a runtime
 * configuration change removes data from the disabled role.
 */
export function mergeFreshWorkspaceSection(
  current: SymbolWorkspace,
  refreshed: SymbolWorkspace,
  section: WorkspaceRefreshSection,
): SymbolWorkspace {
  if (current.instrument.symbol !== refreshed.instrument.symbol) return refreshed;
  const warningPrefixes = SECTION_WARNING_PREFIXES[section];
  const warnings = Array.from(new Set([
    ...current.warnings.filter(
      (warning) => !warningPrefixes.some((prefix) => warning.startsWith(prefix)),
    ),
    ...refreshed.warnings.filter(
      (warning) => warningPrefixes.some((prefix) => warning.startsWith(prefix)),
    ),
  ]));
  const common = {
    instrument: refreshed.instrument,
    quote: refreshed.quote,
    dataMode: refreshed.dataMode,
    asOf: refreshed.asOf,
    warnings: Object.freeze(warnings),
    status: warnings.length === 0 ? "complete" as const : "partial" as const,
  };
  if (section === "financials") {
    const retainProfile = hasTransientUpstreamFailure(refreshed, "profile");
    const retainFundamentals = hasTransientUpstreamFailure(refreshed, "fundamentals");
    const retainEarnings = hasTransientUpstreamFailure(refreshed, "earnings");
    return Object.freeze({
      ...current,
      ...common,
      profile: retainProfile ? current.profile : refreshed.profile,
      fundamentals: retainFundamentals ? current.fundamentals : refreshed.fundamentals,
      earnings: retainEarnings ? current.earnings : refreshed.earnings,
      selectedProviders: Object.freeze({
        ...current.selectedProviders,
        instrument: refreshed.selectedProviders.instrument,
        market: refreshed.selectedProviders.market,
        profile: retainProfile
          ? current.selectedProviders.profile
          : refreshed.selectedProviders.profile,
        fundamentals: retainFundamentals
          ? current.selectedProviders.fundamentals
          : refreshed.selectedProviders.fundamentals,
        earnings: retainEarnings
          ? current.selectedProviders.earnings
          : refreshed.selectedProviders.earnings,
      }),
    });
  }
  if (section === "analyst") {
    const retainAnalyst = hasTransientUpstreamFailure(refreshed, "analyst");
    return Object.freeze({
      ...current,
      ...common,
      analyst: retainAnalyst ? current.analyst : refreshed.analyst,
      selectedProviders: Object.freeze({
        ...current.selectedProviders,
        instrument: refreshed.selectedProviders.instrument,
        market: refreshed.selectedProviders.market,
        analyst: retainAnalyst
          ? current.selectedProviders.analyst
          : refreshed.selectedProviders.analyst,
      }),
    });
  }
  const retainNews = hasTransientUpstreamFailure(refreshed, "news");
  return Object.freeze({
    ...current,
    ...common,
    news: retainNews ? current.news : refreshed.news,
    selectedProviders: Object.freeze({
      ...current.selectedProviders,
      instrument: refreshed.selectedProviders.instrument,
      market: refreshed.selectedProviders.market,
      news: retainNews
        ? current.selectedProviders.news
        : refreshed.selectedProviders.news,
    }),
  });
}
