/**
 * The opt-in live probe for the consequential dilemma.
 *
 *   RUN_DILEMMA_PROBE=1 npx tsx scripts/probe-dilemma.ts
 *
 * Never part of `npm test`, the build, the browser gate, or CI. Without the
 * guard it exits and makes no request.
 *
 * It asks one question: given the **same brief** and the **same compiler**, do
 * two genuinely different Qloo-grounded cultural directions produce
 * meaningfully different dilemmas, or the same trade-off with different nouns?
 * The brief is held fixed so that culture is the only thing that varies.
 *
 * For each direction it drives the real route handlers end to end, exactly as
 * `smoke-compile.ts` does: a fresh owner session, a fresh project, an explicit
 * artist confirmation, real Qloo references, one real proposal call, one
 * creator approval, and a real compilation through the controller and the
 * Phase 1 validator. The approval rule is fixed and identical for both: the
 * first proposal the interpretation stage itself placed in the commitment
 * slot, else the first proposal, approved into the commitment slot as an
 * explicit creator choice (which the decisions route supports). The probe
 * records which of those happened.
 *
 * It then re-decides the persisted scene through the real engine and writes the
 * dilemma readout to `probes/out/` (git-ignored). It prints no key, token,
 * cookie value, connection string, or auth header.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { Brief } from "../src/domain/brief";
import type { CompilationStatus, PlayableView } from "../src/domain/compile";
import type { DecisionsResponse, ProjectView, ProposalsResponse, ReferencesResponse } from "../src/domain/project";
import type { Scene } from "../src/domain/scene";
import { cleanBase, removeModule, viewOf } from "../src/engine/compose";
import { describeDilemma } from "../src/engine/dilemma";
import { exploreScene } from "../src/engine/graph";
import { hashCanonical } from "../src/engine/hash";
import { isTrue } from "../src/engine/interpreter";
import { validateScene, validateSceneSubsets } from "../src/engine/validate";
import { ConfigError, PINNED_CHAT_MODEL, qlooEnv } from "../src/server/config";
import { livePhase3Deps, type Phase3Deps, type Phase4Deps } from "../src/server/api/deps";
import { handleCreateProject, handleReadProject } from "../src/server/api/projects";
import { handleCreateSession } from "../src/server/api/session";
import { handleDecisions } from "../src/server/api/decisions";
import { handleProposals } from "../src/server/api/proposals";
import { handleArtistSearch, handleConfirmAnchor, handleReferences } from "../src/server/api/qloo";
import { handleAdvance, handleCompile } from "../src/server/api/compile";
import { sceneApprovalAllowlist } from "../src/server/compile/assemble";
import {
  COMPILER_IDENTIFIER,
  PROMPT_IDENTIFIER,
  VALIDATOR_IDENTIFIER,
} from "../src/server/compile/identifiers";
import { openAiClient, type ResponsesClient } from "../src/server/model/openai";
import { OWNER_COOKIE_NAME } from "../src/server/security/session";

const GUARD = "RUN_DILEMMA_PROBE";
const ORIGIN = "http://localhost:3000";
const ADVANCE_CEILING = 12;
const PROPOSAL_REQUEST_ATTEMPTS = 3;

/** Two artists far apart in genre, era, and sensibility. Overridable. */
const DIRECTIONS = (process.env["DILEMMA_PROBE_ARTISTS"] ?? "Radiohead|Dolly Parton")
  .split("|")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

/** One fresh brief, used unchanged for every direction. */
const BRIEF: Brief = {
  title: "The Unclaimed Tape",
  premise:
    "At a seaside hostel's reception after midnight, Ines comes back for the cassette she left in the lost-and-found box this morning. You are the night porter. Decide what to ask, whether to promise it back, and whether to hand it over.",
  player_role: "Night porter at the hostel desk",
  room: {
    id: "reception",
    name: "Hostel reception",
    description: "One lamp on, the shutters down. The lost-and-found box sits on the counter.",
  },
  character: { id: "ines", name: "Ines", role: "Guest returning for her cassette" },
  object: {
    id: "tape",
    name: "Unlabelled cassette",
    description: "A plain cassette with no label, left in the box this morning, rewound to the start.",
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
const note = (line: string): void => console.log(`      ${line}`);

function mutation(path: string, cookie: string | null, body: unknown, method = "POST"): Request {
  const headers = new Headers({ origin: ORIGIN, "content-type": "application/json" });
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method, headers, body: JSON.stringify(body) });
}

