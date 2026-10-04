/**
 * The shared harness for driving the real phase 3 route handlers offline.
 *
 * It supplies the real Zod contracts, the real origin and body checks, the
 * real ownership predicates, the real cache, and the real limiter — over a
 * deterministic transport and a pinned clock. Nothing here stubs a handler or
 * a repository: a test that passes against this harness exercised the same
 * code the deployed runtime executes, minus the network.
 */

import { expect } from "vitest";
import { QLOO_FIXTURES } from "../../../fixtures/qloo";
import { SECOND_COPY_BRIEF } from "../../../fixtures/second-copy";
import type { Brief } from "../../../src/domain/brief";
import { BUDGET_DEFAULTS, QLOO_DEFAULTS } from "../../../src/server/config";
import type { BudgetConfig, QlooConfig, QlooEnv } from "../../../src/server/config";
import type { Phase3Deps } from "../../../src/server/api/deps";
import { handleCreateProject } from "../../../src/server/api/projects";
import { handleCreateSession } from "../../../src/server/api/session";
import type { ErrorEnvelope } from "../../../src/server/security/errors";
import { OWNER_COOKIE_NAME } from "../../../src/server/security/session";
import type { QlooLaunchGuard } from "../../../src/server/qloo/client";
import { databaseLaunchGuard } from "../../../src/server/qloo/limiter";
import { MemoryGateway } from "./memory-gateway";

export const ORIGIN = "https://studio.example.test";

export const QLOO_ENV: QlooEnv = {
  apiKey: "harness-key-not-a-real-credential",
  baseUrl: "https://qloo.invalid",
  host: "qloo.invalid",
};

export const T0 = new Date("2026-10-04T10:00:00.000Z");

export type ScriptedResponse = () => Response | Promise<Response>;

export type Transport = {
  fetchImpl: typeof fetch;
  /** Every request this harness saw, in order. */
  calls: { url: string; headers: Record<string, string> }[];
};

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/**
 * A transport that answers by URL shape, so a test states "a movie hop
 * returns this" rather than counting positions in a script. Any request it
 * was not told about fails loudly instead of returning something plausible.
 */
