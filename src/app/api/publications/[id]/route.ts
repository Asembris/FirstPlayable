import { liveDeps } from "@/server/api/deps";
import { handleRevoke } from "@/server/api/publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleRevoke(request, liveDeps(), id);
}
