"use client";

import { useMemo, useRef, useState } from "react";
import { CaretRight, Gear } from "@phosphor-icons/react";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { useI18n } from "../../platform/i18n";
import type {
  SymbolSummaryIntelligence,
  SymbolSummaryModuleProps,
  SymbolSummaryStock,
} from "../../platform/symbol-summary";
import type { SyntheticLatestClose } from "../../platform/provider-contracts";
import {
  uiModuleKey,
  type UiModuleDensity,
  type UiModuleRegistration,
} from "../../platform/ui-module-registry";
import { localizedSummaryManifest } from "./summary-i18n";

export type SymbolSummaryHostProps = {
  stock: SymbolSummaryStock;
  intelligence: SymbolSummaryIntelligence;
  afterHours?: SyntheticLatestClose;
  watched: boolean;
  onToggleWatched: () => void;
  onOpenDetails: () => void;
  registrations: readonly UiModuleRegistration<SymbolSummaryModuleProps>[];
  density?: UiModuleDensity;
  initiallyEnabledModuleKeys?: readonly string[];
};

export function SymbolSummaryHost({
  stock,
  intelligence,
  afterHours,
  watched,
  onToggleWatched,
  onOpenDetails,
  registrations,
  density = "compact",
  initiallyEnabledModuleKeys,
}: SymbolSummaryHostProps) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsHostRef = useRef<HTMLDivElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsBoundaries = useMemo(() => [settingsHostRef] as const, []);
  useDismissibleLayer({
    open: settingsOpen,
    boundaryRefs: settingsBoundaries,
    onDismiss: () => setSettingsOpen(false),
    restoreFocusRef: settingsTriggerRef,
  });
  const fixedRegistrations = useMemo(
    () => registrations.filter((registration) => !registration.manifest.userConfigurable),
    [registrations],
  );
  const configurableRegistrations = useMemo(
    () => registrations.filter((registration) => registration.manifest.userConfigurable),
    [registrations],
  );
  const initialKeys = useMemo(() => new Set(
    initiallyEnabledModuleKeys
      ?? configurableRegistrations
        .map((registration) => uiModuleKey(registration.manifest)),
  ), [configurableRegistrations, initiallyEnabledModuleKeys]);
  const [visibleModuleKeys, setVisibleModuleKeys] = useState<ReadonlySet<string>>(() => initialKeys);

  if (fixedRegistrations.length === 0) {
    throw new Error("SymbolSummaryHost requires a fixed identity module");
  }

  const toggleModule = (key: string) => {
    setVisibleModuleKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const moduleProps: SymbolSummaryModuleProps = {
    stock,
    intelligence,
    afterHours,
    watched,
    onToggleWatched,
    density,
  };

  return (
    <div
      className="stock-information-panel stock-summary-panel"
      aria-label={t("summary.ariaLabel", { symbol: stock.ticker })}
    >
      <div className="stock-summary-toolbar">
        <strong>{t("summary.title")}</strong>
        <div className="stock-summary-settings-host" ref={settingsHostRef}>
          <button
            ref={settingsTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
          >
            <Gear size={14} /> {t("summary.displayItems")}
          </button>
          {settingsOpen && (
            <div className="stock-summary-settings" role="menu" aria-label={t("summary.displayItemsMenu")}>
              {configurableRegistrations.map((registration) => {
                const key = uiModuleKey(registration.manifest);
                const copy = localizedSummaryManifest(registration.manifest, t);
                return (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={visibleModuleKeys.has(key)}
                      onChange={() => toggleModule(key)}
                    />
                    <span><strong>{copy.label}</strong><small>{copy.description}</small></span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {fixedRegistrations.map((registration) => {
        const Component = registration.Component;
        return <Component key={uiModuleKey(registration.manifest)} {...moduleProps} />;
      })}

      {configurableRegistrations
        .filter((registration) => visibleModuleKeys.has(uiModuleKey(registration.manifest)))
        .map((registration) => {
          const Component = registration.Component;
          return <Component key={uiModuleKey(registration.manifest)} {...moduleProps} />;
        })}

      <div className="stock-summary-spacer" />
      <button
        type="button"
        className="stock-summary-detail-button"
        onClick={onOpenDetails}
        aria-label={t("summary.openDetails", { symbol: stock.ticker })}
      >
        <span><strong>{t("summary.details")}</strong><small>{t("summary.detailsDescription")}</small></span><CaretRight size={17} />
      </button>
    </div>
  );
}
