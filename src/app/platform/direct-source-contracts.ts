/** Normalized, credential-free datasets for standalone research. */
export type DirectSourceId = "sec-filings" | "sec-facts" | "sec-insiders" | "finra-short-volume" | "usaspending" | "fred" | "cnn-fear-greed";

export type DirectSourceQuery = Readonly<{
  symbol?: string;
  date?: string;
  series?: string;
  recipient?: string;
  member?: string;
  cik?: string;
}>;

export type DirectSourceColumn = Readonly<{
  key: string;
  label: string;
  labelJa: string;
  format?: "text" | "number" | "date" | "url" | "ratio" | "usd";
}>;

export type DirectSourceDataset = Readonly<{
  sourceId: DirectSourceId;
  sourceName: string;
  sourceUrl: string;
  fetchedAt: string;
  columns: readonly DirectSourceColumn[];
  rows: readonly Readonly<Record<string, string | number | null>>[];
  coverage: Readonly<{ status: "complete" | "partial" | "empty"; note: string; noteJa?: string }>;
  notes: readonly string[];
  notesJa?: readonly string[];
}>;

export type DirectSourceDefinition = Readonly<{
  id: DirectSourceId;
  name: string;
  nameJa: string;
  description: string;
  descriptionJa: string;
  sourceUrl: string;
  inputs: readonly (keyof DirectSourceQuery)[];
  defaults: DirectSourceQuery;
  credential: string | null;
}>;
