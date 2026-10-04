import { livePhase3Deps } from "@/server/api/deps";
import { handleProposals } from "@/server/api/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleProposals(request, livePhase3Deps(), id);
}
