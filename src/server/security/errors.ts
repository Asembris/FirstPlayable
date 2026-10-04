/**
 * Stable internal error codes and the one error envelope the browser ever
 * sees (specification section 11).
 *
 * Two rules decide everything in this module:
 *
 *   1. The browser receives a code we chose, a sentence we wrote, and a
 *      request id. It never receives a Supabase error object, SQL, a stack
 *      trace, a provider header, an environment value, a session hash, or a
 *      cookie.
 *   2. A missing foreign project and a nonexistent project produce the *same*
 *      response, so a probe cannot learn that someone else's project exists.
 */

/** The phase 2 code vocabulary. Later phases extend it; they do not rename these. */
export const ERROR_CODES = {
  /** The mutation arrived without an Origin header. */
  ORIGIN_REQUIRED: "ORIGIN_REQUIRED",
  /** The Origin header named a different site. */
  ORIGIN_MISMATCH: "ORIGIN_MISMATCH",
  /** A mutating route requires application/json. */
  CONTENT_TYPE_UNSUPPORTED: "CONTENT_TYPE_UNSUPPORTED",
  /** The body exceeded the creator-command cap before any parsing happened. */
  BODY_TOO_LARGE: "BODY_TOO_LARGE",
  /** The body was not parseable JSON. */
  BODY_MALFORMED: "BODY_MALFORMED",
  /** The body parsed but failed the authoritative Zod contract. */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /**
   * A well-formed creator command was refused for a reason the creator needs.
   *
   * `VALIDATION_FAILED` deliberately says one fixed sentence and keeps its
   * detail server-side, because its detail is field paths out of a rejected
   * body. A phase 5 refusal is different: "that slot is empty", "this wording
   * was not previewed", "this would not have preserved what it does not own",
   * and "that version is still awaiting your review" are four different things
   * to do next, and the creator cannot act without knowing which. Every message
   * carried under this code is a fixed sentence this application wrote — never a
   * provider message, a database error, or a field path.
   */
  REQUEST_REFUSED: "REQUEST_REFUSED",
  /** No live anonymous owner session accompanied the request. */
  SESSION_REQUIRED: "SESSION_REQUIRED",
  /** Nonexistent, or owned by somebody else. Deliberately indistinguishable. */
  NOT_FOUND: "NOT_FOUND",
  /** An owner-scoped allowance for this session is used up for now. */
  RATE_LIMITED: "RATE_LIMITED",
  /** The application's configured model budget has no capacity left. */
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  /** Persistence is unavailable or unconfigured. The saved example still plays. */
  PERSISTENCE_UNAVAILABLE: "PERSISTENCE_UNAVAILABLE",
  /** Anything unexpected. The detail stays in the server log, redacted. */
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * The frozen error envelope. `last_good_version_id` is part of the contract
 * from phase 2 onward; it is `null` until a project has a validated scene
 * version, which no phase 2 code path creates.
 */
export type ErrorEnvelope = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  last_good_version_id: string | null;
  request_id: string;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly retryable: boolean;
  /** Server-side only. Redacted before it reaches any log, never sent out. */
  readonly diagnostic: string | undefined;

  constructor(options: {
    code: ErrorCode;
    status: number;
    publicMessage: string;
    retryable: boolean;
    diagnostic?: unknown;
  }) {
    super(options.code);
    this.name = "AppError";
    this.code = options.code;
    this.status = options.status;
    this.publicMessage = options.publicMessage;
    this.retryable = options.retryable;
    this.diagnostic =
      options.diagnostic === undefined ? undefined : redactDiagnostic(options.diagnostic);
  }
}

const SECRET_SHAPES: readonly RegExp[] = [
  /sb_secret_[A-Za-z0-9_-]+/g,
  /sb_publishable_[A-Za-z0-9_-]+/g,
  /sbp_[0-9a-f]+/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
  /\b[0-9a-f]{64}\b/g,
];

/**
 * Turns anything throwable into a short single-line string that cannot carry a
 * credential, a session hash, or a connection string. Used for server logs
 * only — the browser gets {@link ErrorEnvelope}, which has no diagnostic field.
 */
