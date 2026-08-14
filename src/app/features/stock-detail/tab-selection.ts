export type StockDetailTabSelection<Tab extends string> = Readonly<{
  ticker: string;
  tab: Tab;
}>;

/**
 * Resolve the one parent-owned tab that controls both rendering and fetching.
 * A selection from another symbol never leaks into the current symbol.
 */
export function resolveStockDetailTab<Tab extends string>(
  selection: StockDetailTabSelection<Tab>,
  ticker: string,
  allowedTabs: readonly Tab[],
  defaultTab: Tab,
): Tab {
  return selection.ticker === ticker && allowedTabs.includes(selection.tab)
    ? selection.tab
    : defaultTab;
}

/** Canonicalize parent state when the selected symbol changes. */
export function canonicalStockDetailTabSelection<Tab extends string>(
  selection: StockDetailTabSelection<Tab>,
  ticker: string,
  allowedTabs: readonly Tab[],
  defaultTab: Tab,
): StockDetailTabSelection<Tab> {
  const tab = resolveStockDetailTab(selection, ticker, allowedTabs, defaultTab);
  if (selection.ticker === ticker && selection.tab === tab) return selection;
  return Object.freeze({ ticker, tab });
}
