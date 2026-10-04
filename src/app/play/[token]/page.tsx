import type { Metadata } from "next";
import { PublicPlayer } from "@/components/share/PublicPlayer";

/**
 * `noindex` on every share, as specification section 12 requires. It is a
 * request to search engines, not a confidentiality guarantee, and the publish
 * screen says so in those words.
 */
export const metadata: Metadata = {
  title: "Shared playable · FirstPlayable",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PlayPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PublicPlayer token={token} />;
}
