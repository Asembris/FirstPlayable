import { domainAuditionView } from '@/domain/audition-result';
/**
 * The comp audition's two routes:
 *
 * ```text
 * POST /api/audition/interpret   creator sentence -> agent slot edits -> Qloo searches
 * POST /api/audition/score       confirmed slots  -> Qloo insights    -> deterministic A/B
 * ```
 *
 * Both run the same gauntlet as every earlier creator route before anything
 * else: Origin, content type, body cap, the authoritative Zod contract, then
 * the anonymous owner session. Neither is a model proxy or a Qloo proxy: the
 * model sees only the sentence and the slot list, and the only Qloo requests
 * either route can cause are the frozen shapes in `src/server/qloo/client.ts`.
 *
 * The authority chain the score route enforces:
 *
 *   * A comp or audience is scored only if the creator confirmed it, and only
 *     if the confirmed entity id is one of the results in the stored search
 *     capture the slot names. A forged id, a forged capture id, a capture of
 *     the wrong kind, or a capture of the wrong domain is refused.
 *   * Every displayed name is copied from that capture, never from the body.
 *   * Every affinity is read from a stored insights capture, and ordering,
 *     closeness, and reversals come from `compareAudiences` alone.
 *
 * Task state lives in the request, not in the database: there are no
 * accounts, projects, or saved auditions in this slice. What persists is the
 * immutable Qloo evidence in `qloo_captures`, which is also the cache.
 */

import {
  type AuditionSlot,
  type AuditionState,
  type InterpretResponse,
  InterpretRequestSchema,
  ScoreRequestSchema,
  type SlotSearchView,
} from "@/domain/audition";
import {
  AuditionDomainError,
} from "@/domain/audition-compare";
import type {
  ConfirmedEntityView,
  ScoreResponse,
} from "@/domain/audition-view";
import {
  type ArtistSearchSnapshot,
  QLOO_DOMAINS,
  type QlooDomain,
} from "@/domain/qloo";
import type { CompScoreCapture, CompSearchSnapshot } from "@/domain/audition";
import { applyPlan, planEdits } from "../audition/agent";
import {
  budgetExhaustedMessage,
  modelCallRecord,
  reconcileModelCall,
  recordModelCall,
  releaseModelCall,
  reserveModelCall,
} from "../db/budgets";
import type { DataGateway } from "../db/gateway";
import { refreshOwnerActivity, requireOwnerSession } from "../db/sessions";
import { estimateUsdCostMicros, ModelError, type StructuredResult } from "../model/openai";
import {
  compScoreFingerprint,
  compSearchFingerprint,
  readCompScoreCache,
  readCompSearchById,
  readCompSearchCache,
  writeCompScoreCapture,
  writeCompSearchCapture,
} from "../qloo/audition";
import {
  readArtistSearchById,
  readArtistSearchCache,
  writeArtistSearchCapture,
} from "../qloo/cache";
import {
  MAX_ATTEMPTS_PER_CALL,
  QlooError,
  type QlooClientDeps,
  resolveArtist,
  scoreComps,
  searchComps,
} from "../qloo/client";
import {
  databaseLaunchGuard,
  observedQuotaWithinReserve,
  reconcileQlooCalls,
  reserveQlooCalls,
} from "../qloo/limiter";
import { artistSearchFingerprint, normalizeQuery } from "../qloo/normalize";
import { appErrors, errorResponse, newRequestId } from "../security/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  CREATOR_COMMAND_BODY_LIMIT_BYTES,
  readJsonBody,
} from "../security/request";
import { readOwnerSecret } from "../security/session";
import type { AgentPlan } from "../audition/agent";
import type { Phase3Deps } from "./deps";
import { toPublicError as toPublicQlooError } from "./qloo";
import { validateBody } from "./shared";

type Context = {
  gateway: DataGateway;
  deps: Phase3Deps;
  now: Date;
};

