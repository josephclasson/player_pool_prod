import "./globals.css";
import type { Metadata } from "next";
import type { Viewport } from "next";
import { AppShell } from "@/components/layout/AppShell";
import type { ReactNode } from "react";
import { DM_Sans, Oswald } from "next/font/google";

const oswald = Oswald({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: "normal",
  display: "swap",
  // Expose the font through a CSS variable so we can apply it conditionally.
  variable: "--font-score-sleeper"
});

/* databallr.com uses DM Sans + Lato; we load DM Sans as primary UI + stats numerals */
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-databallr"
});

export const metadata: Metadata = {
  title: "Player Pool",
  description: "Premium Men’s NCAA Tournament Player Pool"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  /** Fit-to-width by default; explicit caps so iOS/Android allow pinch-zoom (avoid implicit maximum-scale=1). */
  maximumScale: 5,
  userScalable: true
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="yellow" className={`dark ${oswald.variable} ${dmSans.variable}`}>
      <body className="app-gradient-bg min-h-screen">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

