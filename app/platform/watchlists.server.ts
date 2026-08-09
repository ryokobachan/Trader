import { ensureTransactionDatabase, getD1 } from "../../db";
import {
  DEFAULT_LOCAL_OWNER_ID,
  DEFAULT_WATCHLIST_ITEMS,
  DEFAULT_WATCHLIST_NAME,
  type AddWatchlistItemInput,
  type Watchlist,
  type WatchlistItem,
} from "./watchlist-contracts";

type WatchlistRow = {
  id: string;
  owner_id: string;
  name: string;
  sort_order: number;
  is_default: number;
  version: number;
  created_at: string;
  updated_at: string;
};

type WatchlistItemRow = {
  id: string;
  watchlist_id: string;
  owner_id: string;
  instrument_id: string;
  symbol: string;
  display_name: string | null;
  exchange: string | null;
  logo_url: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export class WatchlistStoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WatchlistStoreError";
  }
}

/**
 * Authentication will replace this adapter. Keeping ownership in every query
 * prevents a later multi-user migration from relying on unscoped row ids.
 */
export function currentWatchlistOwnerId(): string {
  return DEFAULT_LOCAL_OWNER_ID;
}

function timestamp(): string {
  return new Date().toISOString();
}

function auditStatement(
  db: D1Database,
  ownerId: string,
  action: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown> = {},
) {
  return db
    .prepare(
      `INSERT INTO app_audit_events
        (id, owner_id, action, entity_type, entity_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      ownerId,
      action,
      entityType,
      entityId,
      JSON.stringify(payload),
      timestamp(),
    );
}

function toItem(row: WatchlistItemRow): WatchlistItem {
  return {
    id: row.id,
    watchlistId: row.watchlist_id,
    instrumentId: row.instrument_id,
    symbol: row.symbol,
    displayName: row.display_name ?? undefined,
    exchange: row.exchange ?? undefined,
    logoUrl: row.logo_url ?? undefined,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWatchlist(row: WatchlistRow, items: WatchlistItemRow[]): Watchlist {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    isDefault: row.is_default === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map(toItem),
  };
}

async function prepareStore(): Promise<D1Database> {
  await ensureTransactionDatabase();
  return getD1();
}

async function watchlistRow(
  db: D1Database,
  ownerId: string,
  watchlistId: string,
): Promise<WatchlistRow> {
  const row = await db
    .prepare("SELECT * FROM watchlists WHERE owner_id = ? AND id = ? LIMIT 1")
    .bind(ownerId, watchlistId)
    .first<WatchlistRow>();
  if (!row) {
    throw new WatchlistStoreError(404, "watchlist_not_found", "ウォッチリストが見つかりません。");
  }
  return row;
}

async function itemRows(
  db: D1Database,
  ownerId: string,
  watchlistId: string,
): Promise<WatchlistItemRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM watchlist_items
       WHERE owner_id = ? AND watchlist_id = ?
       ORDER BY position ASC, created_at ASC, id ASC`,
    )
    .bind(ownerId, watchlistId)
    .all<WatchlistItemRow>();
  return result.results;
}

async function hydrateWatchlist(
  db: D1Database,
  ownerId: string,
  watchlistId: string,
): Promise<Watchlist> {
  const row = await watchlistRow(db, ownerId, watchlistId);
  return toWatchlist(row, await itemRows(db, ownerId, watchlistId));
}

