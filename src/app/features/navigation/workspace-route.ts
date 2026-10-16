import { isMidasResearchViewId, type MidasResearchViewId } from "../midas/research-contracts";
import type { SymbolDetailTabId } from "../../platform/trader-config";

export type PrimaryView = "chart" | "stock-detail" | "strategy" | MidasResearchViewId;
export type PortfolioTab = "概要" | "保有銘柄" | "取引";
export type WorkspaceRoute = {
  primaryView: PrimaryView;
  ticker: string;
  stockTab: SymbolDetailTabId;
  strategyScreen: "index" | "detail";
  strategyId: string;
  portfolioTab: PortfolioTab;
};
export type RouteDefaults = { stockTabs: readonly SymbolDetailTabId[]; strategyId: string };
const portfolioSlugs = { "概要": "overview", "保有銘柄": "holdings", "取引": "transactions" } as const;

export function parseWorkspaceRoute(pathname: string, search: string, defaults: RouteDefaults): WorkspaceRoute {
  const route: WorkspaceRoute = {
    primaryView: "chart", ticker: "AAPL", stockTab: defaults.stockTabs[0],
    strategyScreen: "index", strategyId: defaults.strategyId, portfolioTab: "概要",
  };
  let parts: string[];
  try { parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); }
  catch { return route; }
  // Read legacy symbol queries for compatibility; canonical URLs never emit them.
  const query = new URLSearchParams(search);
  const ticker = (parts[0] === "chart" || parts[0] === "symbols" ? parts[1] : query.get("symbol"))?.trim().toUpperCase();
  if (ticker && /^[A-Z0-9][A-Z0-9.^=-]{0,31}$/.test(ticker)) route.ticker = ticker;
  if (parts[0] === "symbols") {
    route.primaryView = "stock-detail";
    const tab = parts[2] === "research" ? "ownership" : parts[2];
    if (defaults.stockTabs.includes(tab as SymbolDetailTabId)) route.stockTab = tab as SymbolDetailTabId;
  } else if (parts[0] === "strategies") {
    route.primaryView = "strategy";
    if (parts[1]) { route.strategyScreen = "detail"; route.strategyId = parts[1]; }
    route.portfolioTab = (Object.keys(portfolioSlugs) as PortfolioTab[]).find((tab) => portfolioSlugs[tab] === parts[2]) ?? "概要";
  } else if (isMidasResearchViewId(parts[0] ?? "")) route.primaryView = parts[0] as MidasResearchViewId;
  return route;
}

export function workspaceRouteUrl(route: WorkspaceRoute): string {
  const symbol = encodeURIComponent(route.ticker);
  if (route.primaryView === "chart") return `/chart/${symbol}`;
  if (route.primaryView === "stock-detail") return `/symbols/${symbol}/${route.stockTab}`;
  if (route.primaryView === "strategy") {
    return route.strategyScreen === "detail"
      ? `/strategies/${encodeURIComponent(route.strategyId)}/${portfolioSlugs[route.portfolioTab]}`
      : "/strategies";
  }
  return `/${route.primaryView}`;
}
