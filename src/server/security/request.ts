/**
 * Same-origin and request-size checks for every mutating route
 * (specification sections 11 and 12).
 *
 * The expected origin is derived from the request itself, so the same code is
 * correct on `http://localhost:3000`, on a Vercel preview deployment, and on a
 * production domain, with no hostname compiled into the application. Behind
 * Vercel's proxy the forwarded protocol and host are authoritative; without a
 * proxy the `Host` header and the request URL are.
 */

import { appErrors } from "./errors";

/** Specification section 12: 16 KiB for creator command requests. */
export const CREATOR_COMMAND_BODY_LIMIT_BYTES = 16 * 1024;

/** `POST /api/session` carries nothing but `{}`, so it gets a much tighter cap. */
export const SESSION_BODY_LIMIT_BYTES = 1024;

function firstForwardedValue(request: Request, header: string): string | null {
  const raw = request.headers.get(header);
  if (raw === null) return null;
  const first = raw.split(",")[0]?.trim();
  return first === undefined || first.length === 0 ? null : first;
}

/**
 * The origin this request was actually served on.
 *
 * Returns `null` when neither a forwarded host, a `Host` header, nor a
 * parseable request URL is available; the caller then refuses the mutation
 * rather than guessing an origin that would accept anything.
 */
export function expectedOrigin(request: Request): string | null {
  const forwardedHost = firstForwardedValue(request, "x-forwarded-host");
  const forwardedProto = firstForwardedValue(request, "x-forwarded-proto");
  const host = forwardedHost ?? request.headers.get("host");

  let urlProtocol: string | null = null;
  let urlHost: string | null = null;
  try {
    const url = new URL(request.url);
    urlProtocol = url.protocol.replace(/:$/, "");
    urlHost = url.host;
  } catch {
    urlProtocol = null;
    urlHost = null;
  }

  const resolvedHost = host ?? urlHost;
  if (resolvedHost === null) return null;

  const resolvedProtocol = forwardedProto ?? urlProtocol;
  if (resolvedProtocol === null) return null;

  return `${resolvedProtocol.toLowerCase()}://${resolvedHost.toLowerCase()}`;
}

/**
 * Requires same-origin semantics. A missing `Origin` is refused rather than
 * waved through, which is the whole point of the check: a cross-site form post
 * and a scripted request from another page both have to produce an `Origin`
 * the browser controls, and neither can forge this one.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin === null || origin.trim().length === 0) throw appErrors.originRequired();

  const expected = expectedOrigin(request);
  if (expected === null) throw appErrors.originMismatch();

  let normalized: string;
  try {
    const parsed = new URL(origin);
    normalized = `${parsed.protocol.replace(/:$/, "").toLowerCase()}://${parsed.host.toLowerCase()}`;
  } catch {
    throw appErrors.originMismatch();
  }

  if (normalized !== expected) throw appErrors.originMismatch();
}

export function assertJsonContentType(request: Request): void {
  const header = request.headers.get("content-type");
  if (header === null) throw appErrors.contentType();
  const mediaType = header.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw appErrors.contentType();
}

/**
 * Reads a JSON body, enforcing the byte cap *before* parsing.
 *
 * The declared `Content-Length` is rejected first when it already exceeds the
 * cap, and the stream is then read with a running total so a missing or
 * dishonest length cannot buy an attacker an unbounded read. Nothing expensive
 * — no Zod pass, no database call, no model call — happens before this returns.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes) throw appErrors.bodyTooLarge(maxBytes);
  }

  const body = request.body;
  let text: string;

  if (body === null) {
    text = "";
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw appErrors.bodyTooLarge(maxBytes);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder("utf-8", { fatal: false }).decode(joined);
  }

  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw appErrors.bodyMalformed();
  }
}
