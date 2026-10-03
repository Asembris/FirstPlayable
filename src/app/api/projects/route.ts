import { liveDeps } from "@/server/api/deps";
import { handleCreateProject } from "@/server/api/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleCreateProject(request, liveDeps());
}
