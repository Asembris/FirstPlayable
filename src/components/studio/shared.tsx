"use client";

/**
 * The small shared pieces of the studio shell: one same-origin JSON client and
 * one honest finished error panel.
 *
 * The client speaks only to this application's own API. It never holds a
 * credential, never contacts a third party, and reads exactly the frozen error
 * envelope of specification section 11 — code, message, retryable, last good
 * version, request id — so a failure is a finished state the creator can act
 * on rather than a spinner.
 */

import Link from "next/link";

export type RequestFailure = {
  code: string;
  message: string;
  retryable: boolean;
  last_good_version_id: string | null;
  request_id: string;
};

export type RequestResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: RequestFailure };

const UNREACHABLE: RequestFailure = {
  code: "NETWORK_UNREACHABLE",
  message: "This browser could not reach the application.",
  retryable: true,
  last_good_version_id: null,
  request_id: "none",
};

function asFailure(status: number, body: unknown): RequestFailure {
  if (typeof body === "object" && body !== null) {
    const candidate = body as Partial<RequestFailure>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable === true,
        last_good_version_id:
          typeof candidate.last_good_version_id === "string"
            ? candidate.last_good_version_id
            : null,
        request_id:
          typeof candidate.request_id === "string" ? candidate.request_id : "unknown",
      };
    }
  }
  return { ...UNREACHABLE, code: `HTTP_${status}` };
}

async function send<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<RequestResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      // Same-origin only. The browser supplies the Origin header the server checks.
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, failure: UNREACHABLE };
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) return { ok: false, failure: asFailure(response.status, parsed) };
  return { ok: true, value: parsed as T };
}

export function postJson<T>(path: string, body: unknown): Promise<RequestResult<T>> {
  return send<T>(path, "POST", body);
}

export function putJson<T>(path: string, body: unknown): Promise<RequestResult<T>> {
  return send<T>(path, "PUT", body);
}

export function getJson<T>(path: string): Promise<RequestResult<T>> {
  return send<T>(path, "GET");
}

/**
 * The one mutating request with no body: owner-only revocation.
 *
 * It still goes through this client, so it still carries the browser's `Origin`
 * header and the same-origin credential rule rather than being a bare `fetch`
 * somewhere in a component.
 */
export function deleteJson<T>(path: string): Promise<RequestResult<T>> {
  return send<T>(path, "DELETE");
}

/**
 * The inline failure line used beside a step, where a whole panel would be
 * too much. It is still a finished state: a code, a sentence, and a request id.
 */
export function InlineFailure({
  failure,
  testId,
}: {
  failure: RequestFailure;
  testId?: string;
}): React.JSX.Element {
  return (
    <p className="rt-failure-line" role="alert" data-testid={testId ?? "inline-failure"}>
      {failure.message}{" "}
      <span className="rt-failure__meta">
        ({failure.code} · request {failure.request_id})
      </span>
    </p>
  );
}

export function ErrorPanel({
  heading,
  failure,
  onRetry,
}: {
  heading: string;
  failure: RequestFailure;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <div className="rt-failure" role="alert" data-testid="error-panel">
      <p className="rt-failure__heading">{heading}</p>
      <p className="rt-failure__message">{failure.message}</p>
      <p className="rt-failure__meta">
        <span data-testid="error-code">{failure.code}</span>
        {" · request "}
        <span data-testid="error-request-id">{failure.request_id}</span>
      </p>
      <div className="rt-studio__actions">
        {failure.retryable && onRetry !== undefined && (
          <button className="rt-button" type="button" onClick={onRetry}>
            Try again
          </button>
        )}
        <Link
          className="rt-button rt-button--primary"
          href="/example"
          data-testid="error-example-link"
        >
          Play saved example
        </Link>
      </div>
      <p className="rt-studio__note">
        The saved example was generated from a real build and ships with the app. It plays
        without saving, loading, or generating anything.
      </p>
    </div>
  );
}
