import { livePhase3Deps } from "@/server/api/deps";
import { handleInterpret } from "@/server/api/audition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleInterpret(request, livePhase3Deps());
}
