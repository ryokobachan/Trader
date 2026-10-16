import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_SCHEMA_VERSION,
  type AnalystRatingEvent,
  type AnalystRatingHistory,
  type Instrument,
  type ProviderAdapter,
  type ProviderRequestContext,
} from "../src/app/platform/provider-contracts";
import {
  canonicalAnalystFirmId,
  mergeAnalystConsensus,
  mergeAnalystRatingHistories,
} from "../api/google-finance-benzinga/merge";
import {
  AnalystMergeProviderError,
  analystMergeProviderRegistration,
  createAnalystMergeProvider,
} from "../api/google-finance-benzinga/index.server";
import {
  createBenzingaProvider,
} from "../api/benzinga/analyst.server";
import {
  googleFinanceProviderRegistration,
  GoogleFinanceProviderError,
} from "../api/google-finance/analyst.server";
import {
  clearTipRanksProviderCache,
  createTipRanksProvider,
  tipRanksProviderRegistration,
  TipRanksProviderError,
  type TipRanksFetch,
} from "../api/tipranks/analyst.server";
import {
  buildAnalystTargetPoints,
  buildCurrentAnalystTargets,
} from "../src/app/features/stock-detail/StockDetailCharts";

const NOW = new Date("2026-08-16T16:00:00.000Z");
const CONTEXT = {
  requestId: "analyst-merge-test",
  asOf: NOW.toISOString(),
} as const satisfies ProviderRequestContext;

const INSTRUMENT = {
  instrumentId: "us:XNAS:NBIS",
  symbol: "NBIS",
  name: "Nebius Group N.V.",
  assetType: "common_stock",
  active: true,
  listingCountry: "US",
  exchange: "NASDAQ",
  exchangeMic: "XNAS",
  currency: "USD",
  provenance: {
    providerId: "fixture",
    sourceId: "fixture:NBIS",
    asOf: NOW.toISOString(),
    ingestedAt: NOW.toISOString(),
  },
} as const satisfies Instrument;

function event(input: Readonly<{
  providerId: string;
  firm: string;
  date: string;
  target?: number;
  rating?: string;
  analyst?: string;
  time?: string;
  eventId?: string;
}>): AnalystRatingEvent {
  const eventTime = input.time ?? `${input.date}T12:00:00.000Z`;
  return {
    eventId: input.eventId ?? `${input.providerId}:${input.firm}:${eventTime}`,
    instrumentId: INSTRUMENT.instrumentId,
    providerId: input.providerId,
    sourceProviderIds: Object.freeze([input.providerId]),
    symbol: INSTRUMENT.symbol,
    currency: "USD",
    analystFirm: input.firm,
    analystName: input.analyst,
    canonicalFirmId: canonicalAnalystFirmId(input.firm, input.analyst),
    rating: input.rating,
    ratingCurrent: input.rating,
    priceTarget: input.target,
    effectivePriceTarget: input.target,
    sourceEventDate: input.date,
    eventTime,
  };
}

function history(providerId: string, items: readonly AnalystRatingEvent[]): AnalystRatingHistory {
  return {
    instrumentId: INSTRUMENT.instrumentId,
    symbol: INSTRUMENT.symbol,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 1_000,
    items,
    provenance: {
      providerId,
      sourceId: `${providerId}:NBIS`,
      asOf: items[0]?.eventTime ?? NOW.toISOString(),
      ingestedAt: NOW.toISOString(),
    },
  };
}

