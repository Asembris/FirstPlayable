import type { Metadata } from "next";
import { StudioClient } from "@/components/studio/StudioClient";

export const metadata: Metadata = {
  title: "Create your scene · FirstPlayable",
  robots: { index: false, follow: false },
};

/**
 * Server component with no database access of its own. Every read and write
 * happens through this application's own same-origin API from the client, which
 * is what keeps `next build` independent of a live database.
 */
export default function StudioPage() {
  return <StudioClient />;
}
