import type { Locale } from "@/app/platform/i18n";
import type { StrategyPreference } from "@/app/platform/strategy-preference-contracts";

export type SampleStrategyRecord = {
  id: string;
  family: "portfolio2" | "rule" | "research";
  status: "pinned" | "research";
  candidateAt: string;
  name: string;
  category: string;
  sourceLabels: string[];
  audit: {
    overfit: number | null;
    leakage: number | null;
    verdict: string;
  };
  netReturn: number;
  maxDrawdown: number;
  recoveryFactor: number;
  sharpe: number | null;
  forwardReturn: number;
  winRate: number;
  trades: number;
  symbols: number;
  cash: number;
  headline: string;
};

type SampleStrategyCopy = Pick<
  SampleStrategyRecord,
  "name" | "category" | "sourceLabels" | "headline"
> & {
  auditVerdict: string;
};

type SampleStrategyDefinition = Omit<
  SampleStrategyRecord,
  "name" | "category" | "sourceLabels" | "headline" | "audit"
> & {
  audit: Omit<SampleStrategyRecord["audit"], "verdict">;
  copy: Readonly<Record<Locale, SampleStrategyCopy>>;
};

// This is the deployment-owned starter catalog. Metrics are deliberately
// illustrative and conservative: they are not the output of a backtest run.
export const SAMPLE_STRATEGY_DEFINITIONS = [
  {
    id: "sample.tech-leaders-equal-weight.v1",
    family: "portfolio2",
    status: "pinned",
    candidateAt: "2026/08/09 12:00",
    audit: { overfit: null, leakage: null },
    netReturn: 14.2,
    maxDrawdown: -14.6,
    recoveryFactor: 0.97,
    sharpe: 1.03,
    forwardReturn: 2.4,
    winRate: 56.3,
    trades: 48,
    symbols: 4,
    cash: 22,
    copy: {
      en: {
        name: "Tech Leaders Equal Weight",
        category: "Portfolio",
        sourceLabels: ["Price", "Monthly rebalance"],
        auditVerdict: "Illustrative metrics",
        headline: "Hold four large U.S. technology stocks at equal target weights and rebalance monthly.",
      },
      ja: {
        name: "米国テック4銘柄・等加重",
        category: "ポートフォリオ",
        sourceLabels: ["価格", "月次リバランス"],
        auditVerdict: "表示用の参考値",
        headline: "米国の大型テクノロジー4銘柄を等加重で保有し、月次で配分を戻すサンプル。",
      },
    },
  },
  {
    id: "sample.aapl-sma-50-200.v1",
    family: "rule",
    status: "pinned",
    candidateAt: "2026/08/09 11:30",
    audit: { overfit: null, leakage: null },
    netReturn: 9.8,
    maxDrawdown: -10.7,
    recoveryFactor: 0.92,
    sharpe: 0.68,
    forwardReturn: 1.1,
    winRate: 46.8,
    trades: 7,
    symbols: 1,
    cash: 22,
    copy: {
      en: {
        name: "AAPL 50/200-Day SMA Trend",
        category: "Trend following",
        sourceLabels: ["Close", "SMA 50", "SMA 200"],
        auditVerdict: "Walk-forward not run",
        headline: "Own AAPL while its 50-day moving average is above the 200-day moving average.",
      },
      ja: {
        name: "AAPL 50日・200日SMAトレンド",
        category: "トレンドフォロー",
        sourceLabels: ["終値", "SMA 50", "SMA 200"],
        auditVerdict: "Walk-forward未実施",
        headline: "AAPLの50日移動平均が200日移動平均を上回る期間だけ保有するサンプル。",
      },
    },
  },
  {
    id: "sample.rsi-14-mean-reversion.v1",
    family: "rule",
    status: "research",
    candidateAt: "2026/08/09 11:00",
    audit: { overfit: null, leakage: null },
    netReturn: 7.6,
    maxDrawdown: -9.4,
    recoveryFactor: 0.81,
    sharpe: 0.59,
    forwardReturn: -0.6,
    winRate: 61.5,
    trades: 34,
    symbols: 4,
    cash: 22,
    copy: {
      en: {
        name: "RSI 14 Mean Reversion Basket",
        category: "Mean reversion",
        sourceLabels: ["Close", "RSI 14"],
        auditVerdict: "Parameters are examples",
        headline: "Enter liquid U.S. stocks after RSI falls below 30 and exit after it recovers above 50.",
      },
      ja: {
        name: "RSI 14 平均回帰バスケット",
        category: "平均回帰",
        sourceLabels: ["終値", "RSI 14"],
        auditVerdict: "パラメータは例示",
        headline: "流動性のある米国株をRSI 30未満で買い、50超への回復で手仕舞うサンプル。",
      },
    },
  },
] as const satisfies readonly SampleStrategyDefinition[];

/**
 * Former built-in IDs stay reserved so previously saved transaction ledgers
 * remain addressable even though these samples no longer appear in the UI.
 */
export const RETIRED_SAMPLE_STRATEGY_IDS = Object.freeze([
  "sample.donchian-20-atr-stop.v1",
  "sample.quality-value-top-25.v1",
  "sample.low-volatility-rotation.v1",
  "sample.earnings-revision-momentum.v1",
  "sample.relative-strength-6-1.v1",
  "sample.dividend-growth.v1",
  "sample.market-neutral-pairs.v1",
] as const);

export const DEFAULT_SAMPLE_STRATEGY_ID = SAMPLE_STRATEGY_DEFINITIONS[0].id;

export function sampleStrategiesForLocale(
  locale: Locale,
  preferences: readonly StrategyPreference[] = [],
): SampleStrategyRecord[] {
  const preferencesById = new Map(
    preferences.map((preference) => [preference.strategyId, preference] as const),
  );
  return SAMPLE_STRATEGY_DEFINITIONS.flatMap(({ copy, audit, ...definition }) => {
    const preference = preferencesById.get(definition.id);
    if (preference?.isDeleted) return [];
    const localized = copy[locale];
    return [{
      ...definition,
      ...localized,
      ...(preference?.name === undefined ? {} : { name: preference.name }),
      ...(preference?.headline === undefined ? {} : { headline: preference.headline }),
      sourceLabels: [...localized.sourceLabels],
      audit: {
        ...audit,
        verdict: localized.auditVerdict,
      },
    }];
  });
}
