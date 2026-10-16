export type IndicatorLocale = "en" | "ja";

const EN = {
  objectTree: "OBJECT TREE",
  chartIndicators: "Indicators on chart",
  add: "Add",
  managerHint: "Manage visibility, settings, and removal here.",
  show: "Show {name}",
  hide: "Hide {name}",
  settings: "{name} settings",
  remove: "Remove {name}",
  emptyTitle: "No indicators",
  emptyBody: "Choose one from the top bar or the Add button.",
  addIndicator: "Add indicator",
  saveNote: "Add indicators from the top bar and change parameters from the gear. Active indicators and settings are saved automatically on this device.",
  libraryTitle: "Indicators, metrics, and strategies",
  close: "Close",
  search: "Search",
  searchAria: "Search indicators",
  categoryAria: "Indicator categories",
  clickToAdd: "Click to add to chart",
  addFavorite: "Add {name} to favorites",
  removeFavorite: "Remove {name} from favorites",
  builtIns: "Trader Built-ins",
  added: "Added",
  emptySectionTitle: "{section} items will be added in a future data-connection phase",
  emptySectionBody: "This prototype lets you try the built-in technical indicator add and settings flow.",
  showTechnicals: "Show technicals",
  shortcutOpen: "to open",
  shortcutClose: "to close",
  dialogSettings: "{name} settings",
  tabParameters: "Parameters",
  tabStyle: "Style",
  tabVisibility: "Visibility",
  length: "Length",
  priceRows: "Price bands",
  barColor: "Bar color",
  upVolumeColor: "Up-bar color",
  downVolumeColor: "Down-bar color",
  volumeHelp: "Trading volume for each bar, shown at the bottom of the price chart.",
  volumeProfileHelp: "Estimated volume across visible price bands. Gold marks the highest-volume band (POC).",
  standardDeviation: "Standard deviation",
  fast: "Fast",
  slow: "Slow",
  signal: "Signal",
  kSmoothing: "K smoothing",
  dLength: "D length",
  source: "Source",
  anchorPeriod: "Anchor period",
  offset: "Offset",
  lineColor: "Line color",
  width: "Width",
  line: "Line",
  solid: "Solid",
  dashed: "Dashed",
  dotted: "Dotted",
  visibilityHeading: "Show on these timeframes",
  paneAria: "{name} chart",
  panesAria: "Separate-pane indicators",
  insufficientHistory: "Not enough price history to calculate this indicator.",
  minute: "Minutes",
  hour: "Hours",
  day: "Days",
  week: "Weeks",
  month: "Months",
  minuteRange: "1m–45m",
  hourRange: "1h–12h",
  dayRange: "Daily",
  weekRange: "Weekly",
  monthRange: "Monthly",
  default: "Default",
  cancel: "Cancel",
  apply: "Apply",
  settingsApplied: "Applied {name} settings.",
} as const;

const JA: Record<keyof typeof EN, string> = {
  objectTree: "オブジェクトツリー",
  chartIndicators: "チャート上の指標",
  add: "追加",
  managerHint: "表示・設定・削除をここから管理できます",
  show: "{name}を表示",
  hide: "{name}を非表示",
  settings: "{name}の設定",
  remove: "{name}を削除",
  emptyTitle: "インジケーターはありません",
  emptyBody: "上部バーまたは追加ボタンから選択できます。",
  addIndicator: "インジケーターを追加",
  saveNote: "追加は上部バー、パラメーター変更は歯車から行います。適用中の指標と設定はこの端末へ自動保存されます。",
  libraryTitle: "インジケーター、指標、ストラテジー",
  close: "閉じる",
  search: "検索",
  searchAria: "インジケーターを検索",
  categoryAria: "インジケーター分類",
  clickToAdd: "クリックするとチャートへ追加",
  addFavorite: "{name}をお気に入りに追加",
  removeFavorite: "{name}をお気に入りから削除",
  builtIns: "Trader 内蔵",
  added: "追加済み",
  emptySectionTitle: "{section}の項目は次のデータ接続フェーズで追加します",
  emptySectionBody: "このモックでは、内蔵テクニカル指標の追加・設定フローを操作できます。",
  showTechnicals: "テクニカルを表示",
  shortcutOpen: "で開く",
  shortcutClose: "で閉じる",
  dialogSettings: "{name}の設定",
  tabParameters: "パラメーター",
  tabStyle: "スタイル",
  tabVisibility: "表示",
  length: "期間",
  priceRows: "価格帯の分割数",
  barColor: "棒の色",
  upVolumeColor: "上昇バーの色",
  downVolumeColor: "下降バーの色",
  volumeHelp: "各ローソク足の出来高を、価格チャートの下部に表示します。",
  volumeProfileHelp: "表示範囲の価格帯別出来高を推定します。金色は出来高が最大の価格帯（POC）です。",
  standardDeviation: "標準偏差",
  fast: "短期",
  slow: "長期",
  signal: "シグナル",
  kSmoothing: "K平滑化",
  dLength: "D期間",
  source: "ソース",
  anchorPeriod: "アンカー期間",
  offset: "オフセット",
  lineColor: "ライン色",
  width: "太さ",
  line: "ライン",
  solid: "実線",
  dashed: "破線",
  dotted: "点線",
  visibilityHeading: "次の時間足に表示",
  paneAria: "{name}チャート",
  panesAria: "サブパネルインジケーター",
  insufficientHistory: "計算に必要な価格履歴が不足しています",
  minute: "分",
  hour: "時間",
  day: "日",
  week: "週",
  month: "月",
  minuteRange: "1分〜45分",
  hourRange: "1時間〜12時間",
  dayRange: "日足",
  weekRange: "週足",
  monthRange: "月足",
  default: "デフォルト",
  cancel: "キャンセル",
  apply: "適用",
  settingsApplied: "{name}の設定を適用しました",
};

