import { createElement } from "react";
import { traderConfig } from "@/app/trader.config";
import { CORE_SYMBOL_SUMMARY_MODULES } from "@/app/features/symbol-summary/core-modules";
import type { SymbolSummaryModuleProps } from "@/app/platform/symbol-summary";
import {
  defineUiModuleRegistry,
  UI_MODULE_SCHEMA_VERSION,
  type UiModuleRegistration,
} from "@/app/platform/ui-module-registry";

const EXAMPLE_MARKET_CONTEXT_MANIFEST = {
  schemaVersion: UI_MODULE_SCHEMA_VERSION,
  id: "example.market_context",
  version: "1.0.0",
  surface: "chart.symbol-summary",
  label: "市場コンテキスト",
  description: "開発者向け拡張例",
  requiredCapabilities: ["market.quote"],
  defaultEnabled: false,
  defaultOrder: 90,
  userConfigurable: true,
  supportedDensities: ["compact", "normal"],
} as const;

function ExampleMarketContextModule({ stock }: SymbolSummaryModuleProps) {
  return createElement(
    "section",
    {
      className: "stock-summary-section",
      "data-module-id": EXAMPLE_MARKET_CONTEXT_MANIFEST.id,
      "data-module-version": EXAMPLE_MARKET_CONTEXT_MANIFEST.version,
    },
    createElement(
      "div",
      { className: "stock-summary-section-title" },
      createElement("strong", null, EXAMPLE_MARKET_CONTEXT_MANIFEST.label),
      createElement("span", null, EXAMPLE_MARKET_CONTEXT_MANIFEST.description),
    ),
    createElement(
      "p",
      { className: "stock-summary-description" },
      `${stock.market}で取引される${stock.ticker}向けの拡張モジュール例です。`,
    ),
  );
}

export const EXAMPLE_MARKET_CONTEXT_MODULE = {
  manifest: EXAMPLE_MARKET_CONTEXT_MANIFEST,
  Component: ExampleMarketContextModule,
} as const satisfies UiModuleRegistration<SymbolSummaryModuleProps>;

/**
 * Deployment-owned static Composition Root. Developers add reviewed imports
 * here; configuration can only enable IDs that already exist in this bundle.
 */
export const TRADER_UI_MODULE_REGISTRY = defineUiModuleRegistry<SymbolSummaryModuleProps>([
  ...CORE_SYMBOL_SUMMARY_MODULES,
  EXAMPLE_MARKET_CONTEXT_MODULE,
]);

export const MOCK_SYMBOL_SUMMARY_CAPABILITIES = Object.freeze([
  "instrument.identity",
  "market.quote",
  "market.bars",
  "fundamentals.normalized",
  "fundamentals.earnings",
  "fundamentals.profile",
  "indicators.summary",
  "analyst.consensus",
]);

export const DEFAULT_SYMBOL_SUMMARY_MODULE_CONFIG = traderConfig.ui.symbolSummary.modules;
export const DEFAULT_SYMBOL_SUMMARY_DENSITY = traderConfig.ui.symbolSummary.density;

export const DEFAULT_SYMBOL_SUMMARY_MODULES = TRADER_UI_MODULE_REGISTRY.resolveSurface({
  surface: "chart.symbol-summary",
  availableCapabilities: MOCK_SYMBOL_SUMMARY_CAPABILITIES,
  density: traderConfig.ui.symbolSummary.density,
  modules: DEFAULT_SYMBOL_SUMMARY_MODULE_CONFIG,
});
