import type { Metadata } from "next";
import "./globals.css";
import { UNICORN_BRAND } from "./platform/brand";
import { DEFAULT_LOCALE, I18nProvider } from "./platform/i18n";

export const metadata: Metadata = {
  title: UNICORN_BRAND.metadataTitle,
  description: UNICORN_BRAND.description,
  icons: {
    icon: [{ url: UNICORN_BRAND.faviconPath, type: "image/png", sizes: "180x180" }],
    apple: [{ url: UNICORN_BRAND.faviconPath, type: "image/png", sizes: "180x180" }],
  },
  openGraph: {
    title: UNICORN_BRAND.metadataTitle,
    description: UNICORN_BRAND.description,
    images: [{ url: UNICORN_BRAND.logoPath, width: 768, height: 768, alt: "Unicorn" }],
  },
  twitter: {
    card: "summary",
    images: [UNICORN_BRAND.logoPath],
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
