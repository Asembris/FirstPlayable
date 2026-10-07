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
import "./rehearsal/responsive.css";
import "./rehearsal/studio.css";
import "./rehearsal/review.css";
import "./rehearsal/player.css";
import "./rehearsal/artist.css";
import "./rehearsal/revise.css";
import "./rehearsal/versions.css";
import "./rehearsal/share.css";
import "./rehearsal/desk.css";
import "./rehearsal/public.css";
import "./rehearsal/landing.css";

export const metadata: Metadata = {
  title: "FirstPlayable",
  description:
    "Choose the comps. Switch the audience. See what changes. Choose your game’s comps and compare how Qloo’s taste data orders them for two artist audiences.",
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
