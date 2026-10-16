import {
  PROVIDER_SCHEMA_VERSION,
  type AnalystRatingHistory,
  type AnalystRatingHistoryRequest,
  type Instrument,
  type ProviderAdapter,
  type ProviderEnvironment,
  type ProviderRegistration,
  type ProviderRequestContext,
} from "@/app/platform/provider-contracts";
import { createBenzingaProvider } from "../benzinga/analyst.server";
import { createGoogleFinanceProvider } from "../google-finance/analyst.server";
import {
  ANALYST_MERGE_LOOKBACK_MONTHS,
  ANALYST_MERGE_PROVIDER_ID,
  mergeAnalystConsensus,
  mergeAnalystRatingHistories,
  type AnalystMergeSource,
} from "./merge";

const MAX_HISTORY_PAGE_SIZE = 1_000;

export type AnalystMergeProviderOptions = Readonly<{
  benzinga?: ProviderAdapter;
  googleFinance?: ProviderAdapter;
  now?: () => Date;
}>;

export class AnalystMergeProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalystMergeProviderError";
  }
}

const manifest = {
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  id: ANALYST_MERGE_PROVIDER_ID,
  version: "1.0.0",
  displayName: "Google Finance + Benzinga Analyst Ratings",
  capabilities: ["analyst.consensus", "analyst.ratings"],
  markets: ["US"],
  assetTypes: ["common_stock", "adr"],
  requiredEnv: [],
} as const;

const newYorkDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function newYorkCalendarDate(date: Date) {
  const parts: Record<string, string> = {};
  for (const part of newYorkDateFormatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function subtractCalendarMonths(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year!, month! - 1, 1));
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day!, lastDay));
  return result.toISOString().slice(0, 10);
}

function boundedPageSize(value: number | undefined) {
  return value !== undefined && Number.isInteger(value)
    ? Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, value))
    : MAX_HISTORY_PAGE_SIZE;
}

function benzingaDisabled(env: ProviderEnvironment) {
  return ["1", "true", "yes", "on"].includes(
    env.BENZINGA_ANALYST_RATINGS_DISABLED?.trim().toLowerCase() || "",
  );
}

function sourceFromHistory(
  providerId: string,
  history: AnalystRatingHistory,
  requestedPageSize: number,
): AnalystMergeSource {
  const ownCoverage = history.coverage?.sources.find((source) => source.providerId === providerId);
  return {
    providerId,
    status: "available",
    history,
    truncated: ownCoverage?.truncated === true || history.items.length >= requestedPageSize,
  };
}

async function historiesFrom(
  providers: readonly Readonly<{ providerId: string; adapter?: ProviderAdapter }>[],
  instrument: Instrument,
  request: AnalystRatingHistoryRequest,
  context: ProviderRequestContext,
) {
  const settled = await Promise.allSettled(providers.map(async ({ providerId, adapter }) => {
    if (!adapter?.analyst?.getRatingHistory) {
      throw new AnalystMergeProviderError("An analyst source does not provide rating history.");
    }
    const history = await adapter.analyst.getRatingHistory(instrument, request, context);
    return sourceFromHistory(providerId, history, boundedPageSize(request.pageSize));
  }));
  if (context.signal?.aborted) {
    throw new AnalystMergeProviderError("Analyst merge request was aborted.");
  }
  const sources = settled.map((result, index): AnalystMergeSource => (
    result.status === "fulfilled"
      ? result.value
      : { providerId: providers[index]!.providerId, status: "unavailable" }
  ));
  if (sources.every((source) => source.status === "unavailable")) {
    throw new AnalystMergeProviderError("All analyst rating sources are unavailable.");
  }
  return Object.freeze(sources);
}

export function createAnalystMergeProvider(
  env: ProviderEnvironment,
  options: AnalystMergeProviderOptions = {},
): ProviderAdapter {
  const now = options.now || (() => new Date());
  let benzinga = options.benzinga;
  if (!benzinga && !benzingaDisabled(env)) {
    // Invalid Benzinga configuration fails closed; only an explicit disable
    // converts the optional source to unavailable coverage.
    benzinga = createBenzingaProvider(env);
  }
  const googleFinance = options.googleFinance || createGoogleFinanceProvider(env);
  const providers = Object.freeze([
    { providerId: "google-finance", adapter: googleFinance },
    { providerId: "benzinga", adapter: benzinga },
  ]);

  const adapter: ProviderAdapter = {
    manifest,
    analyst: {
      getConsensus: async (instrument, context) => {
        const cutoff = context.asOf ? new Date(context.asOf) : now();
        if (!Number.isFinite(cutoff.getTime())) {
          throw new AnalystMergeProviderError("Analyst consensus cutoff is invalid.");
        }
        const dateTo = newYorkCalendarDate(cutoff);
        const dateFrom = subtractCalendarMonths(dateTo, ANALYST_MERGE_LOOKBACK_MONTHS);
        const sources = await historiesFrom(
          providers,
          instrument,
          { dateFrom, dateTo, pageSize: MAX_HISTORY_PAGE_SIZE },
          context,
        );
        const ingestedAtDate = now();
        if (!Number.isFinite(ingestedAtDate.getTime())) {
          throw new AnalystMergeProviderError("Analyst merge clock is invalid.");
        }
        const consensus = mergeAnalystConsensus({
          instrument,
          sources,
          ingestedAt: ingestedAtDate.toISOString(),
        });
        if (!consensus && sources.some((source) => (
          source.status === "unavailable" || source.truncated === true
        ))) {
          throw new AnalystMergeProviderError(
            "Partial analyst coverage could not produce a consensus.",
          );
        }
        return consensus;
      },
      getRatingHistory: async (
        instrument: Instrument,
        request: AnalystRatingHistoryRequest,
        context: ProviderRequestContext,
      ) => {
        const pageSize = boundedPageSize(request.pageSize);
        const sources = await historiesFrom(
          providers,
          instrument,
          { ...request, pageSize },
          context,
        );
        const ingestedAtDate = now();
        if (!Number.isFinite(ingestedAtDate.getTime())) {
          throw new AnalystMergeProviderError("Analyst merge clock is invalid.");
        }
        return mergeAnalystRatingHistories({
          instrument,
          dateFrom: request.dateFrom,
          dateTo: request.dateTo,
          pageSize,
          sources,
          ingestedAt: ingestedAtDate.toISOString(),
        });
      },
    },
  };
  return Object.freeze(adapter);
}

export const analystMergeProviderRegistration = {
  manifest,
  create: (env) => createAnalystMergeProvider(env),
} as const satisfies ProviderRegistration;