type IndicatorMessageKey = keyof typeof EN;
type Parameters = Readonly<Record<string, string | number>>;

function interpolate(message: string, parameters?: Parameters) {
  if (!parameters) return message;
  return message.replace(/\{([a-zA-Z0-9_]+)\}/g, (token, name: string) => {
    const value = parameters[name];
    return value === undefined ? token : String(value);
  });
}

export function indicatorText(
  locale: IndicatorLocale,
  key: IndicatorMessageKey,
  parameters?: Parameters,
) {
  return interpolate((locale === "ja" ? JA : EN)[key], parameters);
}

const EN_INDICATORS: Readonly<Record<string, Readonly<{ name: string; description: string }>>> = {
  sma20: { name: "Simple Moving Average", description: "20-period average of closing prices" },
  ema50: { name: "Exponential Moving Average", description: "50-period average weighted toward recent prices" },
  bollinger: { name: "Bollinger Bands", description: "20 periods and two standard deviations" },
  vwap: { name: "Volume Weighted Average Price", description: "Average price weighted by volume" },
  rsi14: { name: "Relative Strength Index", description: "Identifies overbought and oversold conditions" },
  macd: { name: "MACD 12, 26, 9", description: "Uses two EMAs to identify trend changes" },
  stochastic: { name: "Stochastic Oscillator", description: "Measures the close within its recent range" },
  atr14: { name: "Average True Range", description: "Realized range over 14 periods" },
  adx14: { name: "Average Directional Index", description: "Measures trend strength" },
  obv: { name: "On Balance Volume", description: "Estimates money flow from volume" },
  volume: { name: "Volume", description: "Trading volume per bar at the bottom of the chart" },
  volumeProfile: { name: "Volume Profile", description: "Estimated volume by price across visible bars; gold marks the highest-volume band (POC)" },
};

const EN_CATEGORIES: Readonly<Record<string, string>> = {
  "トレンド": "Trend",
  "モメンタム": "Momentum",
  "ボラティリティ": "Volatility",
  "出来高": "Volume",
};

const EN_PLACEMENTS: Readonly<Record<string, string>> = {
  "チャート上": "On chart",
  "サブパネル": "Separate pane",
};

export function localizeIndicator(
  locale: IndicatorLocale,
  indicator: Readonly<{
    id: string;
    name: string;
    description: string;
    category: string;
    placement: string;
  }>,
) {
  if (locale === "ja") return indicator;
  const copy = EN_INDICATORS[indicator.id];
  return {
    ...indicator,
    name: copy?.name ?? indicator.name,
    description: copy?.description ?? indicator.description,
    category: EN_CATEGORIES[indicator.category] ?? indicator.category,
    placement: EN_PLACEMENTS[indicator.placement] ?? indicator.placement,
  };
}

const SECTION_EN: Readonly<Record<string, string>> = {
  "お気に入り": "Favorites",
  "マイスクリプト": "My scripts",
  "テクニカル": "Technicals",
  "ファンダメンタルズ": "Fundamentals",
  "コミュニティ": "Community",
};

export function localizeIndicatorSection(locale: IndicatorLocale, section: string) {
  return locale === "ja" ? section : SECTION_EN[section] ?? section;
}

const SOURCE_EN: Readonly<Record<string, string>> = {
  "終値": "Close",
  "始値": "Open",
  "高値": "High",
  "安値": "Low",
  HL2: "HL2",
  HLC3: "HLC3",
};

const ANCHOR_EN: Readonly<Record<string, string>> = {
  "セッション": "Session",
  "週": "Week",
  "月": "Month",
  "四半期": "Quarter",
  "年": "Year",
};

export function localizeIndicatorSource(locale: IndicatorLocale, source: string) {
  return locale === "ja" ? source : SOURCE_EN[source] ?? source;
}

export function localizeIndicatorAnchor(locale: IndicatorLocale, anchor: string) {
  return locale === "ja" ? anchor : ANCHOR_EN[anchor] ?? anchor;
}

export function indicatorAppliedCount(locale: IndicatorLocale, count: number) {
  if (locale === "ja") return `${count}個を適用`;
  return `${count} indicator${count === 1 ? "" : "s"} applied`;
}

export function indicatorResultCount(locale: IndicatorLocale, count: number) {
  if (locale === "ja") return `${count}件`;
  return `${count} result${count === 1 ? "" : "s"}`;
}
