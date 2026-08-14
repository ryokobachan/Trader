export type WatchlistDropEdge = "before" | "after";

type DeleteShortcutEvent = Readonly<{
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}>;

export function moveWatchlistItemIds(
  itemIds: readonly string[],
  sourceId: string,
  targetId: string,
  edge: WatchlistDropEdge,
): string[] {
  const next = [...itemIds];
  if (sourceId === targetId) return next;

  const sourceIndex = next.indexOf(sourceId);
  if (sourceIndex < 0 || !next.includes(targetId)) return next;

  next.splice(sourceIndex, 1);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (edge === "after" ? 1 : 0), 0, sourceId);
  return next;
}

export function nextWatchlistSymbolAfterRemoval(
  items: readonly Readonly<{ symbol: string; position: number }>[],
  removedSymbol: string,
): string | null {
  const ordered = [...items].sort((left, right) => left.position - right.position);
  const removedIndex = ordered.findIndex((item) => item.symbol === removedSymbol);
  if (removedIndex < 0) return null;
  return ordered[removedIndex + 1]?.symbol
    ?? ordered[removedIndex - 1]?.symbol
    ?? null;
}

export function isWatchlistDeleteShortcut(event: DeleteShortcutEvent): boolean {
  if (event.repeat || event.altKey || event.shiftKey) return false;
  if (!event.metaKey || event.ctrlKey) return false;
  return event.key === "Backspace" || event.key === "Delete";
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest(
    "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']",
  ) !== null;
}
