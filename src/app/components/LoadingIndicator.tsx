"use client";

import { useI18n } from "../platform/i18n";

export function LoadingIndicator({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <span className="loading-indicator" role="status" aria-label={label ?? t("common.loading")}>
      <span className="loading-spinner" aria-hidden="true" />
    </span>
  );
}