async function openContext(request: Request, deps: Phase3Deps): Promise<{ context: Context; body: unknown }> {
  assertSameOrigin(request);
  assertJsonContentType(request);
  const body = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
  const gateway = deps.gateway();
  const now = deps.now?.() ?? new Date();
  return { context: { gateway, deps, now }, body };
}

async function requireSession(context: Context, request: Request): Promise<void> {
  const session = await requireOwnerSession(context.gateway, readOwnerSecret(request), context.now);
  await refreshOwnerActivity(context.gateway, session, context.now);
}

function clientDeps(context: Context): QlooClientDeps {
  const { deps, gateway, now } = context;
  const config = deps.qloo();
  return {
    env: deps.qlooEnv(),
    launch: deps.launchGuard?.(gateway, config) ?? databaseLaunchGuard(gateway, config),
    now: () => now,
    onQuota: (quota) => {
      if (observedQuotaWithinReserve(quota, config)) deps.onReserveReached?.();
    },
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };
}

/**
 * Runs upstream work under one quota reservation sized for the worst case,
 * then reconciles what was actually spent, failures included.
 */
async function withQlooQuota<T>(
  context: Context,
  jobs: readonly (() => Promise<{ value: T; attempts: number }>)[],
): Promise<{ results: PromiseSettledResult<T>[]; spent: number }> {
  if (jobs.length === 0) return { results: [], spent: 0 };
  const reservation = await reserveQlooCalls(context.gateway, context.deps.qloo(), {
    calls: jobs.length * MAX_ATTEMPTS_PER_CALL,
    now: context.now,
  });
  if (!reservation.granted) {
    throw appErrors.budgetExhausted(
      "This application is holding back its remaining Qloo calls as a reserve. " +
        "Retrieval is paused until the window resets.",
    );
  }
  let spent = 0;
  try {
    // One at a time: the global limiter allows two in flight across every
    // instance, and a burst from one request would only queue against it.
    const settled: PromiseSettledResult<T>[] = [];
    for (const job of jobs) {
      try {
        const { value, attempts } = await job();
        spent += attempts;
        settled.push({ status: "fulfilled", value });
      } catch (cause) {
        if (cause instanceof QlooError) spent += cause.attempts;
        settled.push({ status: "rejected", reason: cause });
      }
    }
    return { results: settled, spent };
  } finally {
    await reconcileQlooCalls(context.gateway, reservation.lease_id, spent);
  }
}

// ---------------------------------------------------------------------------
// POST /api/audition/interpret
// ---------------------------------------------------------------------------

function artistView(slot: AuditionSlot, snapshot: ArtistSearchSnapshot): SlotSearchView {
  return {
    slot_id: slot.slot_id,
    kind: slot.kind,
    search_capture_id: snapshot.capture_id,
    retrieved_at: snapshot.retrieved_at,
    cache: snapshot.cache,
    candidates: snapshot.candidates.map((candidate) => ({
      entity_id: candidate.entity_id,
      name: candidate.name,
      hint:
        candidate.disambiguation !== null && candidate.disambiguation !== candidate.name
          ? candidate.disambiguation
          : candidate.short_description === null
            ? null
            : candidate.short_description.slice(0, 140),
      original_rank: candidate.original_rank,
    })),
  };
}

function compView(slot: AuditionSlot, snapshot: CompSearchSnapshot): SlotSearchView {
  return {
    slot_id: slot.slot_id,
    kind: slot.kind,
    search_capture_id: snapshot.capture_id,
    retrieved_at: snapshot.retrieved_at,
    cache: snapshot.cache,
    candidates: snapshot.candidates.map((candidate) => ({
      entity_id: candidate.entity_id,
      name: candidate.name,
      hint: candidate.year !== null ? String(candidate.year) : candidate.disambiguation,
      original_rank: candidate.original_rank,
    })),
  };
}

