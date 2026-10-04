/**
 * The one explicit, opt-in real proposal-and-approval smoke run.
 *
 *   RUN_PROPOSAL_SMOKE=1 npm run smoke:proposal
 *
 * It is never part of `npm test`, never part of `npm run build`, never part of
 * CI, and never runs during deployment. Without the guard it exits with
 * instructions and makes no request at all.
 *
 * It drives the **real route handlers** — the same functions the deployed
 * runtime calls — against the real Supabase project, the real Qloo captures,
 * and one real `gpt-4o-mini-2024-07-18` request:
 *
 *   session → project → artist search → explicit anchor confirmation →
 *   first-hop references → one bounded proposal call → one explicit approval
 *
 * It then re-reads the project and checks what the creator would actually see:
 * zero approvals before the decision, exactly one after it, a three-layer
 * provenance chain with no fourth layer, and a compiler-facing payload that
 * carries only the approved influence's own evidence.
 *
 * One proposal call. It is never re-rolled because the result reads weakly:
 * that would turn a smoke test into prompt tuning, and the point here is that
 * the bounded call works, not that its prose is good.
 */

import { formatMicrosUsd } from "../src/server/db/budgets";
import type { Brief } from "../src/domain/brief";
import type {
  DecisionsResponse,
  ProjectView,
  ProposalsResponse,
  ReferencesResponse,
} from "../src/domain/project";
import { ConfigError, PINNED_CHAT_MODEL, qlooConfig, qlooEnv } from "../src/server/config";
import { livePhase3Deps, type Phase3Deps } from "../src/server/api/deps";
import { handleCreateProject, handleReadProject } from "../src/server/api/projects";
import { handleCreateSession } from "../src/server/api/session";
import { handleDecisions } from "../src/server/api/decisions";
import { handleProposals } from "../src/server/api/proposals";
import {
  handleArtistSearch,
  handleConfirmAnchor,
  handleReferences,
} from "../src/server/api/qloo";
import { estimateUsdCost, openAiClient, type ResponsesClient } from "../src/server/model/openai";
import { buildApprovedInfluencePayloads } from "../src/server/influence/payload";
import { readCapturesByIds } from "../src/server/qloo/cache";
import { captureIdsForApprovals } from "../src/server/influence/provenance";
import { proposalDraftOf, resolveApprovals } from "../src/server/influence/approvals";
import { readProjectForOwner } from "../src/server/db/projects";
import { requireOwnerSession } from "../src/server/db/sessions";
import { OWNER_COOKIE_NAME } from "../src/server/security/session";

const GUARD = "RUN_PROPOSAL_SMOKE";

/** A local origin, so the handlers' real same-origin check runs unchanged. */
const ORIGIN = "http://localhost:3000";

const CANONICAL_ARTIST = "Radiohead";

/** The canonical brief of specification section 15. */
const BRIEF: Brief = {
  title: "The Second Copy",
  premise:
    "At a station's lost-property counter, just before closing, Nia asks you to return the sealed letter she left earlier. You are the attendant. Decide what to ask, whether to promise its return, and whether to give it back.",
  player_role: "Station attendant",
  room: {
    id: "counter",
    name: "Lost-property counter",
    description: "The station is closing. One letter is still behind the counter.",
  },
  character: { id: "nia", name: "Nia", role: "Visitor asking for her letter" },
  object: {
    id: "letter",
    name: "Sealed letter",
    description: "One envelope, left behind earlier today, still sealed.",
  },
  tone: "intimate",
  cultural_anchor_query: null,
  forbidden_wording: [],
};

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

function note(line: string): void {
  console.log(`      ${line}`);
}

function loadEnvFile(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Already-exported variables are fine.
  }
}

function mutation(path: string, cookie: string | null, body: unknown, method = "POST"): Request {
  const headers = new Headers({ origin: ORIGIN, "content-type": "application/json" });
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method, headers, body: JSON.stringify(body) });
}

function read(path: string, cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
}

async function json<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

/** Counts Qloo requests, so "this run cost N calls" is measured. */
function countingFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return globalThis.fetch(input as RequestInfo, init);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/** The real pinned client, wrapped only to count the requests it makes. */
function countingModelClient(): { client: ResponsesClient; count: () => number } {
  const inner = openAiClient();
  let calls = 0;
  return {
    count: () => calls,
    client: {
      responses: {
        parse: (body) => {
          calls += 1;
          return inner.responses.parse(body);
        },
      },
    },
  };
}

