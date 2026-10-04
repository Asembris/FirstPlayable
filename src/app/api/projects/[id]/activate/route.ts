import { livePhase4Deps } from "@/server/api/deps";
import { handleActivate } from "@/server/api/compile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleActivate(request, livePhase4Deps(), id);
}
