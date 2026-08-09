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
  {
    id: "sample.donchian-20-atr-stop.v1",
    family: "rule",
    status: "research",
    candidateAt: "2026/08/09 10:30",
    audit: { overfit: null, leakage: null },
    netReturn: 11.9,
    maxDrawdown: -12.8,
    recoveryFactor: 0.93,
    sharpe: 0.78,
    forwardReturn: 1.7,
    winRate: 44.9,
    trades: 28,
    symbols: 6,
    cash: 22,
    copy: {
      en: {
        name: "20-Day Breakout + ATR Stop",
        category: "Breakout",
        sourceLabels: ["20-day high", "ATR 14"],
        auditVerdict: "Costs not validated",
        headline: "Buy a 20-day high and trail the position with a two-ATR stop.",
      },
      ja: {
        name: "20日ブレイクアウト + ATRストップ",
        category: "ブレイクアウト",
        sourceLabels: ["20日高値", "ATR 14"],
        auditVerdict: "コスト未検証",
        headline: "20日高値の更新で買い、2ATRのトレーリングストップを使うサンプル。",
      },
    },
  },
  {
    id: "sample.quality-value-top-25.v1",
    family: "research",
    status: "research",
    candidateAt: "2026/08/09 10:00",
    audit: { overfit: null, leakage: null },
    netReturn: 10.6,
    maxDrawdown: -11.6,
    recoveryFactor: 0.91,
    sharpe: 0.71,
    forwardReturn: 1.4,
    winRate: 54.2,
    trades: 50,
    symbols: 25,
    cash: 22,
    copy: {
      en: {
        name: "Quality + Value Top 25",
        category: "Factor",
        sourceLabels: ["ROIC", "FCF yield", "Debt"],
        auditVerdict: "PIT review required",
        headline: "Rank profitable U.S. companies by quality and valuation, then hold the top 25 equally.",
      },
      ja: {
        name: "クオリティ + バリュー Top 25",
        category: "ファクター",
        sourceLabels: ["ROIC", "FCF利回り", "負債"],
        auditVerdict: "PIT確認が必要",
        headline: "収益性のある米国企業を品質と割安度で順位付けし、上位25銘柄を等加重するサンプル。",
      },
    },
  },
  {
    id: "sample.low-volatility-rotation.v1",
    family: "portfolio2",
    status: "pinned",
    candidateAt: "2026/08/09 09:30",
    audit: { overfit: null, leakage: null },
    netReturn: 8.7,
    maxDrawdown: -7.8,
    recoveryFactor: 1.12,
    sharpe: 0.82,
    forwardReturn: 0.9,
    winRate: 56,
    trades: 12,
    symbols: 20,
    cash: 22,
    copy: {
      en: {
        name: "Low Volatility Top 20",
        category: "Risk based",
        sourceLabels: ["Daily return", "Realized volatility"],
        auditVerdict: "Turnover is illustrative",
        headline: "Hold the 20 least volatile liquid U.S. stocks and rebalance every month.",
      },
      ja: {
        name: "低ボラティリティ Top 20",
        category: "リスクベース",
        sourceLabels: ["日次リターン", "実現ボラティリティ"],
        auditVerdict: "売買回転は参考値",
        headline: "流動性のある米国株から実現ボラティリティの低い20銘柄を選び、月次で見直すサンプル。",
      },
    },
  },
  {
    id: "sample.earnings-revision-momentum.v1",
    family: "research",
    status: "research",
    candidateAt: "2026/08/09 09:00",
    audit: { overfit: null, leakage: null },
    netReturn: 12.4,
    maxDrawdown: -14.2,
    recoveryFactor: 0.87,
    sharpe: 0.76,
    forwardReturn: 1.8,
    winRate: 52.8,
    trades: 36,
    symbols: 8,
    cash: 22,
    copy: {
      en: {
        name: "Earnings Revision Momentum",
        category: "Fundamental momentum",
        sourceLabels: ["EPS estimate", "Revenue estimate", "Price"],
        auditVerdict: "PIT review required",
        headline: "Follow companies with rising analyst estimates and positive medium-term price momentum.",
      },
      ja: {
        name: "業績予想改定モメンタム",
        category: "業績モメンタム",
        sourceLabels: ["EPS予想", "売上予想", "価格"],
        auditVerdict: "PIT確認が必要",
        headline: "アナリスト予想が上方修正され、中期価格モメンタムも正の企業を追うサンプル。",
      },
    },
  },
  {
    id: "sample.relative-strength-6-1.v1",
    family: "rule",
    status: "research",
    candidateAt: "2026/08/09 08:30",
    audit: { overfit: null, leakage: null },
    netReturn: 14.3,
    maxDrawdown: -15.7,
    recoveryFactor: 0.91,
    sharpe: 0.88,
    forwardReturn: 2.1,
    winRate: 53.3,
    trades: 40,
    symbols: 10,
    cash: 22,
    copy: {
      en: {
        name: "6–1 Month Relative Strength",
        category: "Momentum",
        sourceLabels: ["Adjusted close", "Volume"],
        auditVerdict: "Universe is illustrative",
        headline: "Rank U.S. stocks by return from six months ago through one month ago and hold the top 10.",
      },
      ja: {
        name: "6–1か月レラティブストレングス",
        category: "モメンタム",
        sourceLabels: ["調整後終値", "出来高"],
        auditVerdict: "ユニバースは例示",
        headline: "6か月前から1か月前までのリターンで米国株を順位付けし、上位10銘柄を保有するサンプル。",
      },
    },
  },
  {
    id: "sample.dividend-growth.v1",
    family: "research",
    status: "research",
    candidateAt: "2026/08/09 08:00",
    audit: { overfit: null, leakage: null },
    netReturn: 8.3,
    maxDrawdown: -8.9,
    recoveryFactor: 0.93,
    sharpe: 0.74,
    forwardReturn: 0.7,
    winRate: 57.1,
    trades: 20,
    symbols: 20,
    cash: 22,
    copy: {
      en: {
        name: "Dividend Growth Screen",
        category: "Income",
        sourceLabels: ["Dividend", "Payout ratio", "FCF"],
        auditVerdict: "Corporate actions not tested",
        headline: "Screen for sustainable dividend growth, moderate payout ratios, and positive free cash flow.",
      },
      ja: {
        name: "増配株スクリーニング",
        category: "インカム",
        sourceLabels: ["配当", "配当性向", "FCF"],
        auditVerdict: "企業行動は未検証",
        headline: "継続的な増配、無理のない配当性向、正のフリーキャッシュフローを満たす企業を探すサンプル。",
      },
    },
  },
  {
    id: "sample.market-neutral-pairs.v1",
    family: "research",
    status: "research",
    candidateAt: "2026/08/09 07:30",
    audit: { overfit: null, leakage: null },
    netReturn: 5.1,
    maxDrawdown: -5.8,
    recoveryFactor: 0.88,
    sharpe: 0.63,
    forwardReturn: -0.2,
    winRate: 58.6,
    trades: 46,
    symbols: 6,
    cash: 22,
    copy: {
      en: {
        name: "Market-Neutral Pairs Sample",
        category: "Relative value",
        sourceLabels: ["Price ratio", "Z-score"],
        auditVerdict: "Borrow costs not modeled",
        headline: "Trade temporary price-ratio dislocations between a small set of related U.S. stocks.",
      },
      ja: {
        name: "マーケットニュートラル・ペア",
        category: "相対価値",
        sourceLabels: ["価格比", "Zスコア"],
        auditVerdict: "借株コスト未反映",
        headline: "関連性の高い米国株ペアで、一時的な価格比率の乖離を取引するサンプル。",
      },
    },
  },
] as const satisfies readonly SampleStrategyDefinition[];

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
