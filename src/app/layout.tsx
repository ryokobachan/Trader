import type { Metadata } from "next";
import "./globals.css";
import { TRADER_BRAND } from "./platform/brand";
import { DEFAULT_LOCALE, I18nProvider } from "./platform/i18n";

export const metadata: Metadata = {
  title: TRADER_BRAND.metadataTitle,
  description: TRADER_BRAND.description,
  icons: {
    icon: [
      { url: TRADER_BRAND.favicon16Path, type: "image/png", sizes: "16x16" },
      { url: TRADER_BRAND.favicon32Path, type: "image/png", sizes: "32x32" },
      { url: TRADER_BRAND.faviconIcoPath, type: "image/x-icon" },
    ],
    shortcut: TRADER_BRAND.faviconIcoPath,
    apple: [{ url: TRADER_BRAND.appleTouchIconPath, type: "image/png", sizes: "180x180" }],
  },
  openGraph: {
    title: TRADER_BRAND.metadataTitle,
    description: TRADER_BRAND.description,
    images: [{ url: TRADER_BRAND.logoPath, width: 1024, height: 1024, alt: "Trader" }],
  },
  twitter: {
    card: "summary",
    images: [TRADER_BRAND.logoPath],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang={DEFAULT_LOCALE}>
      <body><I18nProvider>{children}</I18nProvider></body>
    </html>
  );
}