type SearchOutcome = { slot: AuditionSlot; view: SlotSearchView };

/**
 * Searches Qloo for every slot that has not been searched yet. A cached
 * capture costs nothing; a failed search leaves its slot unsearched and is
 * reported, while the others still return.
 */
async function searchSlots(
  context: Context,
  state: AuditionState,
): Promise<{ state: AuditionState; searches: SlotSearchView[]; failures: string[]; upstream: number }> {
  const env = context.deps.qlooEnv();
  const pending = state.slots.filter((slot) => slot.search_capture_id === null);
  const done: SearchOutcome[] = [];
  const misses: AuditionSlot[] = [];

  for (const slot of pending) {
    const normalizedQuery = normalizeQuery(slot.query);
    if (slot.kind === "audience") {
      const fingerprint = artistSearchFingerprint({ host: env.host, normalizedQuery });
      const hit = await readArtistSearchCache(context.gateway, fingerprint, context.now);
      if (hit === null) misses.push(slot);
      else done.push({ slot, view: artistView(slot, hit) });
    } else {
      const fingerprint = compSearchFingerprint({ host: env.host, domain: slot.kind, normalizedQuery });
      const hit = await readCompSearchCache(context.gateway, fingerprint, context.now);
      if (hit === null) misses.push(slot);
      else done.push({ slot, view: compView(slot, hit) });
    }
  }

  const client = misses.length === 0 ? null : clientDeps(context);
  const { results, spent } = await withQlooQuota(
    context,
    misses.map((slot) => async () => {
      if (slot.kind === "audience") {
        const result = await resolveArtist(slot.query, client!);
        const stored = await writeArtistSearchCapture(context.gateway, result.snapshot, result.diagnostics.quota, context.now);
        return { value: { slot, view: artistView(slot, stored) }, attempts: result.diagnostics.attempts };
      }
      const result = await searchComps(slot.kind, slot.query, client!);
      const stored = await writeCompSearchCapture(context.gateway, result.snapshot, result.diagnostics.quota, context.now);
      return { value: { slot, view: compView(slot, stored) }, attempts: result.diagnostics.attempts };
    }),
  );

  const failures: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") done.push(result.value);
    else {
      const code = result.reason instanceof QlooError ? result.reason.code : "QLOO_SEARCH_FAILED";
      failures.push(`The Qloo search for "${misses[index]!.query}" failed (${code}). Try again.`);
    }
  });

  const captured = new Map(done.map((outcome) => [outcome.slot.slot_id, outcome.view.search_capture_id]));
  const slots = state.slots.map((slot) =>
    captured.has(slot.slot_id) ? { ...slot, search_capture_id: captured.get(slot.slot_id) ?? null } : slot,
  );
  const order = new Map(state.slots.map((slot, index) => [slot.slot_id, index]));
  const searches = done
    .map((outcome) => outcome.view)
    .sort((a, b) => (order.get(a.slot_id) ?? 0) - (order.get(b.slot_id) ?? 0));

  return { state: { slots }, searches, failures, upstream: spent };
}

/**
 * One reserved, reconciled planning call. The reservation is taken before the
 * request is sent and settled whatever happens, as in the proposals route.
 */
async function runAgent(context: Context, message: string, state: AuditionState): Promise<AgentPlan> {
  const config = context.deps.budget();
  const reservation = await reserveModelCall(context.gateway, config, { now: context.now });
  if (!reservation.granted) throw appErrors.budgetExhausted(budgetExhaustedMessage(reservation.call_limit));

  const startedAt = Date.now();
  let result: StructuredResult<AgentPlan> | null = null;
  try {
    result = await planEdits(message, state, context.deps.modelClient === undefined ? {} : { client: context.deps.modelClient });
    return result.data;
  } finally {
    if (result !== null) {
      const costMicros = estimateUsdCostMicros(result.usage);
      recordModelCall(
        modelCallRecord({
          stage: "audition_plan",
          attempt: 1,
          model: result.model,
          usage: result.usage,
          costMicros,
          latencyMs: Date.now() - startedAt,
        }),
      );
      await reconcileModelCall(context.gateway, reservation.lease_id, {
        costMicros,
        tokens: result.usage?.total_tokens ?? 0,
      });
    } else {
      // No usable result, so no usage was reported to price. The reservation
      // is released with nothing recorded, as the earlier routes do.
      await releaseModelCall(context.gateway, reservation.lease_id);
    }
  }
}

