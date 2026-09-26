import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin", "latin-ext"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "latin-ext"] });

export const metadata: Metadata = {
  title: "darkscreener — fiyatı gizli, projesi görünür",
  description:
    "Karanlık havuz DEX: fiyat ve işlem akışı 7 gün gecikmeli; canlı olan tek şey proje gelişmeleri.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="tr" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-full bg-bg font-sans text-sm text-fg">{children}</body>
    </html>
  );
}
