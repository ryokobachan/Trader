import { ensureTransactionDatabase, getD1 } from "../../db";
import { SAMPLE_STRATEGY_DEFINITIONS } from "@strategies/catalog";
import {
  type StrategyPreference,
  type UpdateStrategyPreferenceInput,
} from "./strategy-preference-contracts";
import { DEFAULT_LOCAL_OWNER_ID } from "./watchlist-contracts";

const BUILT_IN_STRATEGY_IDS = SAMPLE_STRATEGY_DEFINITIONS.map(
  (strategy) => strategy.id,
) as readonly string[];
const BUILT_IN_STRATEGY_ID_SET = new Set<string>(BUILT_IN_STRATEGY_IDS);

type StrategyPreferenceRow = {
  owner_id: string;
  strategy_id: string;
  name_override: string | null;
  headline_override: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export class StrategyPreferenceStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StrategyPreferenceStoreError";
  }
}

/** Authentication will replace this server-owned adapter. */
export function currentStrategyPreferenceOwnerId(): string {
  return DEFAULT_LOCAL_OWNER_ID;
}

function timestamp(): string {
  return new Date().toISOString();
}

function assertBuiltInStrategy(strategyId: string): void {
  if (!BUILT_IN_STRATEGY_ID_SET.has(strategyId)) {
    throw new StrategyPreferenceStoreError(
      404,
      "strategy_not_found",
      "The built-in strategy was not found.",
    );
  }
}