export async function handleInterpret(request: Request, deps: Phase3Deps): Promise<Response> {
  const requestId = newRequestId();
  try {
    const { context, body } = await openContext(request, deps);
    const input = validateBody(InterpretRequestSchema, body);
    await requireSession(context, request);

    const plan = await runAgent(context, input.message, input.state);
    const edited = applyPlan(input.state, plan);
    const searched = await searchSlots(context, edited.state);

    const response: InterpretResponse = {
      state: searched.state,
      applied: edited.applied,
      skipped: [...edited.skipped, ...searched.failures],
      clarification: plan.clarification,
      searches: searched.searches,
      model_calls: 1,
      upstream_calls: searched.upstream,
    };
    return json(response, requestId);
  } catch (error) {
    return errorResponse(toPublicError(error), requestId);
  }
}

// ---------------------------------------------------------------------------
// POST /api/audition/score
// ---------------------------------------------------------------------------

const FORGED = "A confirmed choice does not match a Qloo search this application ran. Search again and confirm a result.";

async function confirmedAudience(gateway: DataGateway, slot: AuditionSlot): Promise<ConfirmedEntityView> {
  const snapshot = slot.search_capture_id === null ? null : await readArtistSearchById(gateway, slot.search_capture_id);
  const chosen = snapshot?.candidates.find((candidate) => candidate.entity_id === slot.confirmed_entity_id);
  if (snapshot === null || snapshot.capture_id === null || chosen === undefined) throw appErrors.refused(FORGED);
  return {
    slot_id: slot.slot_id,
    entity_id: chosen.entity_id,
    name: chosen.name,
    search_capture_id: snapshot.capture_id,
    original_rank: chosen.original_rank,
  };
}

async function confirmedComp(gateway: DataGateway, slot: AuditionSlot, domain: QlooDomain): Promise<ConfirmedEntityView> {
  const snapshot = slot.search_capture_id === null ? null : await readCompSearchById(gateway, slot.search_capture_id);
  if (snapshot === null || snapshot.capture_id === null || snapshot.domain !== domain) throw appErrors.refused(FORGED);
  const chosen = snapshot.candidates.find((candidate) => candidate.entity_id === slot.confirmed_entity_id);
  if (chosen === undefined) throw appErrors.refused(FORGED);
  return {
    slot_id: slot.slot_id,
    entity_id: chosen.entity_id,
    name: chosen.name,
    search_capture_id: snapshot.capture_id,
    original_rank: chosen.original_rank,
  };
}


