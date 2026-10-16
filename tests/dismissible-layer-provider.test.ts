import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isEventInsideDismissibleLayer } from "../src/app/hooks/useDismissibleLayer";

type FakeBoundary = EventTarget & { contains: (target: Node | null) => boolean };

test("recognizes composed-path and contained events as inside a dismissible layer", () => {
  const child = {} as EventTarget;
  const containedChild = {} as EventTarget;
  const boundary = Object.assign(new EventTarget(), {
    contains: (target: Node | null) => target === containedChild,
  }) as FakeBoundary;

  assert.equal(isEventInsideDismissibleLayer({
    target: child,
    composedPath: () => [child, boundary],
  }, [boundary]), true);
  assert.equal(isEventInsideDismissibleLayer({
    target: containedChild,
    composedPath: () => [containedChild],
  }, [boundary]), true);
});

test("recognizes an event outside every boundary", () => {
  const outside = {} as EventTarget;
  const boundary = Object.assign(new EventTarget(), {
    contains: () => false,
  }) as FakeBoundary;

  assert.equal(isEventInsideDismissibleLayer({
    target: outside,
    composedPath: () => [outside],
  }, [null, boundary]), false);
});

test("hook covers pointer, focus and Escape dismissal with Escape focus restoration", async () => {
  const source = await readFile(new URL("../src/app/hooks/useDismissibleLayer.ts", import.meta.url), "utf8");

  assert.match(source, /addEventListener\("pointerdown"/);
  assert.match(source, /addEventListener\("focusin"/);
  assert.match(source, /event\.key !== "Escape"/);
  assert.match(source, /querySelector<HTMLElement>/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /removeEventListener\("pointerdown"/);
  assert.match(source, /removeEventListener\("focusin"/);
  assert.match(source, /removeEventListener\("keydown"/);
});

test("every non-modal app menu uses the shared dismissible-layer behavior", async () => {
  const pageSource = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const summarySource = await readFile(
    new URL("../src/app/features/symbol-summary/SymbolSummaryHost.tsx", import.meta.url),
    "utf8",
  );

  assert.match(pageSource, /open: toolbarMenu === "chart-type"/);
  assert.doesNotMatch(pageSource, /open: toolbarMenu === "templates"/);
  assert.match(pageSource, /open: menu === "lists"/);
  assert.match(pageSource, /open: menu === "more"/);
  assert.match(pageSource, /open: rowContextMenu !== null/);
  assert.match(pageSource, /open: portfolioMenuOpen/);
  assert.match(summarySource, /open: settingsOpen/);
  assert.match(pageSource, /aria-haspopup="menu"/);
  assert.match(pageSource, /aria-expanded=\{toolbarMenu === "chart-type"\}/);
  assert.match(summarySource, /aria-expanded=\{settingsOpen\}/);
});