export function routedTransport(routes: {
  search?: ScriptedResponse;
  movie?: ScriptedResponse;
  videogame?: ScriptedResponse;
}): Transport {
  const calls: Transport["calls"] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url, headers });

    if (url.includes("/search?")) {
      if (routes.search === undefined) throw new Error("unexpected artist search");
      return routes.search();
    }
    if (url.includes("filter.type=urn%3Aentity%3Amovie")) {
      if (routes.movie === undefined) throw new Error("unexpected movie hop");
      return routes.movie();
    }
    if (url.includes("filter.type=urn%3Aentity%3Avideogame")) {
      if (routes.videogame === undefined) throw new Error("unexpected videogame hop");
      return routes.videogame();
    }
    throw new Error(`unroutable Qloo request: ${url}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/** The happy path: the real redacted captures for Radiohead. */
export function canonicalTransport(): Transport {
  return routedTransport({
    search: () => jsonResponse(QLOO_FIXTURES.searchRadiohead),
    movie: () => jsonResponse(QLOO_FIXTURES.moviesRadiohead),
    videogame: () => jsonResponse(QLOO_FIXTURES.videogamesRadiohead),
  });
}

// ---------------------------------------------------------------------------
// A scripted model client
// ---------------------------------------------------------------------------

export type ModelScript = {
  /** The structured value the provider "parsed". */
  parsed?: unknown;
  /** Raw text instead, so the adapter's own JSON parsing is exercised. */
  text?: string;
  model?: string;
  status?: string;
  refusal?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  /** Throw instead of answering, for the transport-failure branch. */
  throws?: Error;
};

export type ScriptedModel = {
  client: { responses: { parse: (body: Record<string, unknown>) => Promise<unknown> } };
  /** Every request body the adapter sent, so a test can inspect the payload. */
  requests: Record<string, unknown>[];
};

/**
 * A provider stand-in that replays scripted envelopes.
 *
 * It answers in the shape the real Responses API returns, so the adapter's own
 * checks — pinned model, refusal, truncation, oversize, Zod validation — all
 * run exactly as they do against the provider.
 */
export function scriptedModel(script: readonly ModelScript[]): ScriptedModel {
  const requests: Record<string, unknown>[] = [];
  let index = 0;
  return {
    requests,
    client: {
      responses: {
        parse: async (requestBody: Record<string, unknown>) => {
          requests.push(requestBody);
          const step = script[Math.min(index, script.length - 1)];
          index += 1;
          if (step === undefined) throw new Error("no scripted model response");
          if (step.throws !== undefined) throw step.throws;
          return {
            id: `resp_${index}`,
            model: step.model ?? "gpt-4o-mini-2024-07-18",
            status: step.status ?? "completed",
            output_text: step.text ?? null,
            output_parsed: step.parsed ?? null,
            output:
              step.refusal === undefined
                ? []
                : [{ type: "message", content: [{ type: "refusal", refusal: step.refusal }] }],
            usage:
              step.usage === undefined
                ? { input_tokens: 1_200, output_tokens: 320, total_tokens: 1_520 }
                : step.usage,
          };
        },
      },
    } as unknown as ScriptedModel["client"],
  };
}

export type Harness = {
  gateway: MemoryGateway;
  deps: Phase3Deps;
  transport: Transport;
  /** Present only when the harness was given a model script. */
  model: ScriptedModel | null;
  /** Launch leases granted, so a test can assert pacing and concurrency. */
  launches: string[];
  advance: (ms: number) => void;
  now: () => Date;
};

export type HarnessOptions = {
  transport?: Transport;
  qloo?: Partial<QlooConfig>;
  budget?: Partial<BudgetConfig>;
  /** Scripted provider envelopes for the proposal stage. */
  model?: readonly ModelScript[];
  /** Counts reserve-reached signals the routes emitted. */
  onReserveReached?: () => void;
};

export function harness(options: HarnessOptions = {}): Harness {
  let current = T0.getTime();
  const now = () => new Date(current);
  const advance = (ms: number) => {
    current += ms;
  };

  const gateway = new MemoryGateway();
  gateway.setClock(now);

  const transport = options.transport ?? canonicalTransport();
  const config: QlooConfig = { ...QLOO_DEFAULTS, ...options.qloo };
  const budget = { ...BUDGET_DEFAULTS, ...options.budget };
  const model = options.model === undefined ? null : scriptedModel(options.model);
  const launches: string[] = [];

  const deps: Phase3Deps = {
    gateway: () => gateway,
    budget: () => budget,
    qlooEnv: () => QLOO_ENV,
    qloo: () => config,
    now,
    fetchImpl: transport.fetchImpl,
    launchGuard: (store, qlooConfig) => trackingGuard(store, qlooConfig, launches, now, advance),
    ...(model === null ? {} : { modelClient: model.client }),
    ...(options.onReserveReached === undefined
      ? {}
      : { onReserveReached: options.onReserveReached }),
  };

  return { gateway, deps, transport, model, launches, advance, now };
}

/**
 * Wraps the production launch guard so a test can see which labels were
 * granted, while the policy itself stays the real database-backed one.
 *
 * `sleep` advances the pinned clock instead of waiting, so the 250 ms gap is
 * genuinely enforced by the same code production runs and a test still
 * finishes in milliseconds.
 */
function trackingGuard(
  store: Parameters<NonNullable<Phase3Deps["launchGuard"]>>[0],
  config: QlooConfig,
  launches: string[],
  now: () => Date,
  advance: (ms: number) => void,
): QlooLaunchGuard {
  const guard = databaseLaunchGuard(store, config, {
    now,
    sleep: async (ms: number) => {
      advance(ms);
    },
  });
  return {
    acquire: async (label: string) => {
      const lease = await guard.acquire(label);
      launches.push(label);
      return lease;
    },
  };
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

export type RequestOverrides = {
  origin?: string | null;
  contentType?: string | null;
  cookie?: string | null;
  body?: string;
  method?: string;
};

export function mutation(path: string, overrides: RequestOverrides = {}): Request {
  const headers = new Headers();
  const origin = overrides.origin === undefined ? ORIGIN : overrides.origin;
  if (origin !== null) headers.set("origin", origin);
  const contentType =
    overrides.contentType === undefined ? "application/json" : overrides.contentType;
  if (contentType !== null) headers.set("content-type", contentType);
  if (overrides.cookie !== null && overrides.cookie !== undefined) {
    headers.set("cookie", overrides.cookie);
  }
  return new Request(`${ORIGIN}${path}`, {
    method: overrides.method ?? "POST",
    headers,
    body: overrides.body ?? "{}",
  });
}

export function readRequest(path: string, cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
}

export function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  expect(header).not.toBeNull();
  const value = header?.split(";")[0] ?? "";
  expect(value.startsWith(`${OWNER_COOKIE_NAME}=`)).toBe(true);
  return value;
}

export async function envelope(response: Response): Promise<ErrorEnvelope> {
  return (await response.json()) as ErrorEnvelope;
}

export async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Establishes one owner session and returns its cookie header value. */
export async function owner(harnessed: Harness): Promise<string> {
  const response = await handleCreateSession(mutation("/api/session"), harnessed.deps);
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

/** Creates one project for that owner and returns its id. */
export async function project(
  harnessed: Harness,
  cookie: string,
  brief: Brief = SECOND_COPY_BRIEF,
): Promise<string> {
  const response = await handleCreateProject(
    mutation("/api/projects", { cookie, body: JSON.stringify({ brief }) }),
    harnessed.deps,
  );
  expect(response.status).toBe(201);
  const created = await body<{ project: { id: string } }>(response);
  return created.project.id;
}
