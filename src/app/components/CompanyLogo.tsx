"use client";

import { useState } from "react";
import type { SymbolSummaryStock } from "../platform/symbol-summary";
import { safeCompanyLogoSource } from "../platform/company-logo";

export function CompanyLogo({
  stock,
  className = "",
  eager = false,
}: {
  stock: Pick<SymbolSummaryStock, "ticker" | "name" | "logoPath" | "logoFallback">;
  className?: string;
  eager?: boolean;
}) {
  const logoSource = safeCompanyLogoSource(stock.logoPath);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const logoAvailable = Boolean(logoSource && failedSource !== logoSource);

  return (
    <span
      className={`ticker-avatar company-logo ${className}`.trim()}
      title={`${stock.name} (${stock.ticker})`}
      aria-hidden="true"
    >
      {!logoAvailable && <span className="company-logo-fallback">{stock.logoFallback}</span>}
      {/* Logo sources are deployment-reviewed; the monogram appears only after a real load failure. */}
      {logoAvailable && logoSource ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          key={logoSource}
          src={logoSource}
          alt=""
          width={48}
          height={48}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailedSource(logoSource)}
        />
      ) : null}
    </span>
  );
}
