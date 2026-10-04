import { liveDeps } from "@/server/api/deps";
import { handlePublicRead } from "@/server/api/publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  return handlePublicRead(request, liveDeps(), token);
}
