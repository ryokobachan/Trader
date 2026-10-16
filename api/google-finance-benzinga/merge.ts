import type {
  AnalystConsensus,
  AnalystConsensusConstituent,
  AnalystMergeCoverage,
  AnalystRatingBucket,
  AnalystRatingEvent,
  AnalystRatingHistory,
  AnalystSourceCoverage,
  DataProvenance,
  Instrument,
} from "@/app/platform/provider-contracts";

export const ANALYST_MERGE_PROVIDER_ID = "google-finance-benzinga";
export const ANALYST_MERGE_LOOKBACK_MONTHS = 3;

export type AnalystMergeSource = Readonly<{
  providerId: string;
  status: "available" | "unavailable";
  history?: AnalystRatingHistory;
  truncated?: boolean;
}>;

type SourceEvent = Readonly<{
  providerId: string;
  event: AnalystRatingEvent;
  firmId: string;
  firm: string;
  consensusEligible: boolean;
  ratingBucket?: AnalystRatingBucket;
  target?: number;
}>;

type MergedFirmEvent = Readonly<{
  firmId: string;
  firm: string;
  primary: SourceEvent;
  ratingSource?: SourceEvent;
  targetSource?: SourceEvent;
  sameDate: readonly SourceEvent[];
  allProviderIds: readonly string[];
  rating?: string;
  ratingBucket?: AnalystRatingBucket;
  ratingProviderId?: string;
  target?: number;
  priceTargetProviderId?: string;
  conflictFields: readonly ("rating" | "priceTarget")[];
}>;

const PROVIDER_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  "google-finance": 2,
  tipranks: 2,
  benzinga: 1,
});

const FIRM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "b of a": "bank of america",
  "b of a securities": "bank of america",
  "bofa": "bank of america",
  "bofa securities": "bank of america",
  "bank of america securities": "bank of america",
  "citigroup": "citi",
  "citigroup global markets": "citi",
  "robert w baird": "baird",
  "baird": "baird",
  "exane bnp paribas": "bnp paribas exane",
  "bnp paribas exane": "bnp paribas exane",
  "d a davidson": "da davidson",
  "da davidson": "da davidson",
  "goldman sachs and co": "goldman sachs",
  "northland": "northland",
  "northland securities": "northland",
});

function normalizedWords(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cross-vendor firm key. Keep aliases explicit so unrelated firms cannot collapse silently. */
export function canonicalAnalystFirmId(
  analystFirm: string | undefined,
  analystName?: string,
): string | undefined {
  const rawFirm = analystFirm?.trim();
  if (rawFirm) {
    const normalized = normalizedWords(rawFirm)
      .replace(/(?:\s+(?:(?:and\s+)?co|company|llc|llp|lp|inc|incorporated|ltd|limited|plc))+$/g, "")
      .trim();
    if (!normalized) return undefined;
    const aliased = FIRM_ALIASES[normalized] ?? normalized;
    return `firm:${aliased}`;
  }
  const normalizedAnalyst = analystName ? normalizedWords(analystName) : "";
  return normalizedAnalyst ? `analyst:${normalizedAnalyst}` : undefined;
}

function normalizedRating(value: string | undefined) {
  return value
    ?.normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[-‐‑‒–—−_/]+/g, " ")
    .replace(/\s+/g, " ");
}

