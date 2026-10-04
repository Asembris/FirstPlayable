/**
 * `POST /api/projects/:id/proposals` (specification section 11).
 *
 * This is a **bounded proposal operation**, not an arbitrary prompt endpoint.
 * The request body carries one field — the revision the creator is acting
 * against. It carries no prompt, no instructions, no model name, no
 * temperature, no reference list, and no evidence. All of those come from the
 * server's own frozen state:
 *
 *   * the brief, from the project row;
 *   * the eligible references, from the immutable captures the project points
 *     at, filtered by the server's own usability rule;
 *   * the instructions, from a constant in `influence/proposals.ts`.
 *
 * Three safety properties the handler is built around:
 *
 *   * **Idempotency.** The stage key is derived from the frozen inputs, so a
 *     double-clicked button, a browser retry, and a resumed page all arrive
 *     with the same key. A replay returns the committed draft and makes no
 *     second model call.
 *   * **The budget is reserved before the call and reconciled after.** The
 *     phase 2 primitives are used as they are; nothing here bypasses the cap.
 *   * **A draft is not an approval.** On success the project's
 *     `active_approvals` is untouched, which is why the default approved count
 *     is zero.
 */

import { ProposalsRequestSchema, type ProposalsResponse } from "@/domain/project";
import {
  budgetExhaustedMessage,
  modelCallRecord,
  recordModelCall,
  reconcileModelCall,
  releaseModelCall,
  reserveModelCall,
} from "../db/budgets";
import { readProjectViewForOwner } from "../db/projects";
import { refreshOwnerActivity, requireOwnerSession } from "../db/sessions";
import { reserveStage, settleStage } from "../db/operations";
import { proposalDraftOf } from "../influence/approvals";
import {
  prepareProposalStage,
  runProposalStage,
} from "../influence/proposals";
import { estimateUsdCostMicros, ModelError } from "../model/openai";
import { readCapturesByIds } from "../qloo/cache";
import { appErrors, errorResponse, newRequestId } from "../security/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  CREATOR_COMMAND_BODY_LIMIT_BYTES,
  readJsonBody,
} from "../security/request";
import { readOwnerSecret } from "../security/session";
import type { Phase3Deps } from "./deps";
import { anchorEntityIdOf } from "./qloo";
import { parseProjectId, requireProject, validateBody } from "./shared";

