import { livePhase4Deps } from "@/server/api/deps";
import { handleAdvance } from "@/server/api/compile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleAdvance(request, livePhase4Deps(), id);
}