function analystAdapter(
  providerId: string,
  result: AnalystRatingHistory | Error,
  onHistory?: () => void,
): ProviderAdapter {
  const manifest = {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    id: `fixture-${providerId}`,
    version: "1.0.0",
    displayName: `${providerId} fixture`,
    capabilities: ["analyst.consensus", "analyst.ratings"],
    markets: ["US"],
    assetTypes: ["common_stock", "adr"],
    requiredEnv: [],
  } as const;
  return {
    manifest,
    analyst: {
      getConsensus: () => Promise.resolve(null),
      getRatingHistory: () => {
        onHistory?.();
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result);
      },
    },
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("registers Google Finance, Google Finance+Benzinga, and optional TipRanks providers", () => {
  assert.equal(googleFinanceProviderRegistration.manifest.id, "google-finance");
  assert.deepEqual(googleFinanceProviderRegistration.manifest.requiredEnv, []);
  assert.equal(tipRanksProviderRegistration.manifest.id, "tipranks");
  assert.equal(analystMergeProviderRegistration.manifest.id, "google-finance-benzinga");
  assert.deepEqual(tipRanksProviderRegistration.manifest.requiredEnv, [
    "TIPRANKS_API_KEY",
    "TIPRANKS_API_TOKEN",
  ]);
  assert.deepEqual(analystMergeProviderRegistration.manifest.capabilities, [
    "analyst.consensus",
    "analyst.ratings",
  ]);
});

test("normalizes only explicit cross-provider firm aliases", () => {
  assert.equal(canonicalAnalystFirmId("BofA Securities"), "firm:bank of america");
  assert.equal(canonicalAnalystFirmId("Bank of America"), "firm:bank of america");
  assert.equal(canonicalAnalystFirmId("Robert W. Baird"), "firm:baird");
  assert.equal(canonicalAnalystFirmId("Robert W. Baird & Co."), "firm:baird");
  assert.equal(canonicalAnalystFirmId("Robert W. Baird & Co. LLC"), "firm:baird");
  assert.equal(canonicalAnalystFirmId("Baird"), "firm:baird");
  assert.equal(canonicalAnalystFirmId("D.A. Davidson"), "firm:da davidson");
  assert.notEqual(canonicalAnalystFirmId("Alpha Research"), canonicalAnalystFirmId("Alpha Capital"));
});

test("calls Google Finance and Benzinga and OR-merges source-exclusive targets", async () => {
  let googleCalls = 0;
  let benzingaCalls = 0;
  const googleFinance = history("google-finance", [
    event({
      providerId: "google-finance",
      firm: "Google Only Research",
      analyst: "Google Analyst",
      date: "2026-08-14",
      target: 100,
      rating: "Buy",
    }),
    event({
      providerId: "google-finance",
      firm: "Shared Research",
      analyst: "Shared Analyst",
      date: "2026-08-14",
      target: 200,
      rating: "Hold",
    }),
  ]);
  const benzinga = history("benzinga", [
    event({
      providerId: "benzinga",
      firm: "Benzinga Only Research",
      analyst: "Benzinga Analyst",
      date: "2026-08-14",
      target: 300,
      rating: "Buy",
    }),
    event({
      providerId: "benzinga",
      firm: "Shared Research",
      analyst: "Shared Analyst",
      date: "2026-08-14",
      target: 200,
      rating: "Hold",
    }),
  ]);
  const provider = createAnalystMergeProvider({}, {
    googleFinance: analystAdapter("google-finance", googleFinance, () => {
      googleCalls += 1;
    }),
    benzinga: analystAdapter("benzinga", benzinga, () => {
      benzingaCalls += 1;
    }),
    now: () => new Date(NOW),
  });

  const consensus = await provider.analyst!.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(googleCalls, 1);
  assert.equal(benzingaCalls, 1);
  assert.equal(consensus?.firmCount, 3);
  assert.equal(consensus?.priceTargetCount, 3);
  assert.equal(consensus?.targetConsensus, 200);
  assert.deepEqual(
    consensus?.constituents?.map((item) => item.firmId).sort(),
    [
      "firm:benzinga only research",
      "firm:google only research",
      "firm:shared research",
    ],
  );
  assert.deepEqual(
    consensus?.constituents?.find((item) => item.firmId === "firm:shared research")
      ?.sourceProviderIds,
    ["benzinga", "google-finance"],
  );

  const mergedHistory = await provider.analyst!.getRatingHistory!(INSTRUMENT, {
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
  }, CONTEXT);
  assert.equal(googleCalls, 2);
  assert.equal(benzingaCalls, 2);
  assert.equal(mergedHistory.items.length, 3);
  assert.deepEqual(
    mergedHistory.items.map((item) => item.effectivePriceTarget).sort((left, right) => (
      (left ?? 0) - (right ?? 0)
    )),
    [100, 200, 300],
  );
});

test("recalculates constituent-level consensus by latest firm, not by averaging vendor aggregates", () => {
  const tipRanks = history("tipranks", [
    event({ providerId: "tipranks", firm: "BofA Securities", date: "2026-08-13", target: 310, rating: "Buy" }),
    event({ providerId: "tipranks", firm: "Robert W. Baird", date: "2026-07-21", target: 250, rating: "Buy" }),
    event({ providerId: "tipranks", firm: "Freedom Capital Markets", date: "2026-07-20", rating: "Buy" }),
    event({ providerId: "tipranks", firm: "Morgan Stanley", date: "2026-08-13", target: 144, rating: "Hold" }),
  ]);
  const benzinga = history("benzinga", [
    // Older value is superseded after the BofA alias resolves to one firm.
    event({ providerId: "benzinga", firm: "Bank of America", date: "2026-08-12", target: 300, rating: "Buy" }),
    // Same-day conflict prefers TipRanks deterministically.
    event({ providerId: "benzinga", firm: "Baird", date: "2026-07-21", target: 340, rating: "Buy" }),
    // An older target must not revive after the latest firm event has no target.
    event({ providerId: "benzinga", firm: "Freedom Capital Markets", date: "2026-07-19", target: 260, rating: "Buy" }),
    // Multiple analysts at one firm remain one constituent.
    event({ providerId: "benzinga", firm: "Morgan Stanley", analyst: "A One", date: "2026-08-12", target: 190, rating: "Hold" }),
    event({ providerId: "benzinga", firm: "Morgan Stanley", analyst: "B Two", date: "2026-08-11", target: 200, rating: "Hold" }),
  ]);

  const result = mergeAnalystConsensus({
    instrument: INSTRUMENT,
    sources: [
      { providerId: "tipranks", status: "available", history: tipRanks },
      { providerId: "benzinga", status: "available", history: benzinga },
    ],
    ingestedAt: NOW.toISOString(),
  });

  assert.ok(result);
  assert.equal(result.firmCount, 4);
  assert.equal(result.ratingCount, 4);
  assert.equal(result.priceTargetCount, 3);
  assert.equal(result.analystCount, 3, "legacy analystCount remains the target denominator");
  assert.equal(result.targetLow, 144);
  assert.equal(result.targetHigh, 310);
  assert.equal(result.targetConsensus, (310 + 250 + 144) / 3);
  assert.equal(result.buy, 3);
  assert.equal(result.hold, 1);
  assert.equal(result.coverage?.status, "complete");
  assert.equal(result.methodology, "firm_latest_trailing_3_months");
  assert.equal(result.sources?.length, 2);

  const baird = result.constituents?.find((item) => item.firmId === "firm:baird");
  assert.equal(baird?.priceTarget, 250);
  assert.equal(baird?.providerId, "tipranks");
  assert.deepEqual(baird?.conflictFields, ["priceTarget"]);
  const freedom = result.constituents?.find((item) => item.firmId === "firm:freedom capital markets");
  assert.equal(freedom?.rating, "Buy");
  assert.equal(freedom?.priceTarget, undefined);
});

test("reproduces the NBIS-style separation of ten ratings from nine numeric targets", () => {
  const rows = [
    ["Northland Securities", "Buy", 410],
    ["Morgan Stanley", "Hold", 144],
    ["Bank of America", "Buy", 310],
    ["Citi", "Buy", 324],
    ["Goldman Sachs", "Buy", 286],
    ["D.A. Davidson", "Hold", 175],
    ["Piper Sandler", "Hold", 224],
    ["Robert W. Baird", "Buy", 250],
    ["Freedom Capital Markets", "Buy", undefined],
    ["Exane BNP Paribas", "Hold", 255],
  ] as const;
  const tipRanks = history("tipranks", rows.map(([firm, rating, target], index) => event({
    providerId: "tipranks",
    firm,
    rating,
    target,
    date: `2026-08-${String(15 - index).padStart(2, "0")}`,
  })));
  const result = mergeAnalystConsensus({
    instrument: INSTRUMENT,
    sources: [{ providerId: "tipranks", status: "available", history: tipRanks }],
    ingestedAt: NOW.toISOString(),
  });
  assert.equal(result?.ratingCount, 10);
  assert.equal(result?.priceTargetCount, 9);
  assert.equal(result?.analystCount, 9);
  assert.equal(result?.buy, 6);
  assert.equal(result?.hold, 4);
  assert.equal(result?.targetLow, 144);
  assert.equal(result?.targetHigh, 410);
  assert.equal(result?.targetConsensus, 264.22222222222223);
});

test("is independent of input order for same-day cross-provider conflicts", () => {
  const sources = [
    {
      providerId: "benzinga",
      status: "available" as const,
      history: history("benzinga", [
        event({ providerId: "benzinga", firm: "Baird", date: "2026-08-10", target: 340, rating: "Hold" }),
      ]),
    },
    {
      providerId: "tipranks",
      status: "available" as const,
      history: history("tipranks", [
        event({ providerId: "tipranks", firm: "Robert W. Baird", date: "2026-08-10", target: 250, rating: "Buy" }),
      ]),
    },
  ];
  const first = mergeAnalystConsensus({ instrument: INSTRUMENT, sources, ingestedAt: NOW.toISOString() });
  const second = mergeAnalystConsensus({ instrument: INSTRUMENT, sources: [...sources].reverse(), ingestedAt: NOW.toISOString() });
  assert.deepEqual(first, second);
  assert.deepEqual(first?.constituents?.[0]?.conflictFields, ["rating", "priceTarget"]);
});

test("fills a same-day missing field without reviving a target from an older day", () => {
  const tipRanks = history("tipranks", [
    event({
      providerId: "tipranks",
      firm: "Shared Research",
      analyst: "Shared Analyst",
      date: "2026-08-10",
      time: "2026-08-10T10:00:00.000Z",
      rating: "Buy",
    }),
  ]);
  const benzinga = history("benzinga", [
    event({
      providerId: "benzinga",
      firm: "Shared Research",
      analyst: "Shared Analyst",
      date: "2026-08-10",
      time: "2026-08-10T11:00:00.000Z",
      target: 333,
    }),
  ]);
  const sources = [
    { providerId: "tipranks", status: "available" as const, history: tipRanks },
    { providerId: "benzinga", status: "available" as const, history: benzinga },
  ];
  const consensus = mergeAnalystConsensus({ instrument: INSTRUMENT, sources, ingestedAt: NOW.toISOString() });
  const row = consensus?.constituents?.[0];
  assert.equal(row?.rating, "Buy");
  assert.equal(row?.priceTarget, 333);
  assert.equal(row?.ratingProviderId, "tipranks");
  assert.equal(row?.priceTargetProviderId, "benzinga");
  assert.equal(row?.conflict, undefined);
  assert.equal(consensus?.provenance.asOf, "2026-08-10T11:00:00.000Z");

  const mergedHistory = mergeAnalystRatingHistories({
    instrument: INSTRUMENT,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
    sources,
    ingestedAt: NOW.toISOString(),
  });
  assert.equal(mergedHistory.items[0]?.effectivePriceTarget, 333);
  assert.equal(mergedHistory.items[0]?.ratingProviderId, "tipranks");
  assert.equal(mergedHistory.items[0]?.priceTargetProviderId, "benzinga");
  assert.equal(mergedHistory.provenance.asOf, "2026-08-10T11:00:00.000Z");
});

test("preserves distinct same-source same-day operations in composite history", () => {
  const tipRanks = history("tipranks", [
    event({
      providerId: "tipranks",
      firm: "Same Firm",
      date: "2026-08-10",
      time: "2026-08-10T10:00:00.000Z",
      eventId: "operation-1",
      target: 300,
      rating: "Buy",
    }),
    event({
      providerId: "tipranks",
      firm: "Same Firm",
      date: "2026-08-10",
      time: "2026-08-10T11:00:00.000Z",
      eventId: "operation-2",
      target: 310,
      rating: "Buy",
    }),
  ]);
  const result = mergeAnalystRatingHistories({
    instrument: INSTRUMENT,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
    sources: [{ providerId: "tipranks", status: "available", history: tipRanks }],
    ingestedAt: NOW.toISOString(),
  });
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[0]?.eventId, result.items[1]?.eventId);
});