async function main(): Promise<number> {
  if (process.env[GUARD] !== "1") {
    console.log(
      [
        "smoke:proposal did not run, and made no request.",
        "",
        "This command spends one real model call on the pinned snapshot, and",
        "writes one real project, so it is opt-in:",
        "",
        `  ${GUARD}=1 npm run smoke:proposal`,
        "",
        "Run `RUN_QLOO_SMOKE=1 npm run smoke:qloo` first so the Qloo captures are",
        "already stored; this run then costs zero Qloo calls. Do not loop it.",
      ].join("\n"),
    );
    return 0;
  }

  loadEnvFile();

  try {
    qlooEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`smoke:proposal FAILED — ${error.message}`);
      return 1;
    }
    throw error;
  }

  const qloo = countingFetch();
  const model = countingModelClient();
  const base = livePhase3Deps();
  const deps: Phase3Deps = { ...base, fetchImpl: qloo.fetchImpl, modelClient: model.client };

  console.log("smoke:proposal");
  console.log(`  model             ${PINNED_CHAT_MODEL}`);
  console.log(`  qloo host         ${qlooEnv().host}`);
  console.log(`  spend cap         ${formatMicrosUsd(deps.budget().modelCostCapMicros)} cumulative`);
  console.log(`  qloo launch gap   ${qlooConfig().launchSpacingMs} ms`);
  console.log("");

  // -------------------------------------------------------------------------
  // 1. Session and project, through the real routes
  // -------------------------------------------------------------------------

  const sessionResponse = await handleCreateSession(mutation("/api/session", null, {}), deps);
  await json<unknown>(sessionResponse, "POST /api/session");
  const setCookie = sessionResponse.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  check("an anonymous owner session was established", cookie.startsWith(`${OWNER_COOKIE_NAME}=`));
  check("the owner cookie is HttpOnly", setCookie.includes("HttpOnly"));

  const created = await json<{ project: ProjectView }>(
    await handleCreateProject(mutation("/api/projects", cookie, { brief: BRIEF }), deps),
    "POST /api/projects",
  );
  const projectId = created.project.id;
  note(`project ${projectId}`);
  check("the new project has no approvals", created.project.approvals.length === 0);
  check("and no confirmed anchor", !created.project.anchor_confirmed);

  // -------------------------------------------------------------------------
  // 2. Artist search and explicit confirmation
  // -------------------------------------------------------------------------

  const searched = await json<{
    search: { capture_id: string | null; cache: string; candidates: { entity_id: string; name: string; original_rank: number }[] };
    project: ProjectView;
  }>(
    await handleArtistSearch(
      mutation(`/api/projects/${projectId}/artist-search`, cookie, { query: CANONICAL_ARTIST }),
      deps,
      projectId,
    ),
    "POST artist-search",
  );
  note(`artist search cache: ${searched.search.cache}, ${searched.search.candidates.length} candidates`);
  check(
    "searching did not confirm anything",
    !searched.project.anchor_confirmed && searched.project.revision === 1,
    `revision ${searched.project.revision}`,
  );

  const confirmedCandidate = searched.search.candidates.find(
    (candidate) => candidate.name.toLowerCase() === CANONICAL_ARTIST.toLowerCase(),
  );
  check(
    "the canonical artist is confirmable by exact name",
    confirmedCandidate !== undefined,
    confirmedCandidate === undefined ? "" : `${confirmedCandidate.name} at rank ${confirmedCandidate.original_rank}`,
  );
  if (confirmedCandidate === undefined) return finish();

  const anchored = await json<{ project: ProjectView; invalidated: boolean }>(
    await handleConfirmAnchor(
      mutation(
        `/api/projects/${projectId}/anchor`,
        cookie,
        {
          expected_revision: searched.project.revision,
          search_capture_id: searched.search.capture_id,
          entity_id: confirmedCandidate.entity_id,
        },
        "PUT",
      ),
      deps,
      projectId,
    ),
    "PUT anchor",
  );
  check(
    "the anchor is confirmed, with its rank and capture recorded",
    anchored.project.anchor?.entity_id === confirmedCandidate.entity_id &&
      anchored.project.anchor?.search_capture_id === searched.search.capture_id,
    `${anchored.project.anchor?.name} · rank ${anchored.project.anchor?.original_rank}`,
  );
  check("confirming approved nothing", anchored.project.approvals.length === 0);

  // -------------------------------------------------------------------------
  // 3. The two first hops
  // -------------------------------------------------------------------------

  const retrieved = await json<ReferencesResponse>(
    await handleReferences(
      mutation(`/api/projects/${projectId}/references`, cookie, {
        expected_revision: anchored.project.revision,
      }),
      deps,
      projectId,
    ),
    "POST references",
  );
  note(`first-hop upstream attempts: ${retrieved.upstream_calls}`);
  for (const domain of ["movie", "videogame"] as const) {
    const row = retrieved.references[domain];
    note(
      `${domain}: ${row.status}, cache ${row.cache ?? "—"}, returned ${row.returned_count}, usable ${row.usable_count}, shown ${row.displayed.length}`,
    );
    for (const candidate of row.displayed) {
      note(`  rank ${candidate.original_rank}: ${candidate.name} (${candidate.reference_id})`);
    }
  }
  check("at least one domain is usable", retrieved.references.any_usable);
  check(
    "no affinity reached the response",
    !JSON.stringify(retrieved).includes("affinity"),
  );
  check("retrieval approved nothing", retrieved.project.approvals.length === 0);

  // -------------------------------------------------------------------------
  // 4. One bounded proposal call
  // -------------------------------------------------------------------------

  const proposed = await json<ProposalsResponse>(
    await handleProposals(
      mutation(`/api/projects/${projectId}/proposals`, cookie, {
        expected_revision: retrieved.project.revision,
      }),
      deps,
      projectId,
    ),
    "POST proposals",
  );

  check("the proposal stage returned a draft", proposed.project.proposals.length > 0);
  check(
    "it used one model call, or two only if the permitted repair ran",
    proposed.model_calls >= 1 && proposed.model_calls <= 2,
    `${proposed.model_calls} calls, repaired: ${proposed.repaired}`,
  );
  check(
    "the counted provider requests match what the route reported",
    model.count() === proposed.model_calls,
    `${model.count()} observed`,
  );
  check("the draft approved nothing", proposed.project.approved_slots.length === 0);

  // Read the stored draft, which records the model identifier and the token
  // usage the provider reported. The response envelope deliberately does not
  // carry provider diagnostics, so this comes from the project row.
  const draftRow = await readProjectForOwner(
    deps.gateway(),
    await requireOwnerSession(deps.gateway(), cookie.split("=")[1] ?? null, new Date()),
    projectId,
  );
  const draft = draftRow === null ? null : proposalDraftOf(draftRow);
  check("the draft records the pinned model", draft?.model === PINNED_CHAT_MODEL, draft?.model ?? "none");
  if (draft?.usage == null) {
    note("token usage: the provider returned no usage block on this call");
  } else {
    note(
      `token usage: ${draft.usage.input_tokens} in, ${draft.usage.output_tokens} out, ${draft.usage.total_tokens} total`,
    );
    note(
      `list-price cost ESTIMATE: $${estimateUsdCost(draft.usage).toFixed(8)} (arithmetic on the tokens above, not a billed amount)`,
    );
  }
  note(`draft ${draft?.draft_id ?? "none"} · model calls ${draft?.model_calls ?? "?"} · repaired ${draft?.repaired ?? "?"}`);

  console.log("");
  for (const proposal of proposed.project.proposals) {
    note(`${proposal.proposal_id}  ${proposal.slot}  ${proposal.reference_name} (${proposal.domain})`);
    note(`  cites: ${proposal.selected_evidence_ids.join(", ")}`);
    note(`  idea: ${proposal.idea}`);
    note(`  interaction: ${proposal.intended_interaction}`);
    note(`  relevance: ${proposal.relevance}`);
  }
  console.log("");

  // Every cited evidence id must belong to the reference that cited it.
  const captureIds = proposed.project.reference_capture_ids;
  const captures = await readCapturesByIds(deps.gateway(), captureIds);
  const owned = new Map(
    captures.flatMap((capture) =>
      capture.candidates.map(
        (candidate) =>
          [candidate.reference_id, new Set(candidate.evidence.map((item) => item.id))] as const,
      ),
    ),
  );
  check(
    "every proposal cites evidence belonging to its own reference",
    proposed.project.proposals.every((proposal) =>
      proposal.selected_evidence_ids.every((id) =>
        (owned.get(proposal.reference_id) ?? new Set()).has(id),
      ),
    ),
  );
  check(
    "every proposal names a reference this application retrieved",
    proposed.project.proposals.every((proposal) => owned.has(proposal.reference_id)),
  );

  // -------------------------------------------------------------------------
  // 5. One explicit approval
  // -------------------------------------------------------------------------

  // Prefer the canonical Moon proposal when the API still returns it; the
  // first Discovery proposal otherwise. Either way this is one explicit
  // creator action, not an automatic acceptance.
  const chosen =
    proposed.project.proposals.find((proposal) => proposal.reference_name === "Moon") ??
    proposed.project.proposals.find((proposal) => proposal.slot === "discovery") ??
    proposed.project.proposals[0];
  if (chosen === undefined) {
    check("a proposal is available to approve", false);
    return finish();
  }
  note(`approving ${chosen.reference_name} into ${chosen.slot}`);

  const decided = await json<DecisionsResponse>(
    await handleDecisions(
      mutation(`/api/projects/${projectId}/decisions`, cookie, {
        expected_revision: proposed.project.revision,
        kind: "accept",
        proposal_id: chosen.proposal_id,
      }),
      deps,
      projectId,
    ),
    "POST decisions (accept)",
  );

  check("exactly one influence is approved", decided.project.approvals.length === 1);
  check(
    "it occupies the slot the creator approved",
    decided.project.approved_slots.length === 1 && decided.project.approved_slots[0] === chosen.slot,
    decided.project.approved_slots.join(","),
  );
  const approval = decided.project.approvals[0];
  check(
    "the approval froze the proposal's wording, unedited",
    approval?.approved_text === chosen.idea && approval?.edited_by_creator === false,
  );
  check("the approval is labelled a Qloo source", approval?.source_kind === "qloo");
  note(`approval ${approval?.approval_id} at revision ${decided.project.revision}`);

  // -------------------------------------------------------------------------
  // 6. Provenance, and the compiler-facing payload
  // -------------------------------------------------------------------------

  const chain = decided.project.provenance[0];
  check("the provenance chain has the three layers that exist", chain !== undefined);
  if (chain !== undefined) {
    check(
      "and no fourth layer",
      !Object.keys(chain).includes("scene_changed") &&
        !JSON.stringify(chain).includes("scene_changed"),
      Object.keys(chain).sort().join(","),
    );
    note(`Qloo retrieved: ${chain.retrieved?.reference_name} · captured ${chain.retrieved?.captured_at}`);
    note(`  rank ${chain.retrieved?.original_rank} · ${chain.retrieved?.evidence.length} cited evidence items`);
    for (const item of chain.retrieved?.evidence ?? []) note(`  ${item.field_path}`);
    note(`FirstPlayable proposed: ${chain.proposed.attribution}`);
    note(`Creator approved: edited by creator = ${chain.approved.edited_by_creator}`);
  }

  const gateway = deps.gateway();
  const session = await requireOwnerSession(gateway, cookie.split("=")[1] ?? null, new Date());
  const row = await readProjectForOwner(gateway, session, projectId);
  check("the project reads back for its owner", row !== null);
  if (row === null) return finish();

  const approvals = await resolveApprovals(gateway, session, row);
  const approvalCaptures = await readCapturesByIds(gateway, captureIdsForApprovals(approvals));
  const payloads = buildApprovedInfluencePayloads(approvals, approvalCaptures);
  check("one compiler-facing payload was built", payloads.length === 1);

  const payload = payloads[0];
  if (payload !== undefined) {
    check(
      "it carries only the approved influence's own evidence",
      payload.evidence.every((item) => item.id.startsWith(payload.reference.reference_id)) &&
        payload.evidence.length === (approval?.selected_evidence_ids.length ?? 0),
      `${payload.evidence.length} items`,
    );
    const serialized = JSON.stringify(payload);
    check(
      "it names no other reference that was retrieved",
      !captures
        .flatMap((capture) => capture.candidates)
        .filter((candidate) => candidate.reference_id !== payload.reference.reference_id)
        .some((candidate) => serialized.includes(candidate.name)),
    );
    check("it carries no artist, affinity, or capture id", !serialized.includes(CANONICAL_ARTIST) &&
      !serialized.includes("affinity") &&
      !serialized.includes("capture_id"));
  }

  // -------------------------------------------------------------------------
  // 7. Reload, and a second owner
  // -------------------------------------------------------------------------

  const reloaded = await json<{ project: ProjectView }>(
    await handleReadProject(read(`/api/projects/${projectId}`, cookie), deps, projectId),
    "GET project",
  );
  check(
    "the approval survives a fresh read",
    reloaded.project.approvals.length === 1 &&
      reloaded.project.approvals[0]?.approval_id === approval?.approval_id,
  );

  const otherSession = await handleCreateSession(mutation("/api/session", null, {}), deps);
  const otherCookie = (otherSession.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const foreign = await handleReadProject(
    read(`/api/projects/${projectId}`, otherCookie),
    deps,
    projectId,
  );
  check(
    "a second anonymous owner cannot read this project",
    foreign.status === 404,
    `status ${foreign.status}`,
  );
  const foreignBody = await foreign.text();
  check(
    "and learns nothing from the refusal",
    !foreignBody.includes(CANONICAL_ARTIST) && !foreignBody.includes("Second Copy"),
  );

  // -------------------------------------------------------------------------
  // 8. Counts
  // -------------------------------------------------------------------------

  console.log("");
  note(`Qloo upstream calls this run: ${qloo.urls.length}`);
  for (const url of qloo.urls) note(`  → ${url}`);
  note(`model calls this run: ${model.count()}`);
  note(`project revision at the end: ${reloaded.project.revision}`);
  note(`workflow state: ${reloaded.project.workflow_state}`);

  return finish();
}

function finish(): number {
  console.log("");
  console.log(failures === 0 ? "smoke:proposal OK" : `smoke:proposal FAILED (${failures})`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`smoke:proposal FAILED — ${error instanceof Error ? error.name : "unknown"}`);
    if (error instanceof Error) console.error(`  ${error.message}`);
    process.exitCode = 1;
  },
);
