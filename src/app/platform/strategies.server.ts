import type { Locale } from "./i18n";
import {
  RETIRED_SAMPLE_STRATEGY_IDS,
  STRATEGY_PACKAGE_DEFINITIONS,
  strategyPackagesForLocale,
} from "../features/strategy/catalog";
import { ensureTransactionDatabase, getD1 } from "../../db";
import {
  type CreateStrategyInput,
  type StrategyOrigin,
  type StrategyPerformance,
  type StrategyRecord,
  type UpdateStrategyInput,
} from "./strategy-contracts";
import {
  deleteStrategyPreference,
  listStrategyPreferences,
  updateStrategyPreference,
} from "./strategy-preferences.server";
import { DEFAULT_LOCAL_OWNER_ID } from "./watchlist-contracts";

const BUILT_IN_IDS = new Set<string>(
  STRATEGY_PACKAGE_DEFINITIONS.map((strategy) => strategy.id),
);
const RETIRED_BUILT_IN_IDS = new Set<string>(RETIRED_SAMPLE_STRATEGY_IDS);

const EMPTY_PERFORMANCE: Omit<StrategyPerformance, "provenance"> = {
  netReturn: null,
  maxDrawdown: null,
  recoveryFactor: null,
  sharpe: null,
  forwardReturn: null,
  winRate: null,
  trades: null,
  symbols: null,
  cash: null,
};

type StoredCustomDefinition = Omit<
  StrategyRecord,
  "id" | "origin" | "version" | "createdAt" | "updatedAt"
>;

type CustomStrategyRow = {
  owner_id: string;
  strategy_id: string;
  version: number;
  definition_json: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export class StrategyStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StrategyStoreError";
  }
}

export function currentStrategyOwnerId(): string {
  return DEFAULT_LOCAL_OWNER_ID;
}

function now(): string {
  return new Date().toISOString();
}

function displayTimestamp(value: string): string {
  const date = new Date(value);
  const parts = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ];
  return `${parts.join("/")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function hasPerformanceValues(performance: Omit<StrategyPerformance, "provenance">): boolean {
  return Object.values(performance).some((value) => value !== null);
}

function parseDefinition(row: CustomStrategyRow): StoredCustomDefinition {
  try {
    const parsed = JSON.parse(row.definition_json) as StoredCustomDefinition;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new StrategyStoreError(
      500,
      "strategy_definition_corrupt",
      "The saved strategy definition could not be read.",
    );
  }
}

function customRecord(row: CustomStrategyRow): StrategyRecord {
  return {
    id: row.strategy_id,
    origin: "custom",
    version: row.version,
    ...parseDefinition(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function builtInRecords(
  locale: Locale,
  preferences: Awaited<ReturnType<typeof listStrategyPreferences>>,
): StrategyRecord[] {
  const preferenceById = new Map(preferences.map((entry) => [entry.strategyId, entry]));
  return strategyPackagesForLocale(locale, preferences).map((strategy) => {
    const preference = preferenceById.get(strategy.id);
    return {
      id: strategy.id,
      origin: "built_in",
      version: 1,
      family: strategy.family,
      status: strategy.status,
      candidateAt: strategy.candidateAt,
      name: strategy.name,
      category: strategy.category,
      sourceLabels: strategy.sourceLabels,
      headline: strategy.headline,
      audit: strategy.audit,
      performance: { ...strategy.performance },
      createdAt: null,
      updatedAt: preference?.updatedAt ?? null,
    };
  });
}

async function prepareStore(): Promise<D1Database> {
  await ensureTransactionDatabase();
  return getD1();
}

async function customRow(
  db: D1Database,
  ownerId: string,
  strategyId: string,
): Promise<CustomStrategyRow | null> {
  return db
    .prepare(
      `SELECT owner_id, strategy_id, version, definition_json, deleted_at,
              created_at, updated_at
       FROM custom_strategies
       WHERE owner_id = ? AND strategy_id = ?
       LIMIT 1`,
    )
    .bind(ownerId, strategyId)
    .first<CustomStrategyRow>();
}

function auditStatement(
  db: D1Database,
  ownerId: string,
  action: string,
  strategyId: string,
  payload: Record<string, unknown>,
  timestamp: string,
) {
  return db
    .prepare(
      `INSERT INTO app_audit_events
        (id, owner_id, action, entity_type, entity_id, payload_json, created_at)
       VALUES (?, ?, ?, 'strategy', ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      ownerId,
      action,
      strategyId,
      JSON.stringify(payload),
      timestamp,
    );
}