test("pairs history mirrors only when analyst correspondence is unambiguous", () => {
  const tipRanks = history("tipranks", [
    event({
      providerId: "tipranks",
      firm: "Same Firm",
      analyst: "Rating Analyst",
      date: "2026-08-10",
      time: "2026-08-10T11:00:00.000Z",
      eventId: "rating-operation",
      rating: "Buy",
    }),
    event({
      providerId: "tipranks",
      firm: "Same Firm",
      analyst: "Target Analyst",
      date: "2026-08-10",
      time: "2026-08-10T10:00:00.000Z",
      eventId: "target-operation",
      target: 300,
    }),
  ]);
  const benzinga = history("benzinga", [
    event({
      providerId: "benzinga",
      firm: "Same Firm",
      analyst: "Target Analyst",
      date: "2026-08-10",
      time: "2026-08-10T10:00:00.000Z",
      eventId: "target-mirror",
      target: 300,
    }),
  ]);
  const result = mergeAnalystRatingHistories({
    instrument: INSTRUMENT,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
    sources: [
      { providerId: "tipranks", status: "available", history: tipRanks },
      { providerId: "benzinga", status: "available", history: benzinga },
    ],
    ingestedAt: NOW.toISOString(),
  });
  assert.equal(result.items.length, 2);
  const ratingOperation = result.items.find((item) => item.eventTime.includes("T11:00:00"));
  assert.equal(ratingOperation?.ratingCurrent, "Buy");
  assert.equal(ratingOperation?.effectivePriceTarget, undefined);
  const targetOperation = result.items.find((item) => item.eventTime.includes("T10:00:00"));
  assert.equal(targetOperation?.effectivePriceTarget, 300);
  assert.deepEqual(targetOperation?.sourceProviderIds, ["benzinga", "tipranks"]);
});

