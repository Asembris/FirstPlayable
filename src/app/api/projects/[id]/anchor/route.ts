import { livePhase3Deps } from "@/server/api/deps";
import { handleConfirmAnchor } from "@/server/api/qloo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleConfirmAnchor(request, livePhase3Deps(), id);
}