function notFound(): StrategyStoreError {
  return new StrategyStoreError(404, "strategy_not_found", "The strategy was not found.");
}

export async function listStrategies(
  locale: Locale,
  ownerId = currentStrategyOwnerId(),
): Promise<StrategyRecord[]> {
  const [preferences, db] = await Promise.all([
    listStrategyPreferences(ownerId),
    prepareStore(),
  ]);
  const result = await db
    .prepare(
      `SELECT owner_id, strategy_id, version, definition_json, deleted_at,
              created_at, updated_at
       FROM custom_strategies
       WHERE owner_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC, strategy_id ASC`,
    )
    .bind(ownerId)
    .all<CustomStrategyRow>();
  return [...builtInRecords(locale, preferences), ...result.results.map(customRecord)];
}

export async function getStrategy(
  strategyId: string,
  locale: Locale,
  ownerId = currentStrategyOwnerId(),
): Promise<StrategyRecord> {
  if (BUILT_IN_IDS.has(strategyId)) {
    const preferences = await listStrategyPreferences(ownerId);
    const strategy = builtInRecords(locale, preferences).find((entry) => entry.id === strategyId);
    if (!strategy) throw notFound();
    return strategy;
  }
  if (strategyId.startsWith("sample.")) throw notFound();
  const row = await customRow(await prepareStore(), ownerId, strategyId);
  if (!row || row.deleted_at) throw notFound();
  return customRecord(row);
}

/** Used by transaction routes so custom and visible packaged strategies share one boundary. */
export async function assertActiveStrategy(
  strategyId: string,
  ownerId = currentStrategyOwnerId(),
): Promise<StrategyOrigin> {
  if (BUILT_IN_IDS.has(strategyId)) {
    const deleted = (await listStrategyPreferences(ownerId)).some(
      (preference) => preference.strategyId === strategyId && preference.isDeleted,
    );
    if (deleted) throw notFound();
    return "built_in";
  }
  if (strategyId.startsWith("sample.")) throw notFound();
  const row = await customRow(await prepareStore(), ownerId, strategyId);
  if (!row || row.deleted_at) throw notFound();
  return "custom";
}

/**
 * D1 transaction ledgers outlive the package catalog. Retired built-in IDs are
 * accepted here only so owners can inspect, export, edit, or delete records
 * that were saved before a catalog reduction; they remain hidden elsewhere.
 */
export async function assertStrategyTransactionAccess(
  strategyId: string,
  ownerId = currentStrategyOwnerId(),
): Promise<StrategyOrigin> {
  if (RETIRED_BUILT_IN_IDS.has(strategyId)) return "built_in";
  return assertActiveStrategy(strategyId, ownerId);
}