export async function handleProposals(
  request: Request,
  deps: Phase3Deps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const raw = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    const input = validateBody(ProposalsRequestSchema, raw);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const id = parseProjectId(projectId);
    const row = await requireProject(gateway, session, id);

    if (row.revision !== input.expected_revision) {
      throw appErrors.rateLimited(
        `Your choices changed while this request was in flight. Reload: the project is now at revision ${row.revision}.`,
      );
    }

    const anchorEntityId = anchorEntityIdOf(row.anchor);
    if (anchorEntityId === null) {
      throw appErrors.validationFailed("confirm an artist before asking for proposals");
    }

    const brief = (await readProjectViewForOwner(gateway, session, row)).brief;

    // The eligible set comes from the stored captures, never from the request.
    const captures = await readCapturesByIds(gateway, row.reference_capture_ids);
    const prepared = prepareProposalStage({ brief, captures, anchorEntityId });

    if (prepared.eligible.length === 0) {
      throw appErrors.validationFailed(
        "no retrieved reference has usable context, so there is nothing to interpret",
      );
    }

    // One reservation per frozen stage input. A retry replays it.
    const reservation = await reserveStage(gateway, session, {
      projectId: id,
      stage: "proposals",
      inputRevision: row.revision,
      inputHash: prepared.inputHash,
    });

    switch (reservation.outcome) {
      case "not_found":
        throw appErrors.notFound();
      case "lease_held":
        throw appErrors.rateLimited(
          "This project already has a step in progress. Wait for it to finish.",
        );
      case "attempts_exhausted":
        throw appErrors.rateLimited(
          "The proposal step used its attempts for these references. Retrieve again or edit the brief.",
        );
      case "settled": {
        // The committed result, replayed. No model call is made.
        const draft = proposalDraftOf(row);
        if (draft === null) {
          throw appErrors.rateLimited(
            "This proposal step has already finished for these references.",
          );
        }
        const project = await readProjectViewForOwner(gateway, session, row);
        const response: ProposalsResponse = {
          project,
          model_calls: 0,
          repaired: draft.repaired,
          replayed: true,
        };
        return json(response, requestId);
      }
      case "reserved":
        break;
    }

    const operationId = reservation.operation.id;
    const config = deps.budget();
    let modelCalls = 0;
    /**
     * The model-budget lease held between `beforeCall` and `afterCall`.
     *
     * Request-local on purpose: two concurrent requests in one warm instance
     * must not be able to see or release each other's reservation.
     */
    let pendingLease: string | null = null;

    try {
      const result = await runProposalStage(
        { brief, captures, anchorEntityId },
        prepared,
        {
          ...(deps.modelClient === undefined ? {} : { client: deps.modelClient }),
          now: () => now,
          beforeCall: async () => {
            // Reserve conservatively before each attempt, including the repair.
            const budget = await reserveModelCall(gateway, config, { now });
            if (!budget.granted) {
              throw appErrors.budgetExhausted(budgetExhaustedMessage(budget.call_limit));
            }
            pendingLease = budget.lease_id;
          },
          afterCall: async (outcome) => {
            modelCalls += 1;
            const lease = pendingLease;
            pendingLease = null;
            if (lease === null) return;
            const costMicros = estimateUsdCostMicros(outcome.usage);
            recordModelCall(
              modelCallRecord({
                stage: "proposals",
                attempt: outcome.attempt,
                model: outcome.model,
                usage: outcome.usage,
                costMicros,
                latencyMs: outcome.latencyMs,
              }),
            );
            await reconcileModelCall(gateway, lease, {
              costMicros,
              tokens: outcome.usage?.total_tokens ?? 0,
            });
          },
        },
      );

      const update = await gateway.setProjectProposalDraft({
        projectId: id,
        ownerSessionId: session.id,
        expectedRevision: row.revision,
        anchorEntityId,
        draft: result.draft,
      });

      if (update.outcome !== "updated") {
        // The creator's choices moved. The result stays an operation artifact
        // and cannot become the project's current draft.
        await settleStage(gateway, session, operationId, {
          status: "failed",
          error: { code: "STALE_RESULT", outcome: update.outcome },
        });
        throw appErrors.rateLimited(
          "Your choices changed while the proposals were being written, so this result was not applied.",
        );
      }

      await settleStage(gateway, session, operationId, {
        status: "succeeded",
        result: {
          draft_id: result.draft.draft_id,
          proposals: result.draft.proposals.length,
          model_calls: result.modelCalls,
          repaired: result.repaired,
        },
      });

      const refreshed = await requireProject(gateway, session, id);
      const project = await readProjectViewForOwner(gateway, session, refreshed);
      const response: ProposalsResponse = {
        project,
        model_calls: result.modelCalls,
        repaired: result.repaired,
        replayed: false,
      };
      return json(response, requestId);
    } catch (cause) {
      if (pendingLease !== null) {
        // The attempt never reached the provider. Release without usage.
        await releaseModelCall(gateway, pendingLease);
        pendingLease = null;
      }
      await settleStage(gateway, session, operationId, {
        status: "failed",
        error: {
          code: cause instanceof ModelError ? cause.code : "PROPOSALS_FAILED",
          model_calls: modelCalls,
        },
      });
      throw toPublicError(cause);
    }
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

/** Maps a model failure to the frozen envelope, with no provider detail. */
function toPublicError(error: unknown): unknown {
  if (!(error instanceof ModelError)) return error;
  switch (error.code) {
    case "MODEL_REQUEST_TOO_LARGE":
      return appErrors.validationFailed("this request is larger than the stage allows");
    case "MODEL_REFUSED":
      return appErrors.rateLimited(
        "The interpretation step declined this brief. Edit the brief or try another reference.",
      );
    default:
      return appErrors.rateLimited(
        "The interpretation step did not return a usable result. Your references and approvals are unchanged.",
      );
  }
}

function json(body: ProposalsResponse, requestId: string): Response {
  return Response.json(body, {
    status: 200,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}
