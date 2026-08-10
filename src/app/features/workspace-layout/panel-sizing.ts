export const WORKSPACE_LAYOUT_STORAGE_KEY = "unicorn.workspace-layout.v1";

export const DEFAULT_RIGHT_PANEL_WIDTH = 380;
export const MIN_RIGHT_PANEL_WIDTH = 300;
export const MAX_RIGHT_PANEL_WIDTH = 680;

export const DEFAULT_WATCHLIST_SPLIT_PERCENT = 38;
export const MIN_WATCHLIST_SPLIT_PERCENT = 24;
export const MAX_WATCHLIST_SPLIT_PERCENT = 72;

export type WorkspaceLayoutPreferences = Readonly<{
  rightPanelWidth: number;
  watchlistSplitPercent: number;
}>;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function rightPanelMaxForViewport(viewportWidth: number) {
  if (Number.isFinite(viewportWidth) && viewportWidth >= 981 && viewportWidth <= 1260) {
    return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.floor(viewportWidth * 0.4));
  }
  return MAX_RIGHT_PANEL_WIDTH;
}

export function clampRightPanelWidth(value: number, maximum = MAX_RIGHT_PANEL_WIDTH) {
  const boundedMaximum = clamp(maximum, MIN_RIGHT_PANEL_WIDTH, MAX_RIGHT_PANEL_WIDTH);
  return Math.round(clamp(value, MIN_RIGHT_PANEL_WIDTH, boundedMaximum));
}

export function clampWatchlistSplitPercent(value: number) {
  return Math.round(clamp(value, MIN_WATCHLIST_SPLIT_PERCENT, MAX_WATCHLIST_SPLIT_PERCENT));
}

export function parseWorkspaceLayoutPreferences(raw: string | null): WorkspaceLayoutPreferences {
  if (!raw) {
    return {
      rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
      watchlistSplitPercent: DEFAULT_WATCHLIST_SPLIT_PERCENT,
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== "unicorn.workspace-layout.v1") throw new Error("invalid");
    const rightPanelWidth = Number(record.rightPanelWidth);
    const watchlistSplitPercent = Number(record.watchlistSplitPercent);
    if (!Number.isFinite(rightPanelWidth) || !Number.isFinite(watchlistSplitPercent)) throw new Error("invalid");
    return {
      rightPanelWidth: clampRightPanelWidth(rightPanelWidth),
      watchlistSplitPercent: clampWatchlistSplitPercent(watchlistSplitPercent),
    };
  } catch {
    return {
      rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
      watchlistSplitPercent: DEFAULT_WATCHLIST_SPLIT_PERCENT,
    };
  }
}

export function serializeWorkspaceLayoutPreferences(preferences: WorkspaceLayoutPreferences) {
  return JSON.stringify({
    schemaVersion: "unicorn.workspace-layout.v1",
    rightPanelWidth: clampRightPanelWidth(preferences.rightPanelWidth),
    watchlistSplitPercent: clampWatchlistSplitPercent(preferences.watchlistSplitPercent),
  });
}
