import { livePhase4Deps } from "@/server/api/deps";
import { handleCompile } from "@/server/api/compile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleCompile(request, livePhase4Deps(), id);
}
