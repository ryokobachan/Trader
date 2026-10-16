export const MIDAS_RESEARCH_VIEW_IDS = Object.freeze([
  "institutional",
  "ideas",
  "data-sources",
  "x-analysis",
] as const);

export type MidasResearchViewId = (typeof MIDAS_RESEARCH_VIEW_IDS)[number];

export function isMidasResearchViewId(value: string): value is MidasResearchViewId {
  return MIDAS_RESEARCH_VIEW_IDS.includes(value as MidasResearchViewId);
}

export type MidasReportDuration = "1M" | "3M" | "6M" | "1Y" | "3Y" | "all";
export type MidasReportSortKey =
  | "profit"
  | "max_drawdown"
  | "recovery_factor"
  | "sharpe"
  | "win_rate"
  | "audit"
  | "datetime";

export type MidasReportCard = Readonly<{
  id: string;
  title: string;
  summary: string;
  datetime: string | null;
  badges: readonly Readonly<{
    key: string;
    label: string;
    tone: "positive" | "negative" | "warn" | "neutral";
  }>[];
  performance?: Readonly<{
    selectedPeriod?: Readonly<{
      duration: MidasReportDuration;
      profit: number | null;
      maxDrawdown: number | null;
      recoveryFactor: number | null;
      sharpe: number | null;
      winRate: number | null;
      startDate: string | null;
      endDate: string | null;
      pointCount: number;
    }>;
  }>;
  audit?: Readonly<{
    overfitRiskScore: number;
    leakageRiskScore: number;
    overfitRiskLabel: string;
    leakageRiskLabel: string;
    overfitReason: string;
    leakageReason: string;
    dsrPboLabel: string;
  }>;
  adoption?: Readonly<{ adopted: boolean }>;
  strategyDisplay?: Readonly<{
    name: string;
    category: string;
    categoryDescription: string | null;
    sourceLabels: readonly string[];
  }>;
}>;

export type MidasInstitutionalResponse = Readonly<{
  ok: boolean;
  refreshing?: boolean;
  generatedAt: string;
  counts: Readonly<{ strategy: number }>;
  tracks: Readonly<{
    strategy: Readonly<{
      cards: readonly MidasReportCard[];
      pagination: Readonly<{
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
        hasPreviousPage: boolean;
        hasNextPage: boolean;
        returned: number;
      }>;
    }>;
  }>;
}>;

export type MidasIdea = Readonly<{
  id: string;
  name: string;
  category: string;
  subcategory: string;
  data_needs: readonly string[];
  status: string;
  buildable_spec?: Readonly<{ feasibility?: string }>;
}>;

export type MidasIdeasResponse = Readonly<{
  available: boolean;
  generated_at: string;
  categories: readonly Readonly<{ key: string; label: string; blurb: string }>[];
  ideas: readonly MidasIdea[];
}>;

export type MidasDataSource = Readonly<{
  id: string;
  display_name: string;
  backing?: Readonly<{ db?: string; table?: string; path?: string }>;
  ingestion?: Readonly<{
    coverage_newest?: string | null;
    coverage_oldest?: string | null;
    detail?: string;
    errors?: number;
    last_ingested_at?: string | null;
    last_run_at?: string | null;
    status?: string;
  }>;
  pit?: Readonly<{ quality?: string }>;
  semantics?: Readonly<{
    catalog_role?: string;
    data_kind?: string;
    is_external?: boolean;
    origin?: string;
    plain_name?: string;
    scope?: string;
  }>;
  search_text?: string;
}>;

export type MidasDataSourcesResponse = Readonly<{
  available: boolean;
  generated_at: string;
  sources: readonly MidasDataSource[];
}>;

export type MidasXAccount = Readonly<{
  authorHandle: string;
  displayHandle: string;
  accountName: string;
  avatarUrl?: string | null;
  mentionCount: number;
  symbolCount: number;
  overallScore: number | null;
  earlyDiscoveryScore: number | null;
  shortTermPredictionScore: number | null;
  strategyProfitScore: number | null;
  avgNetReturn: number | null;
  commonStrategy?: Readonly<{
    version?: string;
    status: "ready" | "insufficient_data" | "no_completed_trades";
    netReturn: number | null;
    benchmarkReturn?: number | null;
    excessReturn?: number | null;
    profitScore?: number | null;
    completedTradeCount: number;
    entryCohortCount: number;
    uniqueSymbolCount?: number;
    winRate?: number | null;
    firstEntryAt?: string | null;
    lastExitAt?: string | null;
  }> | null;
  topSymbols?: readonly string[];
  postCount?: number;
  positiveMentionCount?: number;
  negativeMentionCount?: number;
  neutralMentionCount?: number;
  validationStartAt?: string | null;
  validationEndAt?: string | null;
  latestUpdateAt: string | null;
  latestCollectionAt: string | null;
  reliabilityLabel?: string | null;
}>;

