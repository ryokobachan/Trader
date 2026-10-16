export type TalibDefinition = Readonly<{
  id: string;
  name: string;
  group: string;
  parameters: Readonly<Record<string, number>>;
  inputs: Readonly<Record<string, string | readonly string[]>>;
  outputs: readonly string[];
  lookback: number;
}>;

export type TalibCatalog = Readonly<{
  schemaVersion: "trader.talib.v1";
  engine: "TA-Lib";
  version: string;
  indicators: readonly TalibDefinition[];
  limits: Readonly<{ maxBars: number; maxIndicators: number }>;
}>;

export type TalibResult = Readonly<{
  id: string;
  name: string;
  group: string;
  parameters: Readonly<Record<string, number>>;
  inputs: Readonly<Record<string, string | readonly string[]>>;
  lookback: number;
  series: readonly Readonly<{ name: string; values: readonly (number | null)[] }>[];
}>;

export type TalibCalculation = Readonly<{
  schemaVersion: "trader.talib.v1";
  engine: "TA-Lib";
  version: string;
  times: readonly string[];
  barCount: number;
  results: readonly TalibResult[];
}>;
