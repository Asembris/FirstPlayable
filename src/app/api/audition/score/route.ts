import { livePhase3Deps } from "@/server/api/deps";
import { handleScore } from "@/server/api/audition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleScore(request, livePhase3Deps());
}
