import { traderConfig } from "../../app/trader.config";
import type { ProviderCapability } from "../../app/platform/provider-contracts";
import type { ProviderRole } from "../../../api/provider-roles";
import {
  listInstalledProviderManifests,
  listInstalledProviderSources,
  resolveProviderSelections,
} from "../../../api/index.server";
import { DEFAULT_SYMBOL_SUMMARY_MODULES } from "@extensions";

const REQUIRED_CAPABILITIES: Readonly<Record<ProviderRole, readonly ProviderCapability[]>> = {
  instrument: ["instrument.search", "instrument.identity"],
  market: ["market.quote"],
  bars: ["market.bars"],
  profile: ["fundamentals.profile"],
  fundamentals: ["fundamentals.normalized"],
  earnings: ["fundamentals.earnings"],
  analyst: ["analyst.consensus"],
  news: ["news.company"],
};

const UPSTREAM: Readonly<Record<string, string>> = {
  mock: "deterministic local fixtures",
  yahoo: "Yahoo Finance-compatible endpoints",
  fmp: "Financial Modeling Prep stable API",
  benzinga: "Benzinga calendar ratings API",
  "tradingview-websocket": "local Python sidecar → TradingView websocket",
};

const effective = resolveProviderSelections(process.env);
const manifests = new Map(listInstalledProviderManifests().map((manifest) => [manifest.id, manifest]));
const sources = new Map(listInstalledProviderSources().map(({ id, source }) => [id, source]));

for (const [role, selection] of Object.entries(effective) as [ProviderRole, (typeof effective)[ProviderRole]][]) {
  const providerId = selection.id;
  if (!providerId) continue;
  const manifest = manifests.get(providerId);
  if (!manifest) throw new Error(`providers.${role}: provider ${providerId} is not installed`);
  for (const capability of REQUIRED_CAPABILITIES[role]) {
    if (!manifest.capabilities.includes(capability)) {
      throw new Error(`providers.${role}: provider ${providerId} does not provide ${capability}`);
    }
  }
}

const providerSummary = (Object.entries(effective) as [ProviderRole, (typeof effective)[ProviderRole]][])
  .map(([role, selection]) => {
    if (!selection.id) return `- ${role}: disabled (${selection.origin})`;
    const manifest = manifests.get(selection.id);
    const requiredEnv = manifest?.requiredEnv.length
      ? `; requires ${manifest.requiredEnv.join(", ")}`
      : "";
    return `- ${role}: ${selection.id} (${selection.origin}) -> ${sources.get(selection.id) ?? "registered adapter"} -> ${UPSTREAM[selection.id] ?? manifest?.displayName ?? "installed adapter"}${requiredEnv}`;
  })
  .join("\n");

process.stdout.write(
  `Trader configuration is valid.\nProviders:\n${providerSummary}\nUI: ${DEFAULT_SYMBOL_SUMMARY_MODULES.length} summary modules, ${traderConfig.ui.symbolDetail.tabs.length} detail tabs, ${traderConfig.ui.strategyDetail.summaryMetrics.length} strategy metrics.\n`,
);