export function redactDiagnostic(value: unknown, maxLength = 300): string {
  let text: string;
  if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = "[unserializable]";
    }
  }
  text = text.replace(/[\r\n\t]+/g, " ");
  for (const shape of SECRET_SHAPES) {
    text = text.replace(shape, "[redacted]");
  }
  // Strip anything that looks like a URL with credentials or a host we would
  // rather not echo back into a log line.
  text = text.replace(/https?:\/\/[^\s"']+/g, "[url]");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const FACTORY = {
  originRequired: () =>
    new AppError({
      code: ERROR_CODES.ORIGIN_REQUIRED,
      status: 403,
      publicMessage: "This request did not identify where it came from.",
      retryable: false,
    }),
  originMismatch: () =>
    new AppError({
      code: ERROR_CODES.ORIGIN_MISMATCH,
      status: 403,
      publicMessage: "This request came from another site.",
      retryable: false,
    }),
  contentType: () =>
    new AppError({
      code: ERROR_CODES.CONTENT_TYPE_UNSUPPORTED,
      status: 415,
      publicMessage: "This endpoint accepts application/json only.",
      retryable: false,
    }),
  bodyTooLarge: (limitBytes: number) =>
    new AppError({
      code: ERROR_CODES.BODY_TOO_LARGE,
      status: 413,
      publicMessage: `This request is larger than the ${limitBytes}-byte limit.`,
      retryable: false,
    }),
  bodyMalformed: () =>
    new AppError({
      code: ERROR_CODES.BODY_MALFORMED,
      status: 400,
      publicMessage: "This request body is not valid JSON.",
      retryable: false,
    }),
  validationFailed: (diagnostic?: unknown) =>
    new AppError({
      code: ERROR_CODES.VALIDATION_FAILED,
      status: 422,
      publicMessage: "Some details in this request are not acceptable.",
      retryable: false,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    }),
  refused: (publicMessage: string) =>
    new AppError({
      code: ERROR_CODES.REQUEST_REFUSED,
      status: 422,
      publicMessage,
      retryable: false,
    }),
  sessionRequired: () =>
    new AppError({
      code: ERROR_CODES.SESSION_REQUIRED,
      status: 401,
      publicMessage: "Start a session before creating or opening a project.",
      retryable: false,
    }),
  /** The single answer for nonexistent, foreign, and malformed project ids. */
  notFound: () =>
    new AppError({
      code: ERROR_CODES.NOT_FOUND,
      status: 404,
      publicMessage: "No project is available at this address.",
      retryable: false,
    }),
  rateLimited: (publicMessage: string) =>
    new AppError({
      code: ERROR_CODES.RATE_LIMITED,
      status: 429,
      publicMessage,
      retryable: true,
    }),
  budgetExhausted: (publicMessage: string) =>
    new AppError({
      code: ERROR_CODES.BUDGET_EXHAUSTED,
      status: 429,
      publicMessage,
      retryable: true,
    }),
  persistenceUnavailable: (diagnostic?: unknown) =>
    new AppError({
      code: ERROR_CODES.PERSISTENCE_UNAVAILABLE,
      status: 503,
      publicMessage:
        "Saving is unavailable right now. The saved example still plays without a database.",
      retryable: true,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    }),
  internal: (diagnostic?: unknown) =>
    new AppError({
      code: ERROR_CODES.INTERNAL,
      status: 500,
      publicMessage: "Something went wrong on our side.",
      retryable: true,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    }),
} as const;

export const appErrors = FACTORY;

export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Logs one redacted server-side line. Nothing here is a secret: the request id
 * correlates a browser report with this line, and the diagnostic has already
 * passed through {@link redactDiagnostic}.
 */
export function logServerError(requestId: string, error: AppError): void {
  if (error.status < 500 && error.code !== ERROR_CODES.PERSISTENCE_UNAVAILABLE) return;
  const detail = error.diagnostic === undefined ? "" : ` detail=${error.diagnostic}`;
  console.warn(`[firstplayable] request_id=${requestId} code=${error.code}${detail}`);
}

export function toAppError(error: unknown): AppError {
  return error instanceof AppError ? error : FACTORY.internal(error);
}

export function errorEnvelope(
  error: AppError,
  requestId: string,
  lastGoodVersionId: string | null = null,
): ErrorEnvelope {
  return {
    code: error.code,
    message: error.publicMessage,
    retryable: error.retryable,
    last_good_version_id: lastGoodVersionId,
    request_id: requestId,
  };
}

export function errorResponse(
  error: unknown,
  requestId: string,
  lastGoodVersionId: string | null = null,
): Response {
  const appError = toAppError(error);
  logServerError(requestId, appError);
  return Response.json(errorEnvelope(appError, requestId, lastGoodVersionId), {
    status: appError.status,
    headers: {
      "x-request-id": requestId,
      "cache-control": "no-store",
    },
  });
}
