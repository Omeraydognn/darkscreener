import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./app.css";
import { AppProvider } from "@/components/app/AppProvider";
import { LangProvider } from "@/components/app/LangProvider";
import { Shell } from "@/components/app/Shell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin", "latin-ext"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "latin-ext"] });

export const metadata: Metadata = {
  title: "darkscreener — hidden price, visible project",
  description:
    "Dark pool DEX: price and trade flow delayed 7 days; the only live thing is project news.",
};

const THEME_SCRIPT = `try{if(localStorage.getItem("darkscreener:theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        {/* Tema ilk boyamadan önce uygulanır (yanıp sönme olmasın); varsayılan açık tema. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-full bg-bg font-sans text-sm text-fg"><LangProvider><AppProvider><Shell>{children}</Shell></AppProvider></LangProvider></body>
    </html>
  );
}
