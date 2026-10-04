import { liveDeps } from "@/server/api/deps";
import { handleExport } from "@/server/api/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleExport(request, liveDeps(), id);
}