async function ensureDefaultWatchlist(db: D1Database, ownerId: string): Promise<void> {
  const first = await db
    .prepare(
      `SELECT * FROM watchlists
       WHERE owner_id = ?
       ORDER BY is_default DESC, sort_order ASC, created_at ASC
       LIMIT 1`,
    )
    .bind(ownerId)
    .first<WatchlistRow>();

  if (first?.is_default === 1) return;

  const now = timestamp();
  if (first) {
    await db.batch([
      db
        .prepare(
          `UPDATE watchlists
           SET is_default = 1, version = version + 1, updated_at = ?
           WHERE owner_id = ? AND id = ?`,
        )
        .bind(now, ownerId, first.id),
      auditStatement(db, ownerId, "watchlist.default.repaired", "watchlist", first.id),
    ]);
    return;
  }

  const id = crypto.randomUUID();
  const initialItems = DEFAULT_WATCHLIST_ITEMS.map((item, position) => ({
    ...item,
    id: crypto.randomUUID(),
    position,
  }));
  await db.batch([
    db
      .prepare(
        `INSERT INTO watchlists
          (id, owner_id, name, sort_order, is_default, version, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, 1, ?, ?)`,
      )
      .bind(id, ownerId, DEFAULT_WATCHLIST_NAME, now, now),
    ...initialItems.map((item) =>
      db
        .prepare(
          `INSERT INTO watchlist_items
            (id, watchlist_id, owner_id, instrument_id, symbol, display_name, exchange, logo_url,
             position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.id,
          id,
          ownerId,
          item.instrumentId,
          item.symbol,
          item.displayName,
          item.exchange,
          item.logoUrl,
          item.position,
          now,
          now,
        ),
    ),
    auditStatement(db, ownerId, "watchlist.created", "watchlist", id, {
      name: DEFAULT_WATCHLIST_NAME,
      isDefault: true,
      initialSymbols: initialItems.map((item) => item.symbol),
    }),
  ]);
}

export async function listWatchlists(ownerId = currentWatchlistOwnerId()): Promise<Watchlist[]> {
  const db = await prepareStore();
  await ensureDefaultWatchlist(db, ownerId);
  const [listsResult, itemsResult] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM watchlists
         WHERE owner_id = ?
         ORDER BY sort_order ASC, created_at ASC, id ASC`,
      )
      .bind(ownerId)
      .all<WatchlistRow>(),
    db
      .prepare(
        `SELECT * FROM watchlist_items
         WHERE owner_id = ?
         ORDER BY watchlist_id ASC, position ASC, created_at ASC, id ASC`,
      )
      .bind(ownerId)
      .all<WatchlistItemRow>(),
  ]);

  const itemsByList = new Map<string, WatchlistItemRow[]>();
  for (const item of itemsResult.results) {
    const items = itemsByList.get(item.watchlist_id) ?? [];
    items.push(item);
    itemsByList.set(item.watchlist_id, items);
  }

  return listsResult.results.map((row) => toWatchlist(row, itemsByList.get(row.id) ?? []));
}

export async function getWatchlist(
  watchlistId: string,
  ownerId = currentWatchlistOwnerId(),
): Promise<Watchlist> {
  const db = await prepareStore();
  return hydrateWatchlist(db, ownerId, watchlistId);
}

export async function createWatchlist(
  name: string,
  ownerId = currentWatchlistOwnerId(),
): Promise<Watchlist> {
  const db = await prepareStore();
  await ensureDefaultWatchlist(db, ownerId);
  const duplicate = await db
    .prepare("SELECT id FROM watchlists WHERE owner_id = ? AND name = ? LIMIT 1")
    .bind(ownerId, name)
    .first<{ id: string }>();
  if (duplicate) {
    throw new WatchlistStoreError(409, "watchlist_name_exists", "同じ名前のウォッチリストがあります。");
  }

  const orderRow = await db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM watchlists WHERE owner_id = ?")
    .bind(ownerId)
    .first<{ next_order: number }>();
  const id = crypto.randomUUID();
  const now = timestamp();
  const sortOrder = orderRow?.next_order ?? 0;
  await db.batch([
    db
      .prepare(
        `INSERT INTO watchlists
          (id, owner_id, name, sort_order, is_default, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, ?, ?)`,
      )
      .bind(id, ownerId, name, sortOrder, now, now),
    auditStatement(db, ownerId, "watchlist.created", "watchlist", id, { name }),
  ]);

  return hydrateWatchlist(db, ownerId, id);
}

export async function renameWatchlist(
  watchlistId: string,
  name: string,
  ownerId = currentWatchlistOwnerId(),
): Promise<Watchlist> {
  const db = await prepareStore();
  const current = await watchlistRow(db, ownerId, watchlistId);
  if (current.name === name) return hydrateWatchlist(db, ownerId, watchlistId);
  const duplicate = await db
    .prepare("SELECT id FROM watchlists WHERE owner_id = ? AND name = ? AND id <> ? LIMIT 1")
    .bind(ownerId, name, watchlistId)
    .first<{ id: string }>();
  if (duplicate) {
    throw new WatchlistStoreError(409, "watchlist_name_exists", "同じ名前のウォッチリストがあります。");
  }

  const now = timestamp();
  await db.batch([
    db
      .prepare(
        `UPDATE watchlists
         SET name = ?, version = version + 1, updated_at = ?
         WHERE owner_id = ? AND id = ?`,
      )
      .bind(name, now, ownerId, watchlistId),
    auditStatement(db, ownerId, "watchlist.renamed", "watchlist", watchlistId, {
      previousName: current.name,
      name,
    }),
  ]);
  return hydrateWatchlist(db, ownerId, watchlistId);
}

export async function deleteWatchlist(
  watchlistId: string,
  ownerId = currentWatchlistOwnerId(),
): Promise<{ deletedId: string; nextWatchlistId: string }> {
  const db = await prepareStore();
  const current = await watchlistRow(db, ownerId, watchlistId);
  const now = timestamp();
  const results = await db.batch([
    // The replacement check runs in the same write transaction as DELETE. Two
    // concurrent requests that both observed two lists can no longer remove
    // both: the second DELETE sees that no replacement remains and changes 0 rows.
    db
      .prepare(
        `DELETE FROM watchlists
         WHERE owner_id = ? AND id = ?
           AND EXISTS (
             SELECT 1 FROM watchlists AS replacement
             WHERE replacement.owner_id = ? AND replacement.id <> ?
           )`,
      )
      .bind(ownerId, watchlistId, ownerId, watchlistId),
    // `changes()` carries the immediately preceding statement's result through
    // this batch. A failed conditional DELETE therefore writes no audit event.
    db
      .prepare(
        `INSERT INTO app_audit_events
          (id, owner_id, action, entity_type, entity_id, payload_json, created_at)
         SELECT ?, ?, 'watchlist.deleted', 'watchlist', ?,
           json_object(
             'name', ?,
             'nextWatchlistId', (
               SELECT id FROM watchlists
               WHERE owner_id = ?
               ORDER BY is_default DESC, sort_order ASC, created_at ASC, id ASC
               LIMIT 1
             )
           ), ?
         WHERE changes() = 1`,
      )
      .bind(
        crypto.randomUUID(),
        ownerId,
        watchlistId,
        current.name,
        ownerId,
        now,
      ),
    // Always repair the default invariant after a successful delete. This does
    // not rely on the pre-read `current.is_default`, which may be stale if a
    // concurrent request promoted this list immediately before the batch.
    db
      .prepare(
        `UPDATE watchlists
         SET is_default = 1, version = version + 1, updated_at = ?
         WHERE owner_id = ?
           AND changes() = 1
           AND NOT EXISTS (
             SELECT 1 FROM watchlists AS current_default
             WHERE current_default.owner_id = ? AND current_default.is_default = 1
           )
           AND id = (
             SELECT id FROM watchlists AS replacement
             WHERE replacement.owner_id = ?
             ORDER BY replacement.sort_order ASC, replacement.created_at ASC, replacement.id ASC
             LIMIT 1
           )`,
      )
      .bind(now, ownerId, ownerId, ownerId),
    db
      .prepare(
        `INSERT INTO app_audit_events
          (id, owner_id, action, entity_type, entity_id, payload_json, created_at)
         SELECT ?, ?, 'watchlist.default.promoted', 'watchlist', promoted.id,
           json_object('deletedWatchlistId', ?), ?
         FROM watchlists AS promoted
         WHERE promoted.owner_id = ? AND promoted.is_default = 1 AND changes() = 1
         ORDER BY promoted.sort_order ASC, promoted.created_at ASC, promoted.id ASC
         LIMIT 1`,
      )
      .bind(crypto.randomUUID(), ownerId, watchlistId, now, ownerId),
  ]);

  const deletedRows = Number(results[0]?.meta?.changes ?? 0);
  if (deletedRows !== 1) {
    const stillExists = await db
      .prepare("SELECT id FROM watchlists WHERE owner_id = ? AND id = ? LIMIT 1")
      .bind(ownerId, watchlistId)
      .first<{ id: string }>();
    if (stillExists) {
      throw new WatchlistStoreError(
        409,
        "last_watchlist_required",
        "最後のウォッチリストは削除できません。",
      );
    }
    throw new WatchlistStoreError(404, "watchlist_not_found", "ウォッチリストが見つかりません。");
  }

  const nextWatchlist = await db
    .prepare(
      `SELECT * FROM watchlists
       WHERE owner_id = ?
       ORDER BY is_default DESC, sort_order ASC, created_at ASC, id ASC
       LIMIT 1`,
    )
    .bind(ownerId)
    .first<WatchlistRow>();
  if (!nextWatchlist) {
    throw new WatchlistStoreError(500, "write_failed", "ウォッチリストを削除できませんでした。");
  }
  return { deletedId: watchlistId, nextWatchlistId: nextWatchlist.id };
}

export async function addWatchlistItem(
  watchlistId: string,
  input: AddWatchlistItemInput,
  ownerId = currentWatchlistOwnerId(),
): Promise<WatchlistItem> {
  const db = await prepareStore();
  await watchlistRow(db, ownerId, watchlistId);
  const existing = await db
    .prepare(
      `SELECT * FROM watchlist_items
       WHERE owner_id = ? AND watchlist_id = ? AND instrument_id = ? LIMIT 1`,
    )
    .bind(ownerId, watchlistId, input.instrumentId)
    .first<WatchlistItemRow>();
  const now = timestamp();

  if (existing) {
    await db.batch([
      db
        .prepare(
          `UPDATE watchlist_items
           SET symbol = ?, display_name = ?, exchange = ?, logo_url = ?, updated_at = ?
           WHERE owner_id = ? AND watchlist_id = ? AND id = ?`,
        )
        .bind(
          input.symbol,
          input.displayName ?? null,
          input.exchange ?? null,
          input.logoUrl ?? null,
          now,
          ownerId,
          watchlistId,
          existing.id,
        ),
      auditStatement(db, ownerId, "watchlist.item.refreshed", "watchlist_item", existing.id, {
        watchlistId,
        instrumentId: input.instrumentId,
      }),
    ]);
    const refreshed = await db
      .prepare("SELECT * FROM watchlist_items WHERE owner_id = ? AND id = ? LIMIT 1")
      .bind(ownerId, existing.id)
      .first<WatchlistItemRow>();
    if (!refreshed) throw new WatchlistStoreError(500, "write_failed", "銘柄を保存できませんでした。");
    return toItem(refreshed);
  }

  const positionRow = await db
    .prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
       FROM watchlist_items WHERE owner_id = ? AND watchlist_id = ?`,
    )
    .bind(ownerId, watchlistId)
    .first<{ next_position: number }>();
  const id = crypto.randomUUID();
  const position = positionRow?.next_position ?? 0;
  await db.batch([
    db
      .prepare(
        `INSERT INTO watchlist_items
          (id, watchlist_id, owner_id, instrument_id, symbol, display_name, exchange, logo_url,
           position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        watchlistId,
        ownerId,
        input.instrumentId,
        input.symbol,
        input.displayName ?? null,
        input.exchange ?? null,
        input.logoUrl ?? null,
        position,
        now,
        now,
      ),
    auditStatement(db, ownerId, "watchlist.item.added", "watchlist_item", id, {
      watchlistId,
      instrumentId: input.instrumentId,
      symbol: input.symbol,
    }),
  ]);

  const inserted = await db
    .prepare("SELECT * FROM watchlist_items WHERE owner_id = ? AND id = ? LIMIT 1")
    .bind(ownerId, id)
    .first<WatchlistItemRow>();
  if (!inserted) throw new WatchlistStoreError(500, "write_failed", "銘柄を保存できませんでした。");
  return toItem(inserted);
}