export function analystRatingBucket(value: string | undefined): AnalystRatingBucket | undefined {
  const rating = normalizedRating(value);
  if (!rating) return undefined;
  const aliases: Readonly<Record<string, AnalystRatingBucket>> = {
    "strong buy": "strongBuy",
    buy: "buy",
    outperform: "buy",
    overweight: "buy",
    "market outperform": "buy",
    "sector outperform": "buy",
    positive: "buy",
    accumulate: "buy",
    hold: "hold",
    neutral: "hold",
    "equal weight": "hold",
    "market perform": "hold",
    "sector perform": "hold",
    "sector weight": "hold",
    "in line": "hold",
    "peer perform": "hold",
    sell: "sell",
    underperform: "sell",
    underweight: "sell",
    "market underperform": "sell",
    "sector underperform": "sell",
    negative: "sell",
    reduce: "sell",
    "strong sell": "strongSell",
  };
  return aliases[rating];
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function eventTarget(event: AnalystRatingEvent) {
  const currency = event.currency?.toUpperCase();
  if (currency && currency !== "USD") return undefined;
  return positiveNumber(event.effectivePriceTarget)
    ?? positiveNumber(event.adjustedPriceTarget)
    ?? positiveNumber(event.priceTarget);
}

function eventRating(event: AnalystRatingEvent) {
  return event.ratingCurrent?.trim() || event.rating?.trim() || undefined;
}

function providerFor(event: AnalystRatingEvent, fallback: string) {
  return event.providerId?.trim() || fallback;
}

function sourceEvent(
  event: AnalystRatingEvent,
  fallbackProviderId: string,
): SourceEvent | undefined {
  const firmId = event.canonicalFirmId
    || canonicalAnalystFirmId(event.analystFirm, event.analystName);
  if (!firmId) return undefined;
  const firm = event.analystFirm?.trim() || event.analystName?.trim();
  if (!firm) return undefined;
  const rating = eventRating(event);
  return {
    providerId: providerFor(event, fallbackProviderId),
    event,
    firmId,
    firm,
    consensusEligible: true,
    ratingBucket: analystRatingBucket(rating),
    target: eventTarget(event),
  };
}

function sourceHistoryEvent(
  event: AnalystRatingEvent,
  fallbackProviderId: string,
): SourceEvent {
  const identified = sourceEvent(event, fallbackProviderId);
  if (identified) return identified;
  const providerId = providerFor(event, fallbackProviderId);
  return {
    providerId,
    event,
    firmId: `unidentified:${providerId}:${event.eventId}`,
    firm: "Unknown analyst",
    consensusEligible: false,
    ratingBucket: analystRatingBucket(eventRating(event)),
    target: eventTarget(event),
  };
}

function compareWithinSource(left: SourceEvent, right: SourceEvent) {
  return left.event.sourceEventDate.localeCompare(right.event.sourceEventDate)
    || left.event.eventTime.localeCompare(right.event.eventTime)
    || (left.event.updatedAt ?? "").localeCompare(right.event.updatedAt ?? "")
    || left.event.eventId.localeCompare(right.event.eventId);
}

function compareSameDateCandidates(left: SourceEvent, right: SourceEvent) {
  return (PROVIDER_PRIORITY[left.providerId] ?? 0) - (PROVIDER_PRIORITY[right.providerId] ?? 0)
    || left.event.eventTime.localeCompare(right.event.eventTime)
    || left.event.eventId.localeCompare(right.event.eventId);
}

function latestBySourceAndFirm(events: readonly SourceEvent[]) {
  const latest = new Map<string, SourceEvent>();
  for (const event of events) {
    const key = `${event.providerId}\u0000${event.firmId}`;
    const current = latest.get(key);
    if (!current || compareWithinSource(event, current) > 0) latest.set(key, event);
  }
  return [...latest.values()];
}

function uniqueSorted(values: readonly string[]) {
  return Object.freeze([...new Set(values)].sort());
}

function mergedFirmEvent(events: readonly SourceEvent[]): MergedFirmEvent {
  const latestDate = events.reduce(
    (latest, item) => item.event.sourceEventDate > latest ? item.event.sourceEventDate : latest,
    "",
  );
  const sameDate = events
    .filter((item) => item.event.sourceEventDate === latestDate)
    .sort(compareSameDateCandidates)
    .reverse();
  const primary = sameDate[0]!;
  const ratingSource = sameDate.find((item) => eventRating(item.event) !== undefined);
  const targetSource = sameDate.find((item) => item.target !== undefined);
  const ratingBuckets = new Set(sameDate.flatMap((item) => {
    const rating = eventRating(item.event);
    if (!rating) return [];
    return [item.ratingBucket ? `bucket:${item.ratingBucket}` : `raw:${normalizedRating(rating)}`];
  }));
  const targets = new Set(sameDate.flatMap((item) => item.target === undefined ? [] : [item.target]));
  const conflictFields: ("rating" | "priceTarget")[] = [];
  if (ratingBuckets.size > 1) conflictFields.push("rating");
  if (targets.size > 1) conflictFields.push("priceTarget");
  return {
    firmId: primary.firmId,
    firm: primary.firm,
    primary,
    ratingSource,
    targetSource,
    sameDate: Object.freeze(sameDate),
    allProviderIds: uniqueSorted(events.map((item) => item.providerId)),
    rating: ratingSource ? eventRating(ratingSource.event) : undefined,
    ratingBucket: ratingSource?.ratingBucket,
    ratingProviderId: ratingSource?.providerId,
    target: targetSource?.target,
    priceTargetProviderId: targetSource?.providerId,
    conflictFields: Object.freeze(conflictFields),
  };
}

function mergeLatestFirmEvents(events: readonly SourceEvent[]) {
  const byFirm = new Map<string, SourceEvent[]>();
  for (const event of latestBySourceAndFirm(events)) {
    const current = byFirm.get(event.firmId) ?? [];
    current.push(event);
    byFirm.set(event.firmId, current);
  }
  return [...byFirm.values()]
    .map(mergedFirmEvent)
    .sort((left, right) => (
      right.primary.event.sourceEventDate.localeCompare(left.primary.event.sourceEventDate)
      || left.firm.localeCompare(right.firm)
    ));
}

function sourceCoverage(source: AnalystMergeSource): AnalystSourceCoverage {
  if (source.status === "unavailable" || !source.history) {
    return {
      providerId: source.providerId,
      status: "unavailable",
      eventCount: 0,
      firmCount: 0,
      ratingCount: 0,
      priceTargetCount: 0,
    };
  }
  const events = source.history.items
    .map((event) => sourceEvent(event, source.providerId))
    .filter((event): event is SourceEvent => event !== undefined);
  const latest = latestBySourceAndFirm(events);
  return {
    providerId: source.providerId,
    status: "available",
    eventCount: source.history.items.length,
    firmCount: new Set(latest.map((event) => event.firmId)).size,
    ratingCount: latest.filter((event) => eventRating(event.event) !== undefined).length,
    priceTargetCount: latest.filter((event) => event.target !== undefined).length,
    asOf: source.history.provenance.asOf,
    dateFrom: source.history.dateFrom,
    dateTo: source.history.dateTo,
    ...(source.truncated ? { truncated: true } : {}),
  };
}

function mergeCoverage(
  sources: readonly AnalystMergeSource[],
  lookbackMonths?: number,
  outputTruncated = false,
): AnalystMergeCoverage {
  const coverageSources = sources.map(sourceCoverage)
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
  return {
    status: !outputTruncated
      && coverageSources.every((source) => source.status === "available" && !source.truncated)
      ? "complete"
      : "partial",
    ...(outputTruncated ? { truncated: true } : {}),
    ...(lookbackMonths === undefined ? {} : { lookbackMonths }),
    sources: Object.freeze(coverageSources),
  };
}

function successfulProvenance(sources: readonly AnalystMergeSource[]) {
  return Object.freeze(
    sources.flatMap((source) => source.history ? [source.history.provenance] : [])
      .sort((left, right) => (
        left.providerId.localeCompare(right.providerId)
        || left.sourceId.localeCompare(right.sourceId)
      )),
  );
}

function latestInstant(values: readonly (string | undefined)[], fallback: string) {
  return values
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort()
    .at(-1) ?? fallback;
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function constituent(event: MergedFirmEvent): AnalystConsensusConstituent {
  return {
    firmId: event.firmId,
    firm: event.firm,
    analystName: event.primary.event.analystName,
    rating: event.rating,
    ratingBucket: event.ratingBucket,
    priceTarget: event.target,
    sourceEventDate: event.primary.event.sourceEventDate,
    eventTime: event.primary.event.eventTime,
    providerId: event.primary.providerId,
    ratingProviderId: event.ratingProviderId,
    priceTargetProviderId: event.priceTargetProviderId,
    sourceProviderIds: event.allProviderIds,
    ...(event.conflictFields.length > 0
      ? { conflict: true, conflictFields: event.conflictFields }
      : {}),
  };
}

export function mergeAnalystConsensus(input: Readonly<{
  instrument: Instrument;
  sources: readonly AnalystMergeSource[];
  ingestedAt: string;
  providerId?: string;
}>): AnalystConsensus | null {
  const available = input.sources.filter((source) => source.status === "available" && source.history);
  const events = available.flatMap((source) => source.history!.items
    .map((event) => sourceEvent(event, source.providerId))
    .filter((event): event is SourceEvent => event !== undefined));
  const merged = mergeLatestFirmEvents(events);
  if (merged.length === 0) return null;

  const targets = merged.flatMap((event) => event.target === undefined ? [] : [event.target]);
  const counts: Record<AnalystRatingBucket, number> = {
    strongBuy: 0,
    buy: 0,
    hold: 0,
    sell: 0,
    strongSell: 0,
  };
  for (const event of merged) {
    if (event.ratingBucket) counts[event.ratingBucket] += 1;
  }
  const ratingCount = merged.filter((event) => event.rating !== undefined).length;
  const sources = successfulProvenance(input.sources);
  const asOf = latestInstant(
    merged.flatMap((event) => event.sameDate.map((item) => item.event.eventTime)),
    input.ingestedAt,
  );
  const providerId = input.providerId ?? ANALYST_MERGE_PROVIDER_ID;
  const provenance: DataProvenance = {
    providerId,
    sourceId: `${providerId}:analyst-consensus:${input.instrument.symbol}:firm-latest-3m`,
    asOf,
    ingestedAt: input.ingestedAt,
  };
  return {
    instrumentId: input.instrument.instrumentId,
    ...(targets.length > 0 ? {
      targetLow: Math.min(...targets),
      targetHigh: Math.max(...targets),
      targetConsensus: targets.reduce((sum, target) => sum + target, 0) / targets.length,
      targetMedian: median(targets),
    } : {}),
    ...counts,
    analystCount: targets.length,
    firmCount: merged.length,
    ratingCount,
    priceTargetCount: targets.length,
    methodology: "firm_latest_trailing_3_months",
    coverage: mergeCoverage(input.sources, ANALYST_MERGE_LOOKBACK_MONTHS),
    sources,
    constituents: Object.freeze(merged.map(constituent)),
    provenance,
  };
}

function historyEvent(event: MergedFirmEvent, instrumentId: string): AnalystRatingEvent {
  const primary = event.primary.event;
  const ratingSource = event.ratingSource?.event;
  const targetSource = event.targetSource?.event;
  return {
    ...primary,
    eventId: [
      ANALYST_MERGE_PROVIDER_ID,
      event.firmId,
      primary.sourceEventDate,
      event.primary.providerId,
      encodeURIComponent(primary.eventId),
    ].join(":"),
    instrumentId,
    providerId: event.primary.providerId,
    ratingProviderId: event.ratingProviderId,
    priceTargetProviderId: event.priceTargetProviderId,
    sourceProviderIds: event.allProviderIds,
    sourceConflict: event.conflictFields.length > 0 || undefined,
    canonicalFirmId: event.firmId,
    analystFirm: event.firm,
    rating: event.rating,
    ratingCurrent: event.rating,
    ratingPrior: ratingSource?.ratingPrior,
    priceTarget: targetSource?.priceTarget,
    previousPriceTarget: targetSource?.previousPriceTarget,
    adjustedPriceTarget: targetSource?.adjustedPriceTarget,
    adjustedPreviousPriceTarget: targetSource?.adjustedPreviousPriceTarget,
    effectivePriceTarget: event.target,
    action: primary.action,
    actionCompany: ratingSource?.actionCompany,
    actionPriceTarget: targetSource?.actionPriceTarget,
    currency: event.target === undefined ? primary.currency : "USD",
  };
}

function consensusHistoryEvent(
  source: SourceEvent,
  instrumentId: string,
): AnalystRatingEvent {
  const rating = eventRating(source.event);
  return {
    ...source.event,
    eventId: [
      ANALYST_MERGE_PROVIDER_ID,
      "consensus-source",
      source.providerId,
      encodeURIComponent(source.event.eventId),
    ].join(":"),
    instrumentId,
    providerId: source.providerId,
    ratingProviderId: rating === undefined ? undefined : source.providerId,
    priceTargetProviderId: source.target === undefined ? undefined : source.providerId,
    sourceProviderIds: Object.freeze([source.providerId]),
    canonicalFirmId: source.firmId,
    analystFirm: source.firm,
    rating,
    ratingCurrent: rating,
    effectivePriceTarget: source.target,
  };
}

function latestConsensusSourceEvents(events: readonly SourceEvent[]) {
  const latest = new Map<string, SourceEvent>();
  for (const event of events) {
    const key = [
      event.providerId,
      event.firmId,
      event.event.sourceEventDate,
    ].join("\u0000");
    const current = latest.get(key);
    if (!current || compareWithinSource(event, current) > 0) latest.set(key, event);
  }
  return [...latest.values()].sort((left, right) => (
    compareWithinSource(right, left)
    || left.firm.localeCompare(right.firm)
    || left.providerId.localeCompare(right.providerId)
  ));
}

function mergedHistoryEvents(events: readonly SourceEvent[]) {
  const merged: MergedFirmEvent[] = [];
  const used = new Set<SourceEvent>();
  const byAnalyst = new Map<string, SourceEvent[]>();
  for (const event of events) {
    const analyst = event.event.analystName
      ? normalizedWords(event.event.analystName)
      : "";
    if (!analyst) continue;
    const rows = byAnalyst.get(analyst) ?? [];
    rows.push(event);
    byAnalyst.set(analyst, rows);
  }

  const mergeUnambiguous = (candidates: readonly SourceEvent[]) => {
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      counts.set(candidate.providerId, (counts.get(candidate.providerId) ?? 0) + 1);
    }
    if (counts.size < 2 || [...counts.values()].some((count) => count !== 1)) return;
    const ratings = new Set(candidates.flatMap((candidate) => {
      const rating = normalizedRating(eventRating(candidate.event));
      return rating ? [rating] : [];
    }));
    const targets = new Set(candidates.flatMap((candidate) => (
      candidate.target === undefined ? [] : [candidate.target]
    )));
    const actions = new Set(candidates.flatMap((candidate) => {
      const action = normalizedWords(candidate.event.action ?? "");
      return action ? [action] : [];
    }));
    // Only collapse a cross-provider mirror when every overlapping field
    // agrees. A conflict is two source records in the OR-union, not one row
    // with a silently discarded value.
    if (ratings.size > 1 || targets.size > 1 || actions.size > 1) return;
    merged.push(mergedFirmEvent(candidates));
    candidates.forEach((candidate) => used.add(candidate));
  };

  for (const analyst of [...byAnalyst.keys()].sort()) {
    mergeUnambiguous(byAnalyst.get(analyst)!);
  }
  for (const event of events) {
    if (!used.has(event)) merged.push(mergedFirmEvent([event]));
  }
  return merged;
}

/**
 * Union both event streams while collapsing same-firm/same-day mirrors. Different
 * dates remain visible so callers can still build a target-change timeline.
 */
export function mergeAnalystRatingHistories(input: Readonly<{
  instrument: Instrument;
  dateFrom: string;
  dateTo: string;
  pageSize: number;
  sources: readonly AnalystMergeSource[];
  ingestedAt: string;
}>): AnalystRatingHistory {
  const events = input.sources.flatMap((source) => source.history?.items
    .map((event) => sourceHistoryEvent(event, source.providerId)) ?? []);
  const byFirmDate = new Map<string, SourceEvent[]>();
  for (const event of events) {
    const key = `${event.firmId}\u0000${event.event.sourceEventDate}`;
    const current = byFirmDate.get(key) ?? [];
    current.push(event);
    byFirmDate.set(key, current);
  }
  const allMerged = [...byFirmDate.values()]
    .flatMap(mergedHistoryEvents)
    .sort((left, right) => (
      right.primary.event.eventTime.localeCompare(left.primary.event.eventTime)
      || left.firm.localeCompare(right.firm)
    ));
  const outputTruncated = allMerged.length > input.pageSize;
  const merged = allMerged.slice(0, input.pageSize);
  const consensusItems = latestConsensusSourceEvents(
    events.filter((event) => event.consensusEligible),
  )
    .map((event) => consensusHistoryEvent(event, input.instrument.instrumentId));
  const sources = successfulProvenance(input.sources);
  const asOf = latestInstant(
    merged.flatMap((event) => event.sameDate.map((item) => item.event.eventTime)),
    `${input.dateTo}T23:59:59.999Z`,
  );
  return {
    instrumentId: input.instrument.instrumentId,
    symbol: input.instrument.symbol,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    pageSize: input.pageSize,
    items: Object.freeze(merged.map((event) => historyEvent(event, input.instrument.instrumentId))),
    consensusItems: Object.freeze(consensusItems),
    consensusLookbackMonths: ANALYST_MERGE_LOOKBACK_MONTHS,
    coverage: mergeCoverage(
      input.sources,
      undefined,
      outputTruncated,
    ),
    sources,
    provenance: {
      providerId: ANALYST_MERGE_PROVIDER_ID,
      sourceId: `${ANALYST_MERGE_PROVIDER_ID}:analyst-ratings:${input.instrument.symbol}:${input.dateFrom}:${input.dateTo}`,
      asOf,
      ingestedAt: input.ingestedAt,
    },
  };
}