test("keeps both source rows when the same analyst has conflicting targets", () => {
  const googleFinance = history("google-finance", [event({
    providerId: "google-finance",
    firm: "Same Firm",
    analyst: "Same Analyst",
    date: "2026-08-10",
    eventId: "google-operation",
    target: 300,
    rating: "Buy",
  })]);
  const benzinga = history("benzinga", [event({
    providerId: "benzinga",
    firm: "Same Firm",
    analyst: "Same Analyst",
    date: "2026-08-10",
    eventId: "benzinga-operation",
    target: 310,
    rating: "Buy",
  })]);
  const result = mergeAnalystRatingHistories({
    instrument: INSTRUMENT,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
    sources: [
      { providerId: "google-finance", status: "available", history: googleFinance },
      { providerId: "benzinga", status: "available", history: benzinga },
    ],
    ingestedAt: NOW.toISOString(),
  });

  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map((item) => item.effectivePriceTarget).sort((left, right) => (
      (left ?? 0) - (right ?? 0)
    )),
    [300, 310],
  );
  assert.deepEqual(
    result.items.map((item) => item.sourceProviderIds?.[0]).sort(),
    ["benzinga", "google-finance"],
  );
});

test("does not deduplicate different analysts only because their values match", () => {
  const result = mergeAnalystRatingHistories({
    instrument: INSTRUMENT,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
    sources: [
      {
        providerId: "google-finance",
        status: "available",
        history: history("google-finance", [event({
          providerId: "google-finance",
          firm: "Same Firm",
          analyst: "Google Analyst",
          date: "2026-08-10",
          target: 300,
          rating: "Buy",
        })]),
      },
      {
        providerId: "benzinga",
        status: "available",
        history: history("benzinga", [event({
          providerId: "benzinga",
          firm: "Same Firm",
          analyst: "Benzinga Analyst",
          date: "2026-08-10",
          target: 300,
          rating: "Buy",
        })]),
      },
    ],
    ingestedAt: NOW.toISOString(),
  });

  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map((item) => item.analystName).sort(),
    ["Benzinga Analyst", "Google Analyst"],
  );
});

