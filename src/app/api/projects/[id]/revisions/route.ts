import { livePhase4Deps } from "@/server/api/deps";
import { handleRevision } from "@/server/api/revisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleRevision(request, livePhase4Deps(), id);
}
