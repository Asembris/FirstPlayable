import { liveDeps } from "@/server/api/deps";
import { handleCreateSession } from "@/server/api/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleCreateSession(request, liveDeps());
}
