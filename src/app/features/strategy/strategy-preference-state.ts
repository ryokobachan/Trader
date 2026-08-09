import type { StrategyPreference } from "../../platform/strategy-preference-contracts";

function isStrictlyNewer(
  candidate: StrategyPreference,
  current: StrategyPreference,
): boolean {
  const candidateTime = Date.parse(candidate.updatedAt);
  const currentTime = Date.parse(current.updatedAt);
  if (Number.isFinite(candidateTime) && Number.isFinite(currentTime)) {
    return candidateTime > currentTime;
  }
  return candidate.updatedAt > current.updatedAt;
}

/**
 * Merges complete or partial server snapshots without allowing an older read to
 * overwrite a mutation response that has already reached the client.
 */
export function mergeStrategyPreferenceSnapshots(
  current: readonly StrategyPreference[],
  incoming: readonly StrategyPreference[],
): StrategyPreference[] {
  const merged = new Map(current.map((preference) => [preference.strategyId, preference]));
  for (const preference of incoming) {
    const existing = merged.get(preference.strategyId);
    if (!existing || isStrictlyNewer(preference, existing)) {
      merged.set(preference.strategyId, preference);
    }
  }
  return [...merged.values()];
}