function read(path: string, cookie: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers: new Headers({ cookie }) });
}

async function json<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

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

type Harness = { phase3: Phase3Deps; phase4: Phase4Deps; modelCalls: () => number };

/* ------------------------------------------------------------- one case */

async function runDirection(harness: Harness, artist: string): Promise<Record<string, unknown> | null> {
  console.log("");
  console.log(`--- direction: ${artist}`);
  const modelBefore = harness.modelCalls();

  // A fresh anonymous owner session for this direction alone.
  const sessionResponse = await handleCreateSession(mutation("/api/session", null, {}), harness.phase3);
  await json<unknown>(sessionResponse, "POST /api/session");
  const cookie = (sessionResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  check("a fresh owner session was established", cookie.startsWith(`${OWNER_COOKIE_NAME}=`));

  const created = await json<{ project: ProjectView }>(
    await handleCreateProject(mutation("/api/projects", cookie, { brief: BRIEF }), harness.phase3),
    "POST /api/projects",
  );
  const projectId = created.project.id;
  note(`project ${projectId}`);

  const searched = await json<{
    search: { capture_id: string | null; candidates: { entity_id: string; name: string; original_rank: number }[] };
    project: ProjectView;
  }>(
    await handleArtistSearch(
      mutation(`/api/projects/${projectId}/artist-search`, cookie, { query: artist }),
      harness.phase3,
      projectId,
    ),
    "POST artist-search",
  );
  const candidate = searched.search.candidates.find(
    (entry) => entry.name.toLowerCase() === artist.toLowerCase(),
  );
  check("the artist is confirmable by exact name", candidate !== undefined, candidate?.name ?? "none matched");
  if (candidate === undefined) return null;

  const anchored = await json<{ project: ProjectView }>(
    await handleConfirmAnchor(
      mutation(
        `/api/projects/${projectId}/anchor`,
        cookie,
        {
          expected_revision: searched.project.revision,
          search_capture_id: searched.search.capture_id,
          entity_id: candidate.entity_id,
        },
        "PUT",
      ),
      harness.phase3,
      projectId,
    ),
    "PUT anchor",
  );

  const retrieved = await json<ReferencesResponse>(
    await handleReferences(
      mutation(`/api/projects/${projectId}/references`, cookie, { expected_revision: anchored.project.revision }),
      harness.phase3,
      projectId,
    ),
    "POST references",
  );
  check("at least one reference domain is usable", retrieved.references.any_usable);

  let proposed: ProposalsResponse | null = null;
  for (let attempt = 1; attempt <= PROPOSAL_REQUEST_ATTEMPTS && proposed === null; attempt += 1) {
    const response = await handleProposals(
      mutation(`/api/projects/${projectId}/proposals`, cookie, { expected_revision: retrieved.project.revision }),
      harness.phase3,
      projectId,
    );
    if (response.ok) proposed = (await response.json()) as ProposalsResponse;
    else note(`proposal request ${attempt} failed with ${response.status}`);
  }
  check("the interpretation stage returned proposals", proposed !== null && proposed.project.proposals.length > 0);
  if (proposed === null) return null;

  const proposals = proposed.project.proposals;
  const ownCommitment = proposals.find((proposal) => proposal.slot === "commitment");
  const chosen = ownCommitment ?? proposals[0]!;
  const slotChoice = ownCommitment === undefined ? "creator placed it in commitment" : "proposed for commitment";
  note(`approving "${chosen.reference_name}" (${chosen.domain}) — ${slotChoice}`);

  const approved = await json<DecisionsResponse>(
    await handleDecisions(
      mutation(`/api/projects/${projectId}/decisions`, cookie, {
        expected_revision: proposed.project.revision,
        kind: "accept",
        proposal_id: chosen.proposal_id,
        slot: "commitment",
      }),
      harness.phase3,
      projectId,
    ),
    "POST decisions",
  );
  const approval = approved.project.approvals.find((entry) => entry.slot === "commitment");
  check("exactly one commitment approval is held", approved.project.approvals.length === 1 && approval !== undefined);
  if (approval === undefined) return null;

  const started = await json<{ status: CompilationStatus }>(
    await handleCompile(
      mutation(`/api/projects/${projectId}/compile`, cookie, { expected_revision: approved.project.revision }),
      harness.phase4,
      projectId,
    ),
    "POST compile",
  );
  let status = started.status;
  const operationId = status.operation_id;
  for (let index = 1; index <= ADVANCE_CEILING && status.next_stage !== null; index += 1) {
    const stage = status.next_stage;
    const advanced = await json<{ status: CompilationStatus }>(
      await handleAdvance(mutation(`/api/operations/${operationId}/advance`, cookie, {}), harness.phase4, operationId),
      "POST advance",
    );
    status = advanced.status;
    const entry = status.stages.find((candidate) => candidate.stage === stage);
    note(`advance ${index}: ${stage} → ${entry?.status}, attempts ${entry?.attempts}, repaired ${entry?.repaired}`);
    if (status.state === "FAILED") break;
  }
  check(
    "the compilation reached a pending review",
    status.state === "REVIEW_PLAYABLE",
    status.failure === null ? status.state : `${status.failure.code} at ${status.failure.stage}`,
  );
  if (status.state !== "REVIEW_PLAYABLE") return { artist, projectId, failure: status.failure };

  const state = await json<{ playable: PlayableView | null }>(
    await handleReadProject(read(`/api/projects/${projectId}`, cookie), harness.phase3, projectId),
    "GET project",
  );
  const playable = state.playable;
  if (playable === null) return null;
  const scene: Scene = playable.scene;

  /* --- an independent verdict through the real engine --- */

  const allow = sceneApprovalAllowlist([approval]);
  const report = validateScene(scene, BRIEF, { approvedApprovalIds: allow });
  check("the persisted scene revalidates", report.ok, report.findings.map((finding) => finding.code).join(",") || "no findings");
  check(
    "all three endings are reachable",
    (report.graph?.reachable_endings.length ?? 0) === 3,
    report.graph?.reachable_endings.join(", ") ?? "",
  );
  check("every removal subset validates", validateSceneSubsets(scene, BRIEF, { approvedApprovalIds: allow }).ok);

  const module = scene.modules.find((candidate) => candidate.slot === "commitment");
  check("the commitment module declares a dilemma", module?.dilemma !== undefined);
  const explored = exploreScene(scene);
  if (explored.ok && module?.dilemma !== undefined) {
    const view = viewOf(scene);
    const flags = module.variables.map((variable) => variable.id);
    check(
      "no reachable state holds both responses",
      explored.graph.states.every((bits) => !flags.every((flag) => isTrue(view, { bits }, flag))),
    );
    check(
      "no reachable state is a softlock",
      explored.graph.states.every((bits) => (explored.graph.endingsFrom.get(bits)?.size ?? 0) > 0),
      `${explored.graph.states.length} states`,
    );
  }
  const removed = removeModule(scene, "commitment");
  check(
    "removing the influence restores the clean foundation",
    hashCanonical(removed.core) === hashCanonical(cleanBase(scene).core) &&
      removed.modules.length === 0 &&
      validateScene(removed, BRIEF, { approvedApprovalIds: [] }).ok,
  );

  const dilemma = describeDilemma(scene);
  check("the dilemma replays to an explanation", dilemma !== null);
  if (dilemma === null || module === undefined) return null;

  const view = viewOf(scene);
  const line = (id: string | null): string | null =>
    id === null ? null : (view.dialogueById.get(id)?.node.text ?? null);
  const readout = {
    artist,
    project_id: projectId,
    reference: { name: approval.reference_name, domain: approval.domain },
    slot_choice: slotChoice,
    proposed_idea: approval.proposed_idea,
    approved_text: approval.approved_text,
    intended_effect: approval.intended_effect,
    proposed_relevance: approval.proposed_relevance,
    trade: module.dilemma?.responses.map((response) => response.secures_action_id).join(" vs "),
    tension: dilemma.tension_line,
    choice_route: dilemma.choice_prefix,
    sides: dilemma.sides.map((side) => ({
      response: side.response_label,
      response_line: side.response_line,
      secures: `${side.secures.label} → ${side.secures.ending_title} (${side.secures.status})`,
      forfeits: `${side.forfeits.label} → ${side.forfeits.ending_title} (${side.forfeits.status})`,
      forfeit_shown_as: side.forfeits.blocked_text,
      endings_after: side.endings_after,
      endings_closed: side.endings_closed,
    })),
    endings: Object.fromEntries(view.endings.map((ending) => [ending.id, ending.title])),
    gate_texts: module.gates.map((gate) => ({ on: gate.action_id, text: gate.blocked_text })),
    dialogue: module.dialogue.map((node) => ({ id: node.id, speaker: node.speaker_id, text: line(node.id) })),
    validation: {
      ok: report.ok,
      finding_codes: report.findings.map((finding) => finding.code),
      reachable_endings: report.graph?.reachable_endings ?? [],
      states: report.graph?.reachable_nonterminal_states ?? 0,
    },
    stages: status.stages.map((stage) => ({ stage: stage.stage, attempts: stage.attempts, repaired: stage.repaired })),
    model_calls: harness.modelCalls() - modelBefore,
    scene,
  };

  console.log("");
  console.log(`      reference      ${readout.reference.name} (${readout.reference.domain}) — ${slotChoice}`);
  console.log(`      approved       ${readout.approved_text}`);
  console.log(`      trade          ${readout.trade}`);
  console.log(`      tension        ${readout.tension}`);
  for (const [index, side] of readout.sides.entries()) {
    console.log(`      response ${index + 1}     ${side.response}`);
    console.log(`        says         ${side.response_line}`);
    console.log(`        secures      ${side.secures}`);
    console.log(`        forfeits     ${side.forfeits} — shown as "${side.forfeit_shown_as}"`);
    console.log(`        endings      ${side.endings_after.join(", ")} (closes ${side.endings_closed.join(", ")})`);
  }
  console.log(`      model calls    ${readout.model_calls}`);
  return readout;
}

async function main(): Promise<number> {
  if (process.env[GUARD] !== "1") {
    console.log(`probe-dilemma did not run and made no request. Opt in with ${GUARD}=1.`);
    return 0;
  }
  try {
    process.loadEnvFile(".env");
  } catch {
    // Already-exported variables are fine.
  }
  try {
    qlooEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`probe-dilemma FAILED — ${error.message}`);
      return 1;
    }
    throw error;
  }

  const model = countingModelClient();
  const base = livePhase3Deps();
  const harness: Harness = {
    phase3: { ...base, modelClient: model.client },
    phase4: { gateway: base.gateway, budget: base.budget, modelClient: model.client },
    modelCalls: () => model.count(),
  };
  console.log("probe-dilemma");
  console.log(`  model       ${PINNED_CHAT_MODEL}`);
  console.log(`  compiler    ${COMPILER_IDENTIFIER} · ${PROMPT_IDENTIFIER} · ${VALIDATOR_IDENTIFIER}`);
  console.log(`  directions  ${DIRECTIONS.join(" | ")}`);

  const readouts: Record<string, unknown>[] = [];
  for (const artist of DIRECTIONS) {
    const readout = await runDirection(harness, artist);
    if (readout !== null) readouts.push(readout);
  }

  mkdirSync("probes/out", { recursive: true });
  const path = `probes/out/dilemma-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(
    path,
    JSON.stringify(
      { model: PINNED_CHAT_MODEL, compiler: COMPILER_IDENTIFIER, prompt: PROMPT_IDENTIFIER, validator: VALIDATOR_IDENTIFIER, brief: BRIEF, readouts },
      null,
      2,
    ),
  );
  console.log("");
  console.log(`readout written to ${path}`);
  console.log(failures === 0 ? "probe-dilemma: every structural check passed" : `probe-dilemma: ${failures} check(s) failed`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`probe-dilemma FAILED — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