export async function deleteWatchlistItem(
  watchlistId: string,
  itemId: string,
  ownerId = currentWatchlistOwnerId(),
): Promise<void> {
  const db = await prepareStore();
  await watchlistRow(db, ownerId, watchlistId);
  const item = await db
    .prepare(
      `SELECT * FROM watchlist_items
       WHERE owner_id = ? AND watchlist_id = ? AND id = ? LIMIT 1`,
    )
    .bind(ownerId, watchlistId, itemId)
    .first<WatchlistItemRow>();
  if (!item) {
    throw new WatchlistStoreError(404, "watchlist_item_not_found", "ウォッチリストの銘柄が見つかりません。");
  }
  await db.batch([
    db
      .prepare("DELETE FROM watchlist_items WHERE owner_id = ? AND watchlist_id = ? AND id = ?")
      .bind(ownerId, watchlistId, itemId),
    auditStatement(db, ownerId, "watchlist.item.removed", "watchlist_item", itemId, {
      watchlistId,
      instrumentId: item.instrument_id,
      symbol: item.symbol,
    }),
  ]);
}

export async function reorderWatchlistItems(
  watchlistId: string,
  itemIds: string[],
  ownerId = currentWatchlistOwnerId(),
): Promise<Watchlist> {
  const db = await prepareStore();
  await watchlistRow(db, ownerId, watchlistId);
  const current = await itemRows(db, ownerId, watchlistId);
  const currentIds = new Set(current.map((item) => item.id));
  if (itemIds.length !== current.length || itemIds.some((id) => !currentIds.has(id))) {
    throw new WatchlistStoreError(
      409,
      "watchlist_order_conflict",
      "ウォッチリストが更新されています。再読み込みして並べ替えてください。",
    );
  }

  const now = timestamp();
  await db.batch([
    ...itemIds.map((itemId, position) =>
      db
        .prepare(
          `UPDATE watchlist_items SET position = ?, updated_at = ?
           WHERE owner_id = ? AND watchlist_id = ? AND id = ?`,
        )
        .bind(position, now, ownerId, watchlistId, itemId),
    ),
    db
      .prepare(
        `UPDATE watchlists SET version = version + 1, updated_at = ?
         WHERE owner_id = ? AND id = ?`,
      )
      .bind(now, ownerId, watchlistId),
    auditStatement(db, ownerId, "watchlist.items.reordered", "watchlist", watchlistId, {
      itemIds,
    }),
  ]);
  return hydrateWatchlist(db, ownerId, watchlistId);
}
