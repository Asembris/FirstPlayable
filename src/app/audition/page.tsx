import type { Metadata } from "next";
import { AuditionClient } from "@/components/audition/AuditionClient";
import "../rehearsal/audition.css";

export const metadata: Metadata = {
  title: "Comp audition · FirstPlayable",
  robots: { index: false, follow: false },
};

/**
 * The comp audition vertical slice. Isolated from the landing page and the
 * studio: nothing links here yet, and nothing here reads a database directly.
 */
export default function AuditionPage() {
  return <AuditionClient />;
}
