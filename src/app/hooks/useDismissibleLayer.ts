"use client";

import { useEffect, useRef, type RefObject } from "react";

export type DismissibleLayerReason =
  | "escape"
  | "focus-outside"
  | "pointer-outside";

type DismissibleBoundary = Pick<HTMLElement, "contains"> & EventTarget;

type DismissibleEvent = Pick<Event, "composedPath" | "target">;

export type UseDismissibleLayerOptions = {
  /** Attach dismissal listeners only while the menu or popover is visible. */
  open: boolean;
  /**
   * Refs that count as inside the layer. Prefer a host containing both the
   * trigger and popover so clicking the trigger can keep its normal toggle.
   */
  boundaryRefs: readonly RefObject<HTMLElement | null>[];
  onDismiss: (reason: DismissibleLayerReason) => void;
  /**
   * The trigger that should regain focus when Escape closes the layer. When
   * omitted, the first focusable element in the first boundary is used.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Uses both the composed event path and `contains` so dismissal also behaves
 * correctly for nested elements and events crossing a shadow DOM boundary.
 */
export function isEventInsideDismissibleLayer(
  event: DismissibleEvent,
  boundaries: readonly (DismissibleBoundary | null)[],
): boolean {
  const path = event.composedPath();
  const target = event.target;

  return boundaries.some((boundary) => {
    if (!boundary) return false;
    if (path.includes(boundary)) return true;
    return target !== null && boundary.contains(target as Node);
  });
}

/**
 * Closes a non-modal menu/popover when pointer or focus leaves its boundaries,
 * or when Escape is pressed. Pointer listeners run in capture phase so a click
 * on a different trigger dismisses the old layer before opening the new one.
 */
export function useDismissibleLayer({
  open,
  boundaryRefs,
  onDismiss,
  restoreFocusRef,
}: UseDismissibleLayerOptions): void {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!open) return;

    const ownerDocument = boundaryRefs
      .map((reference) => reference.current?.ownerDocument)
      .find((candidate): candidate is Document => candidate !== undefined)
      ?? (typeof document === "undefined" ? undefined : document);
    if (!ownerDocument) return;

    const currentBoundaries = () => boundaryRefs.map((reference) => reference.current);

    const dismissFromPointer = (event: PointerEvent) => {
      if (isEventInsideDismissibleLayer(event, currentBoundaries())) return;
      onDismissRef.current("pointer-outside");
    };

    const dismissFromFocus = (event: FocusEvent) => {
      if (isEventInsideDismissibleLayer(event, currentBoundaries())) return;
      onDismissRef.current("focus-outside");
    };

    const dismissFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      onDismissRef.current("escape");
      const restoreTarget = restoreFocusRef?.current
        ?? currentBoundaries()[0]?.querySelector<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
      restoreTarget?.focus({ preventScroll: true });
    };

    ownerDocument.addEventListener("pointerdown", dismissFromPointer, true);
    ownerDocument.addEventListener("focusin", dismissFromFocus, true);
    ownerDocument.addEventListener("keydown", dismissFromKeyboard, true);

    return () => {
      ownerDocument.removeEventListener("pointerdown", dismissFromPointer, true);
      ownerDocument.removeEventListener("focusin", dismissFromFocus, true);
      ownerDocument.removeEventListener("keydown", dismissFromKeyboard, true);
    };
  }, [boundaryRefs, open, restoreFocusRef]);
}
