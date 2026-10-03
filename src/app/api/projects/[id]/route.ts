import { liveDeps } from "@/server/api/deps";
import { handleReadProject } from "@/server/api/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleReadProject(request, liveDeps(), id);
}