export async function createStrategy(
  input: CreateStrategyInput,
  ownerId = currentStrategyOwnerId(),
): Promise<StrategyRecord> {
  const strategyId = input.strategyId ?? `custom.${crypto.randomUUID()}`;
  if (BUILT_IN_IDS.has(strategyId) || strategyId.startsWith("sample.")) {
    throw new StrategyStoreError(
      409,
      "strategy_id_conflict",
      "The strategy ID is reserved by the built-in catalog.",
    );
  }
  const mutationTime = now();
  const metrics = { ...EMPTY_PERFORMANCE, ...input.performance };
  const definition: StoredCustomDefinition = {
    family: input.family ?? "rule",
    status: input.status ?? "research",
    candidateAt: input.candidateAt ?? displayTimestamp(mutationTime),
    name: input.name,
    category: input.category ?? "Custom",
    sourceLabels: input.sourceLabels ?? [],
    headline: input.headline,
    audit: {
      overfit: input.audit?.overfit ?? null,
      leakage: input.audit?.leakage ?? null,
      verdict: input.audit?.verdict ?? "Not evaluated",
    },
    performance: {
      provenance: hasPerformanceValues(metrics) ? "user_supplied" : "unavailable",
      ...metrics,
    },
  };
  const db = await prepareStore();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO custom_strategies
            (owner_id, strategy_id, version, definition_json, deleted_at, created_at, updated_at)
           VALUES (?, ?, 1, ?, NULL, ?, ?)`,
        )
        .bind(ownerId, strategyId, JSON.stringify(definition), mutationTime, mutationTime),
      auditStatement(db, ownerId, "strategy.created", strategyId, { version: 1 }, mutationTime),
    ]);
  } catch (error) {
    const existing = await customRow(db, ownerId, strategyId);
    if (existing) {
      throw new StrategyStoreError(
        409,
        "strategy_id_conflict",
        "A strategy with this ID already exists.",
      );
    }
    throw error;
  }
  const created = await customRow(db, ownerId, strategyId);
  if (!created) {
    throw new StrategyStoreError(500, "write_failed", "The strategy could not be created.");
  }
  return customRecord(created);
}

function mergeCustomDefinition(
  current: StoredCustomDefinition,
  input: UpdateStrategyInput,
): StoredCustomDefinition {
  const currentMetrics: Omit<StrategyPerformance, "provenance"> = {
    netReturn: current.performance.netReturn,
    maxDrawdown: current.performance.maxDrawdown,
    recoveryFactor: current.performance.recoveryFactor,
    sharpe: current.performance.sharpe,
    forwardReturn: current.performance.forwardReturn,
    winRate: current.performance.winRate,
    trades: current.performance.trades,
    symbols: current.performance.symbols,
    cash: current.performance.cash,
  };
  const performanceMetrics = input.performance
    ? { ...EMPTY_PERFORMANCE, ...currentMetrics, ...input.performance }
    : null;
  return {
    ...current,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.headline === undefined ? {} : { headline: input.headline }),
    ...(input.family === undefined ? {} : { family: input.family }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.candidateAt === undefined ? {} : { candidateAt: input.candidateAt }),
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.sourceLabels === undefined ? {} : { sourceLabels: input.sourceLabels }),
    ...(input.audit === undefined ? {} : { audit: { ...current.audit, ...input.audit } }),
    ...(performanceMetrics === null
      ? {}
      : {
          performance: {
            provenance: hasPerformanceValues(performanceMetrics)
              ? "user_supplied" as const
              : "unavailable" as const,
            ...performanceMetrics,
          },
        }),
  };
}

export async function updateStrategy(
  strategyId: string,
  input: UpdateStrategyInput,
  locale: Locale,
  ownerId = currentStrategyOwnerId(),
): Promise<StrategyRecord> {
  if (BUILT_IN_IDS.has(strategyId)) {
    const unsupported = [
      input.family, input.status, input.candidateAt, input.category,
      input.sourceLabels, input.audit, input.performance,
    ].some((value) => value !== undefined);
    if (unsupported) {
      throw new StrategyStoreError(
        400,
        "built_in_fields_read_only",
        "Only name and headline can be edited for a built-in strategy.",
      );
    }
    await updateStrategyPreference(
      strategyId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.headline === undefined ? {} : { headline: input.headline }),
      },
      ownerId,
    );
    return getStrategy(strategyId, locale, ownerId);
  }
  if (strategyId.startsWith("sample.")) throw notFound();
  if (input.expectedVersion === undefined) {
    throw new StrategyStoreError(
      428,
      "expected_version_required",
      "expectedVersion is required when editing a custom strategy.",
    );
  }
  const db = await prepareStore();
  const current = await customRow(db, ownerId, strategyId);
  if (!current || current.deleted_at) throw notFound();
  if (current.version !== input.expectedVersion) {
    throw new StrategyStoreError(
      409,
      "version_conflict",
      `The strategy is now at version ${current.version}.`,
    );
  }
  const nextVersion = current.version + 1;
  const mutationTime = now();
  const nextDefinition = mergeCustomDefinition(parseDefinition(current), input);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE custom_strategies
         SET definition_json = ?, version = ?, updated_at = ?
         WHERE owner_id = ? AND strategy_id = ? AND version = ? AND deleted_at IS NULL`,
      )
      .bind(
        JSON.stringify(nextDefinition), nextVersion, mutationTime,
        ownerId, strategyId, current.version,
      ),
    db
      .prepare(
        `INSERT INTO app_audit_events
          (id, owner_id, action, entity_type, entity_id, payload_json, created_at)
         SELECT ?, ?, 'strategy.updated', 'strategy', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM custom_strategies
           WHERE owner_id = ? AND strategy_id = ? AND version = ? AND updated_at = ?
         )`,
      )
      .bind(
        crypto.randomUUID(), ownerId, strategyId,
        JSON.stringify({ fromVersion: current.version, toVersion: nextVersion }),
        mutationTime, ownerId, strategyId, nextVersion, mutationTime,
      ),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1) {
    const latest = await customRow(db, ownerId, strategyId);
    if (!latest || latest.deleted_at) throw notFound();
    throw new StrategyStoreError(
      409,
      "version_conflict",
      `The strategy is now at version ${latest.version}.`,
    );
  }
  const updated = await customRow(db, ownerId, strategyId);
  if (!updated) {
    throw new StrategyStoreError(500, "write_failed", "The strategy could not be updated.");
  }
  return customRecord(updated);
}

