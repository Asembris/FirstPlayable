import { livePhase4Deps } from "@/server/api/deps";
import { handleOperationStatus } from "@/server/api/compile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleOperationStatus(request, livePhase4Deps(), id);
}
