import { liveDeps } from "@/server/api/deps";
import { handlePublish } from "@/server/api/publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handlePublish(request, liveDeps(), id);
}
