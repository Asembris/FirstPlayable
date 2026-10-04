import { livePhase3Deps } from "@/server/api/deps";
import { handleArtistSearch } from "@/server/api/qloo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleArtistSearch(request, livePhase3Deps(), id);
}