export async function handleScore(request: Request, deps: Phase3Deps): Promise<Response> {
  const requestId = newRequestId();
  try {
    const { context, body } = await openContext(request, deps);
    const input = validateBody(ScoreRequestSchema, body);
    await requireSession(context, request);
    const { gateway } = context;

    const audienceSlots = input.state.slots.filter((slot) => slot.kind === "audience" && slot.confirmed_entity_id !== null);
    if (audienceSlots.length !== 2) {
      throw appErrors.refused("Confirm exactly two audiences before scoring.");
    }
    const audiences = await Promise.all(audienceSlots.map((slot) => confirmedAudience(gateway, slot)));
    const [audienceA, audienceB] = audiences as [ConfirmedEntityView, ConfirmedEntityView];
    if (audienceA.entity_id === audienceB.entity_id) {
      throw appErrors.refused("The two audiences are the same artist. Confirm two different audiences.");
    }

    const compsByDomain = new Map<QlooDomain, ConfirmedEntityView[]>();
    for (const domain of QLOO_DOMAINS) {
      const slots = input.state.slots.filter((slot) => slot.kind === domain && slot.confirmed_entity_id !== null);
      if (slots.length === 0) continue;
      const comps = await Promise.all(slots.map((slot) => confirmedComp(gateway, slot, domain)));
      if (new Set(comps.map((comp) => comp.entity_id)).size !== comps.length) {
        throw appErrors.refused("The same title is confirmed twice. Remove one of them.");
      }
      compsByDomain.set(domain, comps);
    }
    if (compsByDomain.size === 0) throw appErrors.refused("Confirm at least one comp before scoring.");

    // One capture per audience per domain, cached by the exact candidate set.
    const env = deps.qlooEnv();
    type Job = { domain: QlooDomain; audience: ConfirmedEntityView; ids: string[]; fingerprint: string };
    const jobs: Job[] = [];
    for (const [domain, comps] of compsByDomain) {
      const ids = comps.map((comp) => comp.entity_id);
      for (const audience of audiences) {
        jobs.push({
          domain,
          audience,
          ids,
          fingerprint: compScoreFingerprint({ host: env.host, domain, audienceEntityId: audience.entity_id, candidateIds: ids }),
        });
      }
    }

    const captures = new Map<string, CompScoreCapture>();
    const misses: Job[] = [];
    for (const job of jobs) {
      const hit = await readCompScoreCache(gateway, job.fingerprint, context.now);
      if (hit === null) misses.push(job);
      else captures.set(job.fingerprint, hit);
    }

    const client = misses.length === 0 ? null : clientDeps(context);
    const { results, spent } = await withQlooQuota(
      context,
      misses.map((job) => async () => {
        const result = await scoreComps(
          { audienceEntityId: job.audience.entity_id, domain: job.domain, candidateEntityIds: job.ids },
          client!,
        );
        const stored = await writeCompScoreCapture(gateway, result.capture, result.diagnostics.quota, context.now);
        return { value: stored, attempts: result.diagnostics.attempts };
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      captures.set(result.value.request_fingerprint, result.value);
    }

    const domains: ScoreResponse["domains"] = { movie: null, videogame: null };
    for (const [domain, comps] of compsByDomain) {
      const capturesFor = (audience: ConfirmedEntityView): CompScoreCapture => {
        const job = jobs.find((entry) => entry.domain === domain && entry.audience.entity_id === audience.entity_id)!;
        return captures.get(job.fingerprint)!;
      };
      const view = domainAuditionView(domain, comps, [audienceA, audienceB], [capturesFor(audienceA), capturesFor(audienceB)]);
      domains[domain] = view;
    }

    const response: ScoreResponse = {
      audiences: [audienceA, audienceB],
      domains,
      unconfirmed: input.state.slots
        .filter((slot) => slot.confirmed_entity_id === null)
        .map((slot) => ({ slot_id: slot.slot_id, kind: slot.kind, query: slot.query })),
      upstream_calls: spent,
    };
    return json(response, requestId);
  } catch (error) {
    return errorResponse(toPublicError(error), requestId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPublicError(error: unknown): unknown {
  if (error instanceof QlooError) return toPublicQlooError(error);
  if (error instanceof AuditionDomainError) return appErrors.internal(error);
  if (error instanceof ModelError) {
    if (error.code === "MODEL_REQUEST_TOO_LARGE") {
      return appErrors.validationFailed("this request is larger than the planner allows");
    }
    return appErrors.rateLimited(
      "The assistant could not read that request. Your comps and audiences are unchanged. Try rephrasing it.",
    );
  }
  return error;
}

function json(body: unknown, requestId: string): Response {
  return Response.json(body, {
    status: 200,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}