test("keeps an unidentified source event in OR-merged history", () => {
  const unidentified = {
    ...event({
      providerId: "benzinga",
      firm: "Temporary identity",
      date: "2026-08-10",
      eventId: "benzinga-unidentified",
      target: 275,
      rating: "Buy",
    }),
    analystFirm: undefined,
    analystName: undefined,
    canonicalFirmId: undefined,
  } as const satisfies AnalystRatingEvent;
  const result = mergeAnalystRatingHistories({
    instrument: INSTRUMENT,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
    sources: [{
      providerId: "benzinga",
      status: "available",
      history: history("benzinga", [unidentified]),
    }],
    ingestedAt: NOW.toISOString(),
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.effectivePriceTarget, 275);
  assert.equal(result.items[0]?.providerId, "benzinga");
  assert.match(result.items[0]?.canonicalFirmId ?? "", /^unidentified:benzinga:/);
  assert.equal(result.consensusItems?.length, 0);
});

test("keeps API consensus and UI target reconstruction aligned for ambiguous same-day rows", () => {
  const sources = [
    {
      providerId: "tipranks",
      status: "available" as const,
      history: history("tipranks", [event({
        providerId: "tipranks",
        firm: "Same Firm",
        analyst: "TipRanks Analyst",
        date: "2026-08-10",
        time: "2026-08-10T10:00:00.000Z",
        eventId: "tipranks-operation",
        target: 300,
      })]),
    },
    {
      providerId: "benzinga",
      status: "available" as const,
      history: history("benzinga", [event({
        providerId: "benzinga",
        firm: "Same Firm",
        analyst: "Benzinga Analyst",
        date: "2026-08-10",
        time: "2026-08-10T12:00:00.000Z",
        eventId: "benzinga-operation",
        target: 330,
      })]),
    },
  ];
  const consensus = mergeAnalystConsensus({
    instrument: INSTRUMENT,
    sources,
    ingestedAt: NOW.toISOString(),
  });
  const mergedHistory = mergeAnalystRatingHistories({
    instrument: INSTRUMENT,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
    sources,
    ingestedAt: NOW.toISOString(),
  });

  assert.equal(consensus?.targetConsensus, 300);
  assert.equal(mergedHistory.items.length, 2);
  assert.deepEqual(
    buildCurrentAnalystTargets(
      mergedHistory.consensusItems ?? mergedHistory.items,
      mergedHistory.dateTo,
      365,
      3,
    )
      .map((item) => item.priceTarget),
    [300],
  );
  assert.equal(
    buildAnalystTargetPoints(
      mergedHistory.consensusItems ?? mergedHistory.items,
      365,
      mergedHistory.dateTo,
      3,
    ).at(-1)?.average,
    300,
  );
});

test("retains secondary-source target operations for lossless UI consensus reconstruction", () => {
  const sources = [
    {
      providerId: "tipranks",
      status: "available" as const,
      history: history("tipranks", [
        event({
          providerId: "tipranks",
          firm: "Same Firm",
          analyst: "Alice",
          date: "2026-08-10",
          time: "2026-08-10T10:00:00.000Z",
          eventId: "tipranks-alice",
          rating: "Buy",
        }),
        event({
          providerId: "tipranks",
          firm: "Same Firm",
          analyst: "Bob",
          date: "2026-08-10",
          time: "2026-08-10T11:00:00.000Z",
          eventId: "tipranks-bob",
          rating: "Buy",
        }),
      ]),
    },
    {
      providerId: "benzinga",
      status: "available" as const,
      history: history("benzinga", [event({
        providerId: "benzinga",
        firm: "Same Firm",
        analyst: "Alice",
        date: "2026-08-10",
        time: "2026-08-10T10:00:00.000Z",
        eventId: "benzinga-alice",
        target: 330,
      })]),
    },
  ];
  const consensus = mergeAnalystConsensus({
    instrument: INSTRUMENT,
    sources,
    ingestedAt: NOW.toISOString(),
  });
  const mergedHistory = mergeAnalystRatingHistories({
    instrument: INSTRUMENT,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
    sources,
    ingestedAt: NOW.toISOString(),
  });
  const calculationItems = mergedHistory.consensusItems ?? mergedHistory.items;

  assert.equal(consensus?.targetConsensus, 330);
  assert.equal(mergedHistory.items.length, 2);
  assert.equal(calculationItems.length, 2);
  assert.deepEqual(
    buildCurrentAnalystTargets(calculationItems, mergedHistory.dateTo, 365, 3)
      .map((item) => item.priceTarget),
    [330],
  );
  assert.equal(
    buildAnalystTargetPoints(calculationItems, 365, mergedHistory.dateTo, 3).at(-1)?.average,
    330,
  );
});

test("composite provider falls back to one source and exposes partial coverage", async () => {
  const benzingaHistory = history("benzinga", [
    event({ providerId: "benzinga", firm: "Needham", date: "2026-08-14", target: 300, rating: "Buy" }),
  ]);
  const provider = createAnalystMergeProvider({}, {
    googleFinance: analystAdapter("google-finance", new Error("google finance unavailable")),
    benzinga: analystAdapter("benzinga", benzingaHistory),
    now: () => new Date(NOW),
  });
  const result = await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(result?.targetConsensus, 300);
  assert.equal(result?.coverage?.status, "partial");
  assert.deepEqual(
    result?.coverage?.sources.map((source) => [source.providerId, source.status]),
    [["benzinga", "available"], ["google-finance", "unavailable"]],
  );
});

test("composite provider fails only when both sources fail", async () => {
  const provider = createAnalystMergeProvider({}, {
    googleFinance: analystAdapter("google-finance", new Error("first secret error")),
    benzinga: analystAdapter("benzinga", new Error("second secret error")),
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof AnalystMergeProviderError);
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
});

test("composite keeps Benzinga data when Google Finance contract validation fails", async () => {
  const provider = createAnalystMergeProvider({}, {
    googleFinance: analystAdapter(
      "google-finance",
      new GoogleFinanceProviderError("invalid_response", "safe schema failure"),
    ),
    benzinga: analystAdapter("benzinga", history("benzinga", [
      event({ providerId: "benzinga", firm: "Needham", date: "2026-08-14", target: 300 }),
    ])),
    now: () => new Date(NOW),
  });
  const result = await provider.analyst!.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(result?.targetConsensus, 300);
  assert.equal(result?.coverage?.status, "partial");
});

test("composite keeps Google Finance data for an invalid Benzinga success envelope", async () => {
  const benzinga = createBenzingaProvider({}, {
    fetch: async () => json({ message: "plan denied" }),
    now: () => new Date(NOW),
  });
  const provider = createAnalystMergeProvider({}, {
    googleFinance: analystAdapter("google-finance", history("google-finance", [
      event({ providerId: "google-finance", firm: "Needham", date: "2026-08-14", target: 305 }),
    ])),
    benzinga,
    now: () => new Date(NOW),
  });
  const result = await provider.analyst!.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(result?.targetConsensus, 305);
  assert.equal(result?.coverage?.status, "partial");
});

test("composite treats anonymous Benzinga access denial as partial coverage", async () => {
  const benzinga = createBenzingaProvider({}, {
    fetch: async () => json({ message: "forbidden" }, 403),
    now: () => new Date(NOW),
  });
  const provider = createAnalystMergeProvider({}, {
    googleFinance: analystAdapter("google-finance", history("google-finance", [
      event({ providerId: "google-finance", firm: "Needham", date: "2026-08-14", target: 305 }),
    ])),
    benzinga,
    now: () => new Date(NOW),
  });
  const result = await provider.analyst!.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(result?.targetConsensus, 305);
  assert.equal(result?.coverage?.status, "partial");
  assert.deepEqual(
    result?.coverage?.sources.map((source) => [source.providerId, source.status]),
    [["benzinga", "unavailable"], ["google-finance", "available"]],
  );
});

test("composite keeps Google Finance data when a configured Benzinga credential is rejected", async () => {
  const env = { BENZINGA_API_TOKEN: "configured-test-token" } as const;
  const benzinga = createBenzingaProvider(env, {
    fetch: async () => json({ message: "forbidden" }, 403),
    now: () => new Date(NOW),
  });
  const provider = createAnalystMergeProvider(env, {
    googleFinance: analystAdapter("google-finance", history("google-finance", [
      event({ providerId: "google-finance", firm: "Needham", date: "2026-08-14", target: 305 }),
    ])),
    benzinga,
    now: () => new Date(NOW),
  });
  const result = await provider.analyst!.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(result?.targetConsensus, 305);
  assert.equal(result?.coverage?.status, "partial");
});

test("composite provider does not hide partial coverage behind a null consensus", async () => {
  const provider = createAnalystMergeProvider({}, {
    googleFinance: analystAdapter("google-finance", new Error("temporary outage")),
    benzinga: analystAdapter("benzinga", history("benzinga", [])),
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    AnalystMergeProviderError,
  );
});

test("composite provider remains available with partial coverage when Benzinga is disabled", async () => {
  const googleFinanceHistory = history("google-finance", [
    event({ providerId: "google-finance", firm: "Needham", date: "2026-08-14", target: 305, rating: "Buy" }),
  ]);
  const provider = createAnalystMergeProvider({
    BENZINGA_ANALYST_RATINGS_DISABLED: "true",
  }, {
    googleFinance: analystAdapter("google-finance", googleFinanceHistory),
    now: () => new Date(NOW),
  });
  const result = await provider.analyst?.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(result?.targetConsensus, 305);
  assert.equal(result?.coverage?.status, "partial");
  assert.deepEqual(
    result?.coverage?.sources.map((source) => [source.providerId, source.status]),
    [["benzinga", "unavailable"], ["google-finance", "available"]],
  );
});

test("marks the merged history partial when the post-union page limit truncates output", () => {
  const sourceRows = (providerId: string, count: number, offset: number) => Array.from(
    { length: count },
    (_, index) => event({
      providerId,
      firm: `${providerId} Firm ${index + offset}`,
      date: `2026-08-${String(15 - index % 10).padStart(2, "0")}`,
      time: `2026-08-${String(15 - index % 10).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      target: 100 + index + offset,
      rating: "Buy",
    }),
  );
  const result = mergeAnalystRatingHistories({
    instrument: INSTRUMENT,
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
    sources: [
      { providerId: "tipranks", status: "available", history: history("tipranks", sourceRows("tipranks", 60, 0)) },
      { providerId: "benzinga", status: "available", history: history("benzinga", sourceRows("benzinga", 60, 100)) },
    ],
    ingestedAt: NOW.toISOString(),
  });
  assert.equal(result.items.length, 100);
  assert.equal(result.consensusLookbackMonths, 3);
  assert.equal(result.coverage?.status, "partial");
  assert.equal(result.coverage?.truncated, true);
  assert.equal(result.coverage?.lookbackMonths, undefined);
});

test("TipRanks Enterprise provider sends header credentials and normalizes official rating fields", async () => {
  clearTipRanksProviderCache();
  const apiKey = "tipranks-key-secret";
  const apiToken = "tipranks-token-secret";
  let capturedUrl: URL | undefined;
  let capturedHeaders: Headers | undefined;
  let calls = 0;
  const fetch: TipRanksFetch = async (input, init) => {
    calls += 1;
    capturedUrl = new URL(input instanceof Request ? input.url : String(input));
    capturedHeaders = new Headers(init?.headers);
    return json({
      data: [
        {
          ticker: "NBIS",
          expertUID: "expert-1",
          analystName: "Alex Analyst",
          firmName: "BofA Securities",
          recommendation: "Buy",
          recommendationDate: "08/13/2026",
          timestamp: Date.parse("2026-08-13T14:30:00.000Z") / 1_000,
          AnalystAction: "Reiterated",
          priceTarget: 310,
          priceTargetCurrencyCode: "USD",
          numOfStars: 4.5,
          successRate: 67.2,
        },
        {
          ticker: "NBIS",
          analystName: "Euro Analyst",
          firmName: "Example Europe",
          recommendation: "Hold",
          recommendationDate: "08/12/2026",
          priceTarget: 280,
          priceTargetCurrencyCode: "EUR",
          convertedPriceTarget: 325,
          convertedPriceTargetCurrencyCode: "USD",
        },
      ],
    });
  };
  const provider = createTipRanksProvider({
    TIPRANKS_API_KEY: apiKey,
    TIPRANKS_API_TOKEN: apiToken,
  }, {
    fetch,
    now: () => new Date(NOW),
  });

  const request = { dateFrom: "2026-05-16", dateTo: "2026-08-16", pageSize: 100 } as const;
  const first = await provider.analyst?.getRatingHistory?.(INSTRUMENT, request, CONTEXT);
  const second = await provider.analyst?.getRatingHistory?.(INSTRUMENT, request, CONTEXT);

  assert.equal(calls, 1, "the daily upstream is protected by an in-process TTL cache");
  assert.ok(capturedUrl);
  assert.ok(capturedHeaders);
  assert.equal(capturedUrl.origin + capturedUrl.pathname, "https://api.tipranks.com/api/analysts/NBIS");
  assert.equal(capturedUrl.searchParams.get("num"), "100");
  assert.equal(capturedUrl.searchParams.get("sort"), "date");
  assert.equal(capturedUrl.searchParams.get("months"), "3");
  assert.equal(capturedUrl.searchParams.get("includeUnranked"), "true");
  assert.equal(capturedHeaders.get("X-APIKEY"), apiKey);
  assert.equal(capturedHeaders.get("X-APITOKEN"), apiToken);
  assert.equal(capturedUrl.toString().includes(apiKey), false);
  assert.equal(first?.items.length, 2);
  assert.equal(first?.items[0]?.canonicalFirmId, "firm:bank of america");
  assert.equal(first?.items[0]?.effectivePriceTarget, 310);
  assert.equal(first?.items[0]?.analystStarRating, 4.5);
  assert.equal(first?.items[1]?.effectivePriceTarget, 325);
  assert.equal(first?.items[1]?.currency, "USD");
  assert.equal(first?.provenance.sourceUrl, "https://www.tipranks.com/stocks/nbis/forecast");
  assert.deepEqual(second, first);
});

test("TipRanks errors never expose credential values or response bodies", async () => {
  clearTipRanksProviderCache();
  const secretKey = "forbidden-key-value";
  const secretToken = "forbidden-token-value";
  const provider = createTipRanksProvider({
    TIPRANKS_API_KEY: secretKey,
    TIPRANKS_API_TOKEN: secretToken,
  }, {
    fetch: async () => json({ private: `${secretKey}:${secretToken}` }, 401),
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof TipRanksProviderError);
      assert.equal(error.code, "upstream");
      assert.equal(error.status, 401);
      assert.equal(error.message.includes(secretKey), false);
      assert.equal(error.message.includes(secretToken), false);
      return true;
    },
  );
});

test("TipRanks rejects unknown success envelopes instead of treating them as empty coverage", async () => {
  clearTipRanksProviderCache();
  const provider = createTipRanksProvider({
    TIPRANKS_API_KEY: "shape-key",
    TIPRANKS_API_TOKEN: "shape-token",
  }, {
    fetch: async () => json({ error: { details: [] }, meta: { tags: [] } }),
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof TipRanksProviderError);
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );
});

test("TipRanks does not cache an invalid envelope and accepts a recovered retry", async () => {
  clearTipRanksProviderCache();
  let calls = 0;
  const provider = createTipRanksProvider({
    TIPRANKS_API_KEY: "retry-key",
    TIPRANKS_API_TOKEN: "retry-token",
  }, {
    fetch: async () => {
      calls += 1;
      if (calls === 1) return json({ data: [{ error: "plan denied" }] });
      return json({ data: [{
        ticker: "NBIS",
        analystName: "Recovered Analyst",
        firmName: "Recovered Firm",
        recommendation: "Buy",
        recommendationDate: "08/14/2026",
        priceTarget: 301,
      }] });
    },
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    TipRanksProviderError,
  );
  const recovered = await provider.analyst!.getConsensus(INSTRUMENT, CONTEXT);
  assert.equal(calls, 2);
  assert.equal(recovered?.targetConsensus, 301);
});

test("TipRanks applies redirect and timeout policy through response body parsing", async () => {
  clearTipRanksProviderCache();
  let redirect: RequestRedirect | undefined;
  const provider = createTipRanksProvider({
    TIPRANKS_API_KEY: "body-key",
    TIPRANKS_API_TOKEN: "body-token",
  }, {
    fetch: async (_input, init) => {
      redirect = init?.redirect;
      return {
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => {}),
      } as Response;
    },
    timeoutMs: 5,
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.analyst!.getConsensus(INSTRUMENT, CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof TipRanksProviderError);
      assert.equal(error.code, "timeout");
      return true;
    },
  );
  assert.equal(redirect, "error");
});

test("TipRanks cache partitions by credential account and requested date range", async () => {
  clearTipRanksProviderCache();
  let firstCalls = 0;
  let secondCalls = 0;
  const response = (firmName: string) => json({ data: [{
    ticker: "NBIS",
    analystName: `${firmName} Analyst`,
    firmName,
    recommendation: "Buy",
    recommendationDate: "08/14/2026",
    priceTarget: 300,
    priceTargetCurrencyCode: "USD",
  }] });
  const first = createTipRanksProvider({
    TIPRANKS_API_KEY: "account-a-key",
    TIPRANKS_API_TOKEN: "account-a-token",
  }, {
    fetch: async () => {
      firstCalls += 1;
      return response("Account A");
    },
    now: () => new Date(NOW),
  });
  const second = createTipRanksProvider({
    TIPRANKS_API_KEY: "account-b-key",
    TIPRANKS_API_TOKEN: "account-b-token",
  }, {
    fetch: async () => {
      secondCalls += 1;
      return response("Account B");
    },
    now: () => new Date(NOW),
  });
  const firstRange = { dateFrom: "2026-05-16", dateTo: "2026-08-16", pageSize: 100 } as const;
  const adjacentRange = { ...firstRange, dateTo: "2026-08-15" } as const;
  const [firstHistory, secondHistory] = await Promise.all([
    first.analyst!.getRatingHistory!(INSTRUMENT, firstRange, CONTEXT),
    second.analyst!.getRatingHistory!(INSTRUMENT, firstRange, CONTEXT),
  ]);
  await first.analyst!.getRatingHistory!(INSTRUMENT, adjacentRange, CONTEXT);
  assert.equal(firstCalls, 2, "different requested ranges do not share cached payloads");
  assert.equal(secondCalls, 1, "different licensed accounts do not share cached payloads");
  assert.equal(firstHistory.items[0]?.analystFirm, "Account A");
  assert.equal(secondHistory.items[0]?.analystFirm, "Account B");
});

test("TipRanks requests enough trailing months to answer a historical as-of consensus", async () => {
  clearTipRanksProviderCache();
  let capturedMonths: string | null = null;
  const provider = createTipRanksProvider({
    TIPRANKS_API_KEY: "historical-key",
    TIPRANKS_API_TOKEN: "historical-token",
  }, {
    fetch: async (input) => {
      capturedMonths = new URL(input instanceof Request ? input.url : String(input))
        .searchParams.get("months");
      return json({ data: [{
        ticker: "NBIS",
        analystName: "Historical Analyst",
        firmName: "Historical Firm",
        recommendation: "Buy",
        recommendationDate: "03/01/2025",
        priceTarget: 180,
        priceTargetCurrencyCode: "USD",
      }] });
    },
    now: () => new Date(NOW),
  });
  const result = await provider.analyst!.getConsensus(INSTRUMENT, {
    requestId: "historical-consensus",
    asOf: "2025-04-01T12:00:00.000Z",
  });
  assert.equal(capturedMonths, "20");
  assert.equal(result?.targetConsensus, 180);
});

test("standalone TipRanks consensus uses the New York calendar date at the UTC boundary", async () => {
  clearTipRanksProviderCache();
  const provider = createTipRanksProvider({
    TIPRANKS_API_KEY: "calendar-key",
    TIPRANKS_API_TOKEN: "calendar-token",
  }, {
    fetch: async () => json({ data: [{
      ticker: "NBIS",
      analystName: "Calendar Analyst",
      firmName: "Calendar Firm",
      recommendation: "Buy",
      recommendationDate: "08/16/2026",
      priceTarget: 302,
    }] }),
    now: () => new Date("2026-08-17T02:00:00.000Z"),
  });
  const result = await provider.analyst!.getConsensus(INSTRUMENT, {
    requestId: "new-york-calendar",
  });
  assert.equal(result?.targetConsensus, 302);
  assert.equal(
    result?.sources?.[0]?.sourceId,
    "tipranks:analyst-ratings:NBIS:2026-05-16:2026-08-16",
  );
});

test("TipRanks fallback event IDs distinguish same-day operations and map recommendation count", async () => {
  clearTipRanksProviderCache();
  const provider = createTipRanksProvider({
    TIPRANKS_API_KEY: "event-key",
    TIPRANKS_API_TOKEN: "event-token",
  }, {
    fetch: async () => json({ data: [
      {
        ticker: "NBIS",
        analystName: "Same Analyst",
        firmName: "Same Firm",
        recommendation: "Buy",
        recommendationDate: "08/14/2026",
        timestamp: Date.parse("2026-08-14T10:00:00.000Z") / 1_000,
        AnalystAction: "Maintained",
        priceTarget: 300,
        totalRecommendations: 42,
      },
      {
        ticker: "NBIS",
        analystName: "Same Analyst",
        firmName: "Same Firm",
        recommendation: "Buy",
        recommendationDate: "08/14/2026",
        timestamp: Date.parse("2026-08-14T11:00:00.000Z") / 1_000,
        AnalystAction: "Reiterated",
        priceTarget: 300,
        totalRecommendations: 42,
      },
    ] }),
    now: () => new Date(NOW),
  });
  const result = await provider.analyst!.getRatingHistory!(INSTRUMENT, {
    dateFrom: "2026-05-16",
    dateTo: "2026-08-16",
    pageSize: 100,
  }, CONTEXT);
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[0]?.eventId, result.items[1]?.eventId);
  assert.equal(result.items[0]?.totalRatings, 42);
});