export async function deleteStrategy(
  strategyId: string,
  expectedVersion: number | undefined,
  ownerId = currentStrategyOwnerId(),
): Promise<{ origin: StrategyOrigin; version: number; deletedAt: string }> {
  if (BUILT_IN_IDS.has(strategyId)) {
    const preference = await deleteStrategyPreference(strategyId, ownerId);
    if (!preference.deletedAt) {
      throw new StrategyStoreError(500, "write_failed", "The strategy could not be deleted.");
    }
    return { origin: "built_in", version: 1, deletedAt: preference.deletedAt };
  }
  if (strategyId.startsWith("sample.")) throw notFound();
  const db = await prepareStore();
  const current = await customRow(db, ownerId, strategyId);
  if (!current) throw notFound();
  if (current.deleted_at) {
    return { origin: "custom", version: current.version, deletedAt: current.deleted_at };
  }
  if (expectedVersion === undefined) {
    throw new StrategyStoreError(
      428,
      "expected_version_required",
      "expectedVersion is required when deleting a custom strategy.",
    );
  }
  if (expectedVersion !== current.version) {
    throw new StrategyStoreError(
      409,
      "version_conflict",
      `The strategy is now at version ${current.version}.`,
    );
  }
  const mutationTime = now();
  const nextVersion = current.version + 1;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE custom_strategies
         SET deleted_at = ?, version = ?, updated_at = ?
         WHERE owner_id = ? AND strategy_id = ? AND version = ? AND deleted_at IS NULL`,
      )
      .bind(
        mutationTime, nextVersion, mutationTime,
        ownerId, strategyId, current.version,
      ),
    db
      .prepare(
        `INSERT INTO app_audit_events
          (id, owner_id, action, entity_type, entity_id, payload_json, created_at)
         SELECT ?, ?, 'strategy.deleted', 'strategy', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM custom_strategies
           WHERE owner_id = ? AND strategy_id = ? AND version = ? AND deleted_at = ?
         )`,
      )
      .bind(
        crypto.randomUUID(), ownerId, strategyId,
        JSON.stringify({ fromVersion: current.version, toVersion: nextVersion, softDelete: true }),
        mutationTime, ownerId, strategyId, nextVersion, mutationTime,
      ),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1) {
    const latest = await customRow(db, ownerId, strategyId);
    if (latest?.deleted_at) {
      return { origin: "custom", version: latest.version, deletedAt: latest.deleted_at };
    }
    if (!latest) throw notFound();
    throw new StrategyStoreError(
      409,
      "version_conflict",
      `The strategy is now at version ${latest.version}.`,
    );
  }
  return { origin: "custom", version: nextVersion, deletedAt: mutationTime };
}
