import type { UiModuleManifestV1 } from "../../platform/ui-module-registry";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

const CORE_MODULE_MESSAGE_KEYS: Readonly<Record<string, Readonly<{
  label: string;
  description: string;
}>>> = {
  "core.identity_quote": {
    label: "summary.module.identity.label",
    description: "summary.module.identity.description",
  },
  "core.price_range": {
    label: "summary.module.priceRange.label",
    description: "summary.module.priceRange.description",
  },
  "core.key_statistics": {
    label: "summary.module.keyStatistics.label",
    description: "summary.module.keyStatistics.description",
  },
  "core.earnings": {
    label: "summary.module.earnings.label",
    description: "summary.module.earnings.description",
  },
  "core.financials": {
    label: "summary.module.financials.label",
    description: "summary.module.financials.description",
  },
  "core.performance": {
    label: "summary.module.performance.label",
    description: "summary.module.performance.description",
  },
  "core.technical_rating": {
    label: "summary.module.technical.label",
    description: "summary.module.technical.description",
  },
  "core.analyst_consensus": {
    label: "summary.module.analyst.label",
    description: "summary.module.analyst.description",
  },
  "core.company_profile": {
    label: "summary.module.companyProfile.label",
    description: "summary.module.companyProfile.description",
  },
};

/**
 * Localizes Unicorn's built-in modules while keeping third-party module copy
 * owned by the developer who registered that module.
 */
export function localizedSummaryManifest(manifest: UiModuleManifestV1, t: Translate) {
  const messageKeys = CORE_MODULE_MESSAGE_KEYS[manifest.id];
  if (!messageKeys) {
    return { label: manifest.label, description: manifest.description };
  }
  return {
    label: t(messageKeys.label),
    description: t(messageKeys.description),
  };
}
