import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./globals.css";
import "./rehearsal/tokens.css";
import "./rehearsal/scene.css";
import "./rehearsal/table.css";
import "./rehearsal/compare.css";
import "./rehearsal/landing.css";

export const metadata: Metadata = {
  title: "FirstPlayable",
  description:
    "Choose the influences. Play the consequences. Approve one cultural influence for a scene, then play it with and without that influence.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