export type MidasXAccountSymbolSummary = Readonly<{
  symbol: string;
  convictionScore?: number | null;
  convictionLabel?: string | null;
  stanceScore?: number | null;
  stanceLabel?: string | null;
  mentionCount: number;
  positiveMentionCount?: number;
  negativeMentionCount?: number;
  neutralMentionCount?: number;
  signalIntervalCount?: number;
  signalHitRate?: number | null;
  signalBacktestReturn?: number | null;
  sinceFirstMentionReturn?: number | null;
  firstMentionAt?: string | null;
  latestMentionAt?: string | null;
}>;

export type MidasXAccountMention = Readonly<{
  mentionId: string;
  symbol: string;
  publishedAt: string;
  mentionText: string;
  postUrl?: string | null;
  signalDirection?: string | null;
  expectedMove?: string | null;
  sentimentSource?: string | null;
  outcome?: Readonly<{
    netReturn?: number | null;
    relativeNetReturn?: number | null;
  }> | null;
}>;

export type MidasXWeeklyAccountSummary = Readonly<{
  generatedAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  totalMentionCount?: number;
  directionalMentionCount?: number;
  symbolCount?: number;
  summaryText?: string | null;
}>;

export type MidasXAccountDetail = MidasXAccount & Readonly<{
  weeklySummary?: MidasXWeeklyAccountSummary | null;
  symbolSummaries?: readonly MidasXAccountSymbolSummary[];
  mentions?: readonly MidasXAccountMention[];
}>;

export type MidasXAccountDetailResponse = Readonly<{
  ok: boolean;
  available: boolean;
  checkedAt: string;
  account: MidasXAccountDetail | null;
  mentionPage?: Readonly<{
    total: number;
    limit: number;
    offset: number;
    symbol?: string;
  }>;
}>;

export type MidasXSymbolSignal = Readonly<{
  symbol: string;
  recommendationScore: number | null;
  recommendationLabel: string;
  historicalTradeCount: number;
  historicalAvgNetReturn: number | null;
  historicalWinRate: number | null;
  recentBullishAuthorCount: number;
  recentBearishAuthorCount: number;
  authorQualityScore: number | null;
  latestMentionAt: string | null;
  latestMentionAgeDays: number | null;
}>;

export type MidasXAnalysisResponse = Readonly<{
  ok: boolean;
  available: boolean;
  checkedAt: string;
  analysisSnapshotAt?: string | null;
  horizonDays: number;
  accounts: readonly MidasXAccount[];
  symbolSignals: readonly MidasXSymbolSignal[];
  symbolPage?: Readonly<{
    total: number;
    limit: number;
    offset: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  }>;
  totals: Readonly<{
    accountCount: number;
    mentionCount: number;
    outcomeCount: number;
    symbolCount: number;
  }>;
  wallClockFreshness?: Readonly<{
    state?: string;
    staleReasons?: readonly string[];
    collection?: Readonly<{
      state?: string;
      latestAt?: string | null;
      activeTargetCount?: number;
      pausedTargetCount?: number;
    }>;
    marketCoverage?: Readonly<{
      price?: Readonly<{
        staleSymbolCount?: number;
        unknownSymbolCount?: number;
      }>;
      outcome?: Readonly<{
        missingDueMentionCount?: number;
      }>;
    }>;
  }>;
}>;

export function formatMidasPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const percentage = value * 100;
  return `${percentage > 0 ? "+" : ""}${percentage.toFixed(1)}%`;
}

export function formatMidasRate(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatMidasScore(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

export function midasXAccountStrategyReturn(account: MidasXAccount): number | null {
  const value = account.commonStrategy?.netReturn;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function midasDataSourceStorage(source: MidasDataSource): string {
  const database = source.backing?.db?.trim() ?? "";
  const table = source.backing?.table?.trim() ?? "";
  const path = source.backing?.path?.trim() ?? "";
  if (database && table) return `${database}:${table}`;
  return path || database || table || "—";
}

export function visibleMidasIdeas(ideas: readonly MidasIdea[]): readonly MidasIdea[] {
  return ideas.filter((idea) => idea.buildable_spec?.feasibility !== "infeasible");
}

export function visibleMidasDataSources(
  sources: readonly MidasDataSource[],
): readonly MidasDataSource[] {
  return sources.filter((source) => source.semantics?.catalog_role === "data_source");
}