function toPreference(row: StrategyPreferenceRow): StrategyPreference {
  return {
    strategyId: row.strategy_id,
    ...(row.name_override === null ? {} : { name: row.name_override }),
    ...(row.headline_override === null ? {} : { headline: row.headline_override }),
    isDeleted: row.deleted_at !== null,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function prepareStore(): Promise<D1Database> {
  await ensureTransactionDatabase();
  return getD1();
}

async function preferenceRow(
  db: D1Database,
  ownerId: string,
  strategyId: string,
): Promise<StrategyPreferenceRow | null> {
  return db
    .prepare(
      `SELECT owner_id, strategy_id, name_override, headline_override, deleted_at,
              created_at, updated_at
       FROM strategy_preferences
       WHERE owner_id = ? AND strategy_id = ?
       LIMIT 1`,
    )
    .bind(ownerId, strategyId)
    .first<StrategyPreferenceRow>();
}

function auditStatement(
  db: D1Database,
  ownerId: string,
  action: string,
  strategyId: string,
  payload: Record<string, unknown>,
  mutationTimestamp: string,
  expectedDeleted: boolean,
) {
  return db
    .prepare(
      `INSERT INTO app_audit_events
        (id, owner_id, action, entity_type, entity_id, payload_json, created_at)
       SELECT ?, ?, ?, 'strategy_preference', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM strategy_preferences
         WHERE owner_id = ? AND strategy_id = ? AND updated_at = ?
           AND deleted_at IS ${expectedDeleted ? "NOT NULL" : "NULL"}
       )`,
    )
    .bind(
      crypto.randomUUID(),
      ownerId,
      action,
      strategyId,
      JSON.stringify(payload),
      mutationTimestamp,
      ownerId,
      strategyId,
      mutationTimestamp,
    );
}

export async function listStrategyPreferences(
  ownerId = currentStrategyPreferenceOwnerId(),
): Promise<StrategyPreference[]> {
  const db = await prepareStore();
  const catalogPlaceholders = BUILT_IN_STRATEGY_IDS.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT owner_id, strategy_id, name_override, headline_override, deleted_at,
              created_at, updated_at
       FROM strategy_preferences
       WHERE owner_id = ? AND strategy_id IN (${catalogPlaceholders})
       ORDER BY strategy_id ASC`,
    )
    .bind(ownerId, ...BUILT_IN_STRATEGY_IDS)
    .all<StrategyPreferenceRow>();
  return result.results.map(toPreference);
}

export async function updateStrategyPreference(
  strategyId: string,
  input: UpdateStrategyPreferenceInput,
  ownerId = currentStrategyPreferenceOwnerId(),
): Promise<StrategyPreference> {
  assertBuiltInStrategy(strategyId);
  const db = await prepareStore();
  const existing = await preferenceRow(db, ownerId, strategyId);
  if (existing?.deleted_at) {
    throw new StrategyPreferenceStoreError(
      409,
      "strategy_deleted",
      "A deleted strategy cannot be edited.",
    );
  }

  const now = timestamp();
  const hasName = input.name !== undefined;
  const hasHeadline = input.headline !== undefined;
  await db.batch([
    db
      .prepare(
        `INSERT INTO strategy_preferences
          (owner_id, strategy_id, name_override, headline_override, deleted_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(owner_id, strategy_id) DO UPDATE SET
           name_override = CASE
             WHEN ? = 1 THEN excluded.name_override
             ELSE strategy_preferences.name_override
           END,
           headline_override = CASE
             WHEN ? = 1 THEN excluded.headline_override
             ELSE strategy_preferences.headline_override
           END,
           updated_at = excluded.updated_at
         WHERE strategy_preferences.deleted_at IS NULL`,
      )
      .bind(
        ownerId,
        strategyId,
        input.name ?? null,
        input.headline ?? null,
        now,
        now,
        hasName ? 1 : 0,
        hasHeadline ? 1 : 0,
      ),
    auditStatement(
      db,
      ownerId,
      "strategy.preference.updated",
      strategyId,
      {
        fields: [hasName ? "name" : null, hasHeadline ? "headline" : null].filter(Boolean),
      },
      now,
      false,
    ),
  ]);

  const updated = await preferenceRow(db, ownerId, strategyId);
  if (updated?.deleted_at) {
    throw new StrategyPreferenceStoreError(
      409,
      "strategy_deleted",
      "A deleted strategy cannot be edited.",
    );
  }
  if (!updated) {
    throw new StrategyPreferenceStoreError(
      500,
      "write_failed",
      "The strategy preference could not be saved.",
    );
  }
  return toPreference(updated);
}

export async function deleteStrategyPreference(
  strategyId: string,
  ownerId = currentStrategyPreferenceOwnerId(),
): Promise<StrategyPreference> {
  assertBuiltInStrategy(strategyId);
  const db = await prepareStore();
  const existing = await preferenceRow(db, ownerId, strategyId);
  if (existing?.deleted_at) return toPreference(existing);

  const now = timestamp();
  const catalogPlaceholders = BUILT_IN_STRATEGY_IDS.map(() => "?").join(", ");
  await db.batch([
    db
      .prepare(
        `INSERT INTO strategy_preferences
          (owner_id, strategy_id, name_override, headline_override, deleted_at,
           created_at, updated_at)
         SELECT ?, ?, NULL, NULL, ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM strategy_preferences
           WHERE owner_id = ?
             AND deleted_at IS NOT NULL
             AND strategy_id IN (${catalogPlaceholders})
         ) < ?
         ON CONFLICT(owner_id, strategy_id) DO UPDATE SET
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at
         WHERE strategy_preferences.deleted_at IS NULL`,
      )
      .bind(
        ownerId,
        strategyId,
        now,
        now,
        now,
        ownerId,
        ...BUILT_IN_STRATEGY_IDS,
        BUILT_IN_STRATEGY_IDS.length - 1,
      ),
    auditStatement(
      db,
      ownerId,
      "strategy.preference.deleted",
      strategyId,
      { softDelete: true },
      now,
      true,
    ),
  ]);

  const deleted = await preferenceRow(db, ownerId, strategyId);
  if (deleted?.deleted_at) return toPreference(deleted);
  throw new StrategyPreferenceStoreError(
    409,
    "last_visible_strategy",
    "At least one strategy must remain visible.",
  );
}
