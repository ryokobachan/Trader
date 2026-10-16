/** Public read contract for producer-owned finance stores; never exposes SQL or file access. */
export const SHARED_DATA_IDS = [
  "institutional-filings", "institutional-holdings", "institutional-managers",
  "x-posts", "x-mentions", "x-mention-outcomes", "x-author-scores",
  "x-author-strategies", "x-accounts", "x-prices",
] as const;
export type SharedDataId = typeof SHARED_DATA_IDS[number];
export type SharedDataResponse = Readonly<{
  schemaVersion: "trader.shared-data.v1";
  dataset: SharedDataId;
  rows: readonly Readonly<Record<string, unknown>>[];
  columns: readonly Readonly<{ key: string; label: string; labelJa?: string }>[];
  source: unknown;
  provenance: Readonly<Record<string, unknown>>;
  coverage: Readonly<Record<string, unknown>>;
  pagination: Readonly<{ limit: number; nextCursor: string | null; [key: string]: unknown }>;
  [key: string]: unknown;
}>;

export function isSharedDataId(value: string): value is SharedDataId {
  return (SHARED_DATA_IDS as readonly string[]).includes(value);
}
