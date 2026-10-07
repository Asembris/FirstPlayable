import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { SupabaseGateway } from "../../src/server/db/supabase-gateway";
import type { InsertQlooCaptureInput, QlooCaptureRow } from "../../src/server/db/gateway";

function transport() {
  const requests: { url: URL; method: string; body: unknown; prefer: string | null }[] = [];
  const rows: QlooCaptureRow[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : null;
    requests.push({ url, method: request.method, body, prefer: request.headers.get("prefer") });
    if (body !== null) {
      const row = { ...body, id: randomUUID() } as QlooCaptureRow;
      rows.push(row);
      return Response.json(row, { status: 201 });
    }
    const fp = url.searchParams.get("request_fingerprint")?.slice(3);
    const freshAt = url.searchParams.get("cache_expires_at")?.slice(3);
    const ids = url.searchParams.get("id")?.slice(4, -1).split(",");
    const matching = rows.filter((row) => (fp === undefined || row.request_fingerprint === fp) &&
      (freshAt === undefined || Date.parse(row.cache_expires_at) > Date.parse(freshAt)) &&
      (ids === undefined || ids.includes(row.id)))
      .sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at) || b.id.localeCompare(a.id));
    return Response.json(url.searchParams.has("limit") ? matching.slice(0, 1) : matching);
  }) as typeof fetch;
  return { requests, gateway: new SupabaseGateway(createClient("https://example.invalid", "test-server-credential", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchImpl },
  })) };
}

const input: InsertQlooCaptureInput = {
  kind: "search", requestFingerprint: "same-request", normalizedQuery: "artist", artistEntityId: null,
  domain: null, results: { retrieved_at: "2026-10-04T10:00:00.000Z", candidates: [] },
  quotaDiagnostics: null, normalizerVersion: "test", capturedAt: "2026-10-04T10:00:00.000Z",
  cacheExpiresAt: "2026-10-05T10:00:00.000Z",
};

describe("Supabase capture transport", () => {
  it("returns each concurrent INSERT's own row, never upserting or reading another retrieval", async () => {
    const { gateway, requests } = transport();
    const secondInput = { ...input, results: { retrieved_at: "2026-10-06T10:00:00.000Z", candidates: ["fresh"] },
      capturedAt: "2026-10-06T10:00:00.000Z", cacheExpiresAt: "2026-10-07T10:00:00.000Z" };
    const [old, fresh] = await Promise.all([gateway.insertQlooCapture(input), gateway.insertQlooCapture(secondInput)]);
    expect(old.id).not.toBe(fresh.id);
    expect(old.results).toEqual(input.results);
    expect(fresh.results).toEqual(secondInput.results);
    expect(fresh.captured_at).toBe(secondInput.capturedAt);
    expect(requests.map((r) => r.method)).toEqual(["POST", "POST"]);
    for (const request of requests) {
      expect(request.url.searchParams.has("on_conflict")).toBe(false);
      expect(request.prefer).toContain("return=representation");
      expect(request.prefer).not.toContain("resolution=");
    }
    expect(await gateway.findQlooCapturesByIds([old.id])).toEqual([old]);
    expect((await gateway.findQlooCaptureByFingerprint(input.requestFingerprint))?.id).toBe(fresh.id);
    expect((await gateway.findQlooCapturesByFingerprints([input.requestFingerprint], "2026-10-06T12:00:00.000Z"))[0]?.id).toBe(fresh.id);
    const reads = requests.filter((r) => r.url.searchParams.has("request_fingerprint"));
    for (const request of reads) {
      expect(request.url.searchParams.get("order")).toBe("captured_at.desc,id.desc");
      expect(request.url.searchParams.get("limit")).toBe("1");
    }
    expect(reads.at(-1)?.url.searchParams.get("cache_expires_at")).toBe("gt.2026-10-06T12:00:00.000Z");
  });
});
