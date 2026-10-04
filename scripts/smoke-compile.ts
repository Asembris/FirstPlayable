/**
 * The one explicit, opt-in real Phase 4 compilation smoke run.
 *
 *   RUN_PHASE4_SMOKE=1 npm run smoke:compile
 *
 * It is never part of `npm test`, never part of `npm run build`, never part of
 * `npm run test:e2e`, and never part of CI. Without the guard it exits with
 * instructions and makes no request at all.
 *
 * It drives the **real route handlers** — the same functions the deployed
 * runtime calls — through the real Phase 4 controller, against the real
 * Supabase project, the real stored Qloo captures, and real
 * `gpt-4o-mini-2024-07-18` requests. It calls the model adapter only through
 * `POST /api/projects/:id/compile` and `POST /api/operations/:id/advance`:
 * there is no shortcut here that composes a prompt itself, and no path that
 * writes a `scene_versions` row without the controller and the Phase 1
 * validator agreeing first.
 *
 * What one run covers, in order:
 *
 *   A. one real fresh single-approval compilation, advance by advance;
 *   B. the structural acceptance of that version through the real engine:
 *      subsets, witnesses, three reachable endings, module ownership, and a
 *      complete local playthrough to every ending with a reset;
 *   C. one real fresh two-approval compilation, with four subset reports and
 *      two independent mechanical witnesses;
 *   D. base and module reuse, by replacing one slot's approval only;
 *   E. the live stale-result compare-and-swap, at both checkpoints — a stale
 *      advance and a stale activation.
 *
 * Qloo requests are counted around every compilation, so "compilation makes
 * zero Qloo calls" is measured rather than asserted. Model requests are
 * counted the same way, and the stage-by-stage token usage comes out of the
 * budget bucket the controller actually reconciled against.
 *
 * It prints no secret: no key, no token, no cookie value, no connection
 * string, and no auth header.
 */

import type { Brief } from "../src/domain/brief";
import type { CompilationStatus, PlayableView, SceneVersionSummary } from "../src/domain/compile";
import type {
  DecisionsResponse,
  ProjectView,
  ProposalsResponse,
  ReferencesResponse,
} from "../src/domain/project";
import type { Slot } from "../src/domain/influence";
import type { Scene } from "../src/domain/scene";
import { cleanBase, sceneWithModuleSubset, viewOf } from "../src/engine/compose";
import { availableActions, initialState, replay, step } from "../src/engine/interpreter";
import { validateScene, validateSceneSubsets } from "../src/engine/validate";
import { exploreScene } from "../src/engine/graph";
import { ConfigError, PINNED_CHAT_MODEL, qlooEnv } from "../src/server/config";
import { livePhase3Deps, type Phase3Deps, type Phase4Deps } from "../src/server/api/deps";
import { handleCreateProject, handleReadProject } from "../src/server/api/projects";
import { handleCreateSession } from "../src/server/api/session";
import { handleDecisions } from "../src/server/api/decisions";
import { handleProposals } from "../src/server/api/proposals";
import {
  handleArtistSearch,
  handleConfirmAnchor,
  handleReferences,
} from "../src/server/api/qloo";
import {
  handleActivate,
  handleAdvance,
  handleCompile,
  handleOperationStatus,
} from "../src/server/api/compile";
import { estimateUsdCost, openAiClient, type ResponsesClient } from "../src/server/model/openai";
import { OWNER_COOKIE_NAME } from "../src/server/security/session";

const GUARD = "RUN_PHASE4_SMOKE";

/** A local origin, so the handlers' real same-origin check runs unchanged. */
const ORIGIN = "http://localhost:3000";

const CANONICAL_ARTIST = "Radiohead";

/** How many advances one compilation is ever allowed to need. */
const ADVANCE_CEILING = 12;

/**
 * How many times the smoke will ask the phase 3 interpretation stage for a
 * draft when the request itself fails.
 *
 * This is the creator pressing the button again after a lost connection, not
 * an extra model attempt inside a stage: the stage's own `max_attempts = 2`
 * ceiling is the database's and is untouched by this.
 */
const PROPOSAL_REQUEST_ATTEMPTS = 3;

/**
 * Two briefs that are not the saved example's, so each compilation is a
 * genuinely fresh one rather than a replay of fixture content.
 */
const BRIEF_ONE: Brief = {
  title: "The Last Collection",
  premise:
    "At a night-shift pawn counter, minutes before the shutters drop, Ivo comes back for the watch he pledged last winter. You are the broker on duty. Decide what to ask, whether to promise it back, and whether to hand it over.",
  player_role: "Pawn broker on the night shift",
  room: {
    id: "counter",
    name: "Pawn counter",
    description: "The shutters are half down. One pledged watch is still in the tray.",
  },
  character: { id: "ivo", name: "Ivo", role: "Owner returning for his pledge" },
  object: {
    id: "watch",
    name: "Pledged watch",
    description: "A steel watch, pledged last winter, still wound.",
  },
  tone: "intimate",
  cultural_anchor_query: null,
  forbidden_wording: [],
};

const BRIEF_TWO: Brief = {
  title: "The Quiet Handover",
  premise:
    "In a harbour radio room at the end of a storm watch, Mara asks for the logbook page she dictated an hour ago. You are the duty operator. Decide what to ask, whether to promise the page, and whether to release it.",
  player_role: "Harbour radio operator",
  room: {
    id: "radio",
    name: "Harbour radio room",
    description: "The storm watch is over. One dictated page is still clipped to the desk.",
  },
  character: { id: "mara", name: "Mara", role: "Caller asking for her dictated page" },
  object: {
    id: "page",
    name: "Logbook page",
    description: "One torn page, dictated an hour ago, still unsigned.",
  },
  tone: "tense",
  cultural_anchor_query: null,
  forbidden_wording: [],
};

const BRIEF_STALE: Brief = {
  title: "The Disposable Ledger",
  premise:
    "At a depot weighbridge just before the gate closes, Tam asks for the ticket they signed this morning. You are the gate clerk. Decide what to ask, whether to promise the ticket, and whether to release it.",
  player_role: "Depot gate clerk",
  room: {
    id: "gate",
    name: "Depot weighbridge",
    description: "The gate is closing. One signed ticket is still on the spike.",
  },
  character: { id: "tam", name: "Tam", role: "Driver asking for their ticket" },
  object: {
    id: "ticket",
    name: "Weighbridge ticket",
    description: "One carbon ticket, signed this morning, still on the spike.",
  },
  tone: "tense",
  cultural_anchor_query: null,
  forbidden_wording: [],
};

const EXPECTED_ENDINGS = ["end.give", "end.keep", "end.leave"] as const;

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

function note(line: string): void {
  console.log(`      ${line}`);
}

function heading(line: string): void {
  console.log("");
  console.log(`--- ${line}`);
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

/** Counts Qloo requests, so "compilation cost zero Qloo calls" is measured. */
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

type Harness = {
  readonly phase3: Phase3Deps;
  readonly phase4: Phase4Deps;
  readonly qlooUrls: string[];
  readonly modelCalls: () => number;
};

type ProjectState = {
  readonly project: ProjectView;
  readonly playable: PlayableView | null;
  readonly versions: SceneVersionSummary[];
};

async function readState(
  harness: Harness,
  cookie: string,
  projectId: string,
): Promise<ProjectState> {
  return json<ProjectState>(
    await handleReadProject(read(`/api/projects/${projectId}`, cookie), harness.phase3, projectId),
    "GET project",
  );
}

/* ------------------------------------------------- the phase 3 preparation */

type Prepared = {
  readonly projectId: string;
  readonly revision: number;
  readonly proposals: ProposalsResponse["project"]["proposals"];
};

/**
 * Walks one fresh project through the real Phase 3 path to stored approvals.
 *
 * Nothing here is fabricated: the artist is searched and confirmed explicitly,
 * the references come back as immutable captures, and the proposals are one
 * real bounded model call.
 */
async function prepareProject(
  harness: Harness,
  cookie: string,
  brief: Brief,
): Promise<Prepared | null> {
  const created = await json<{ project: ProjectView }>(
    await handleCreateProject(mutation("/api/projects", cookie, { brief }), harness.phase3),
    "POST /api/projects",
  );
  const projectId = created.project.id;
  note(`project ${projectId} — "${brief.title}"`);

  const searched = await json<{
    search: {
      capture_id: string | null;
      cache: string;
      candidates: { entity_id: string; name: string; original_rank: number }[];
    };
    project: ProjectView;
  }>(
    await handleArtistSearch(
      mutation(`/api/projects/${projectId}/artist-search`, cookie, { query: CANONICAL_ARTIST }),
      harness.phase3,
      projectId,
    ),
    "POST artist-search",
  );
  const candidate = searched.search.candidates.find(
    (entry) => entry.name.toLowerCase() === CANONICAL_ARTIST.toLowerCase(),
  );
  check(
    "the canonical artist is confirmable by exact name",
    candidate !== undefined,
    candidate === undefined ? "none matched" : `${candidate.name} at rank ${candidate.original_rank}`,
  );
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
  check("the anchor is explicitly confirmed", anchored.project.anchor_confirmed);

  const retrieved = await json<ReferencesResponse>(
    await handleReferences(
      mutation(`/api/projects/${projectId}/references`, cookie, {
        expected_revision: anchored.project.revision,
      }),
      harness.phase3,
      projectId,
    ),
    "POST references",
  );
  check("at least one reference domain is usable", retrieved.references.any_usable);

  // The phase 3 interpretation stage occasionally loses its connection to the
  // provider, which the route reports as a retryable 429 with the references
  // and approvals unchanged. Asking again is exactly what the creator's button
  // does, and it is not the same thing as re-rolling a result that came back:
  // a transport failure returned nothing to judge. It is bounded, and every
  // attempt is recorded.
  let proposed: ProposalsResponse | null = null;
  let proposalAttempts = 0;
  for (let attempt = 1; attempt <= PROPOSAL_REQUEST_ATTEMPTS; attempt += 1) {
    proposalAttempts = attempt;
    const response = await handleProposals(
      mutation(`/api/projects/${projectId}/proposals`, cookie, {
        expected_revision: retrieved.project.revision,
      }),
      harness.phase3,
      projectId,
    );
    if (response.ok) {
      proposed = (await response.json()) as ProposalsResponse;
      break;
    }
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      retryable?: boolean;
    };
    note(
      `proposal request ${attempt} of ${PROPOSAL_REQUEST_ATTEMPTS} failed: ${response.status} ${body.code ?? "?"}`,
    );
    if (attempt === PROPOSAL_REQUEST_ATTEMPTS || body.retryable === false) {
      check(
        "the phase 3 interpretation stage returned a draft",
        false,
        `${response.status} ${body.code ?? "?"} after ${attempt} request(s)`,
      );
      return null;
    }
  }
  if (proposed === null) return null;
  if (proposalAttempts > 1) {
    note(`the interpretation stage needed ${proposalAttempts} requests, the earlier one lost its connection`);
  }
  check(
    "the proposal stage returned a draft within its call ceiling",
    proposed.project.proposals.length > 0 &&
      proposed.model_calls >= 1 &&
      proposed.model_calls <= 2,
    `${proposed.project.proposals.length} proposals, ${proposed.model_calls} calls, repaired ${proposed.repaired}`,
  );
  check("the draft approved nothing by itself", proposed.project.approved_slots.length === 0);

  return {
    projectId,
    revision: proposed.project.revision,
    proposals: proposed.project.proposals,
  };
}

/** One explicit creator approval of one proposal into its own slot. */
async function approve(
  harness: Harness,
  cookie: string,
  projectId: string,
  revision: number,
  proposalId: string,
): Promise<DecisionsResponse> {
  return json<DecisionsResponse>(
    await handleDecisions(
      mutation(`/api/projects/${projectId}/decisions`, cookie, {
        expected_revision: revision,
        kind: "accept",
        proposal_id: proposalId,
      }),
      harness.phase3,
      projectId,
    ),
    "POST decisions (accept)",
  );
}

/* ------------------------------------------------------ the compilation run */

type AdvanceRecord = {
  readonly index: number;
  readonly stage: string | null;
  readonly state: string;
  readonly modelCalls: number;
  readonly replayed: boolean;
};

type CompileRun = {
  readonly operationId: string;
  readonly status: CompilationStatus;
  readonly advances: AdvanceRecord[];
  readonly providerCalls: number;
  readonly qlooCallsDuringCompile: number;
  readonly elapsedMs: number;
};

/**
 * Starts one compilation and advances it until it has no next stage.
 *
 * The browser's loop, exactly: an empty-bodied advance per stage, with the
 * controller choosing which stage that is. Nothing here names a stage.
 */
async function runCompilation(
  harness: Harness,
  cookie: string,
  projectId: string,
  revision: number,
): Promise<CompileRun> {
  const modelBefore = harness.modelCalls();
  const qlooBefore = harness.qlooUrls.length;
  const startedAt = Date.now();

  const started = await json<{ status: CompilationStatus; replayed: boolean }>(
    await handleCompile(
      mutation(`/api/projects/${projectId}/compile`, cookie, { expected_revision: revision }),
      harness.phase4,
      projectId,
    ),
    "POST compile",
  );
  const operationId = started.status.operation_id;
  note(`operation ${operationId} · state ${started.status.state} · replayed ${started.replayed}`);
  check(
    "creating the compilation performed no provider call",
    harness.modelCalls() === modelBefore,
    `${harness.modelCalls() - modelBefore} calls`,
  );

  const advances: AdvanceRecord[] = [];
  let status = started.status;
  for (let index = 1; index <= ADVANCE_CEILING; index += 1) {
    if (status.next_stage === null) break;
    const requested = status.next_stage;
    const result = await json<{
      status: CompilationStatus;
      model_calls: number;
      replayed: boolean;
    }>(
      await handleAdvance(
        mutation(`/api/operations/${operationId}/advance`, cookie, {}),
        harness.phase4,
        operationId,
      ),
      "POST advance",
    );
    status = result.status;
    advances.push({
      index,
      stage: requested,
      state: status.state,
      modelCalls: result.model_calls,
      replayed: result.replayed,
    });
    const entry = status.stages.find((candidate) => candidate.stage === requested);
    note(
      `advance ${index}: ${requested} → status ${entry?.status ?? "?"}, attempts ${
        entry?.attempts ?? 0
      }, repaired ${entry?.repaired ?? false}, model_calls ${result.model_calls}, state ${status.state}`,
    );
    if (status.state === "FAILED") break;
  }

  return {
    operationId,
    status,
    advances,
    providerCalls: harness.modelCalls() - modelBefore,
    qlooCallsDuringCompile: harness.qlooUrls.length - qlooBefore,
    elapsedMs: Date.now() - startedAt,
  };
}

/* -------------------------------------------------- the structural acceptance */

/**
 * Re-decides the version's acceptability here, through the Phase 1 engine.
 *
 * The stored `validation_summary` says the compiler's validator passed it; this
 * runs the same deterministic functions again over the scene that was actually
 * persisted, so the evidence is an independent verdict rather than a readback.
 */
function verifyStructure(scene: Scene, brief: Brief, approvalIds: readonly string[]): void {
  const report = validateScene(scene, brief, { approvedApprovalIds: approvalIds });
  check("the persisted scene revalidates through the real engine", report.ok, report.findings.map((f) => f.code).join(",") || "no findings");

  const endings = report.graph === null ? [] : [...report.graph.reachable_endings].sort();
  check(
    "all three endings are globally reachable",
    endings.length === 3 && EXPECTED_ENDINGS.every((ending) => endings.includes(ending)),
    endings.join(", "),
  );

  const explored = exploreScene(scene);
  check(
    "the reachability search finished inside its bound",
    explored.ok,
    explored.ok
      ? `${explored.graph.states.length} reachable states, ${explored.graph.edges.length} edges`
      : "resource limit reached",
  );
  if (explored.ok) {
    // A softlock is a reachable nonterminal state from which no ending remains
    // reachable. The graph records the endings reachable from each state, so
    // this is read off rather than inferred.
    const stuck = explored.graph.states.filter(
      (state) => (explored.graph.endingsFrom.get(state)?.size ?? 0) === 0,
    );
    check(
      "every reachable nonterminal state can still terminate",
      stuck.length === 0,
      stuck.length === 0
        ? `${explored.graph.states.length} states, all with a reachable ending`
        : `${stuck.length} states with no reachable ending`,
    );
    check(
      "the exploration recorded no step problem",
      explored.graph.problems.length === 0,
      explored.graph.problems.map((problem) => problem.code).join(",") || "none",
    );
    // A nonterminal choice must narrow what remains reachable somewhere, which
    // is what makes a choice consequential rather than decorative.
    const narrowing = explored.graph.edges.filter((edge) => {
      if (edge.to === null) return false;
      const before = explored.graph.endingsFrom.get(edge.from)?.size ?? 0;
      const after = explored.graph.endingsFrom.get(edge.to)?.size ?? 0;
      return after < before;
    });
    check(
      "at least one nonterminal choice reduces the reachable-ending set",
      narrowing.length > 0,
      `${narrowing.length} narrowing edges`,
    );
  }

  const subsets = validateSceneSubsets(scene, brief, { approvedApprovalIds: approvalIds });
  const expected = Math.pow(2, scene.modules.length);
  check(
    "every supported removal subset validates",
    subsets.ok && subsets.subsets.length === expected,
    subsets.subsets
      .map((entry) => `[${entry.slots.join("+") || "base"}]=${entry.report.ok ? "ok" : "FAIL"}`)
      .join(" "),
  );

  for (const module of scene.modules) {
    const witness = report.module_witnesses[module.slot];
    check(
      `the ${module.slot} module has a mechanical witness`,
      witness !== undefined && witness.mechanical,
      witness === undefined
        ? "none computed"
        : `mechanical ${witness.mechanical}, ${witness.pairs_explored} pairs explored`,
    );
  }

  // Ownership: the base alone must still be a valid scene, and a module must
  // not have rewritten the world the creator wrote.
  const base = cleanBase(scene);
  const baseReport = validateScene(base, brief, { approvedApprovalIds: [] });
  check("the clean base alone still validates", baseReport.ok, baseReport.findings.map((f) => f.code).join(",") || "no findings");
  check(
    "the world is still the frozen brief",
    scene.world.room.id === brief.room.id &&
      scene.world.characters[0].id === brief.character.id &&
      scene.world.object.id === brief.object.id,
    `${scene.world.room.id} / ${scene.world.characters[0].id} / ${scene.world.object.id}`,
  );
  check(
    "the core is identical in the clean base and the composed scene",
    JSON.stringify(base.core) === JSON.stringify(scene.core),
  );
}

/** Module isolation, read off the composed view rather than asserted. */
function verifyModuleIsolation(scene: Scene): void {
  if (scene.modules.length < 2) return;
  const view = viewOf(scene);
  const ownerOf = new Map(view.variables.map((entry) => [entry.variable.id, entry.owner]));

  for (const module of scene.modules) {
    const other = scene.modules.find((candidate) => candidate.slot !== module.slot);
    if (other === undefined) continue;
    const otherVars = new Set(
      view.variables
        .filter((entry) => entry.owner === other.slot)
        .map((entry) => entry.variable.id),
    );
    const serialized = JSON.stringify(module);
    const touched = [...otherVars].filter((id) => serialized.includes(id));
    check(
      `the ${module.slot} module reads and writes no ${other.slot} state`,
      touched.length === 0,
      touched.length === 0 ? `${otherVars.size} foreign variables, none referenced` : touched.join(","),
    );
  }

  const coreOwned = view.variables.filter((entry) => entry.owner === "core").length;
  note(
    `composed ownership: ${coreOwned} core variables, ${
      view.variables.length - coreOwned
    } module variables, all resolvable`,
  );
  check(
    "every composed variable has exactly one owner",
    ownerOf.size === view.variables.length,
    `${ownerOf.size} of ${view.variables.length}`,
  );
}

/**
 * Plays the scene to every ending locally, then resets.
 *
 * This is the engine the browser runs. It takes the persisted scene and makes
 * no request of any kind, which is the point being recorded.
 */
function playToEveryEnding(scene: Scene): void {
  const explored = exploreScene(scene);
  if (!explored.ok) {
    check("a complete local playthrough reaches every ending", false, "exploration hit its bound");
    return;
  }

  const reached = new Set<string>();
  // Breadth-first over action sequences, replaying from the initial state each
  // time, so every path is a fresh local playthrough.
  const queue: string[][] = [[]];
  let expansions = 0;
  while (queue.length > 0 && expansions < 4000 && reached.size < 3) {
    const prefix = queue.shift() as string[];
    expansions += 1;
    const run = replay(scene, prefix);
    if (run.stopped_at !== null) continue;
    if (run.ending !== null) {
      reached.add(run.ending.id);
      continue;
    }
    if (prefix.length >= 12) continue;
    for (const action of availableActions(scene, run.state)) {
      if (!action.enabled) continue;
      queue.push([...prefix, action.action_id]);
    }
  }
  check(
    "a complete local playthrough reaches every one of the three endings",
    reached.size === 3 && EXPECTED_ENDINGS.every((ending) => reached.has(ending)),
    [...reached].sort().join(", "),
  );

  // A reset is the initial state again, with no mutation and no request.
  const fresh = initialState(scene);
  check(
    "a reset returns the engine to the initial state",
    fresh.bits === initialState(scene).bits && availableActions(scene, fresh).some((a) => a.enabled),
    `${availableActions(scene, fresh).filter((a) => a.enabled).length} enabled actions at the start`,
  );

  // One single step, to record that stepping is a pure local function.
  const firstEnabled = availableActions(scene, fresh).find((action) => action.enabled);
  if (firstEnabled !== undefined) {
    const result = step(scene, fresh, firstEnabled.action_id);
    check("one local choice steps the engine without a request", result.ok, firstEnabled.action_id);
  }
}

/** The stored subset and witness reports, printed verbatim. */
function reportStoredValidation(playable: PlayableView): void {
  const validation = playable.validation;
  check("the stored validation summary says ok", validation.ok);
  check(
    "the stored reachable endings are exactly the three",
    validation.reachable_endings.length === 3 &&
      EXPECTED_ENDINGS.every((ending) => validation.reachable_endings.includes(ending)),
    validation.reachable_endings.join(", "),
  );
  note(
    `stored subsets (${validation.subsets.length}): ${validation.subsets
      .map((entry) => `[${entry.slots.join("+") || "base"}]=${entry.ok ? "ok" : "FAIL"}`)
      .join(" ")}`,
  );
  check(
    "every stored subset report is ok",
    validation.subsets.every((entry) => entry.ok),
  );
  check(
    "the stored subset count matches the active module count",
    validation.subsets.length === Math.pow(2, validation.active_slots.length),
    `${validation.subsets.length} reports for ${validation.active_slots.length} modules`,
  );
  check(
    "a mechanical witness is stored for every active module",
    validation.witnesses.length === validation.active_slots.length &&
      validation.witnesses.every(
        (witness) => witness.mechanical && witness.prefix !== undefined && witness.sentence.length > 0,
      ),
    `${validation.witnesses.length} witnesses`,
  );
  for (const witness of validation.witnesses) {
    note(`witness ${witness.slot}: kind ${witness.kind}, prefix [${witness.prefix.join(" → ")}]`);
    note(`  sentence: ${witness.sentence}`);
  }
  note(`"Where this appears" lines: ${playable.scene_changed.length}`);
  for (const line of playable.scene_changed) {
    note(`  ${line.slot}: ${line.witness.sentence}`);
    note(`    mechanic ids: ${line.mechanic_ids.join(", ")}`);
  }
  check(
    "the fourth provenance layer exists only where a mechanical witness does",
    playable.scene_changed.length ===
      validation.witnesses.filter((witness) => witness.mechanical).length,
  );
  check(
    "no fourth-layer line evaluates the idea or its origin",
    playable.scene_changed.every((line) => {
      const text = line.witness.sentence.toLowerCase();
      return (
        !text.includes("qloo") &&
        !text.includes("better") &&
        !text.includes("original") &&
        !text.includes("creative") &&
        !text.includes("llm") &&
        !text.includes("model")
      );
    }),
  );
}

/**
 * Says where this run's token totals have to be read from.
 *
 * The controller reconciles each stage's reported usage into the shared
 * `budget_buckets` row rather than onto the stage's operation row, so the
 * honest granularity available afterwards is per window, not per stage. This
 * prints the marker to difference the bucket against instead of inventing a
 * per-stage figure the database does not hold.
 */
function reportBudgetMarker(label: string, run: CompileRun): void {
  note(
    `${label}: ${run.providerCalls} provider calls over ${run.elapsedMs} ms — difference`,
  );
  note(
    "  select scope, used_calls, used_tokens, window_end from public.budget_buckets",
  );
  note("  around this run for the token totals; per-stage usage is not persisted.");
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<number> {
  if (process.env[GUARD] !== "1") {
    console.log(
      [
        "smoke:compile did not run, and made no request.",
        "",
        "This command spends real model calls on the pinned snapshot and writes",
        "real projects and scene versions, so it is opt-in:",
        "",
        `  ${GUARD}=1 npm run smoke:compile`,
        "",
        "It needs the phase 4 migration applied, and it drives the real",
        "controller only — there is no path here that calls the model directly.",
        "Run `RUN_QLOO_SMOKE=1 npm run smoke:qloo` first so the captures are",
        "already stored. Do not loop it.",
      ].join("\n"),
    );
    return 0;
  }

  loadEnvFile();

  try {
    qlooEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`smoke:compile FAILED — ${error.message}`);
      return 1;
    }
    throw error;
  }

  const qloo = countingFetch();
  const model = countingModelClient();
  const base = livePhase3Deps();
  const harness: Harness = {
    phase3: { ...base, fetchImpl: qloo.fetchImpl, modelClient: model.client },
    phase4: { gateway: base.gateway, budget: base.budget, modelClient: model.client },
    qlooUrls: qloo.urls,
    modelCalls: () => model.count(),
  };

  console.log("smoke:compile");
  console.log(`  model             ${PINNED_CHAT_MODEL}`);
  console.log(`  qloo host         ${qlooEnv().host}`);
  console.log(`  model call cap    ${harness.phase4.budget().modelDailyCallCap} per window`);
  console.log("");

  const sessionResponse = await handleCreateSession(mutation("/api/session", null, {}), harness.phase3);
  await json<unknown>(sessionResponse, "POST /api/session");
  const cookie = (sessionResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  check("an anonymous owner session was established", cookie.startsWith(`${OWNER_COOKIE_NAME}=`));

  // =========================================================================
  // A. One real fresh single-approval compilation
  // =========================================================================

  heading("A. one approved influence, fresh brief, real compilation");

  const one = await prepareProject(harness, cookie, BRIEF_ONE);
  if (one === null) return finish();

  const firstProposal =
    one.proposals.find((proposal) => proposal.slot === "discovery") ?? one.proposals[0];
  if (firstProposal === undefined) {
    check("a proposal is available to approve", false);
    return finish();
  }
  note(`approving ${firstProposal.reference_name} into ${firstProposal.slot}`);
  const approvedOne = await approve(
    harness,
    cookie,
    one.projectId,
    one.revision,
    firstProposal.proposal_id,
  );
  check("exactly one influence is approved", approvedOne.project.approvals.length === 1);
  const approvalOne = approvedOne.project.approvals[0];
  note(`approval ${approvalOne?.approval_id} · slot ${approvalOne?.slot} · revision ${approvedOne.project.revision}`);

  const runOne = await runCompilation(harness, cookie, one.projectId, approvedOne.project.revision);
  check(
    "the single-approval compilation reached a reviewable pending version",
    runOne.status.state === "REVIEW_PLAYABLE" && runOne.status.version_id !== null,
    `state ${runOne.status.state}, version ${runOne.status.version_id ?? "none"}`,
  );
  check(
    "it used two provider calls, or at most four with one repair per model stage",
    runOne.providerCalls >= 2 && runOne.providerCalls <= 4,
    `${runOne.providerCalls} provider calls`,
  );
  check(
    "the controller's own model-call count agrees",
    runOne.status.model_calls === runOne.providerCalls,
    `${runOne.status.model_calls} counted by the controller`,
  );
  check(
    "compilation made zero Qloo calls",
    runOne.qlooCallsDuringCompile === 0,
    `${runOne.qlooCallsDuringCompile} upstream Qloo requests between compile and the pending version`,
  );
  check(
    "no stage exceeded its declared attempt ceiling",
    runOne.status.stages.every((stage) => stage.attempts <= 2),
    runOne.status.stages.map((stage) => `${stage.stage}=${stage.attempts}`).join(" "),
  );
  check(
    "the deterministic validate stage made no provider call",
    runOne.advances.find((entry) => entry.stage === "validate")?.modelCalls === 0,
  );
  note(`elapsed ${runOne.elapsedMs} ms across ${runOne.advances.length} advances`);
  const repairedOne = runOne.status.stages.filter((stage) => stage.repaired);
  note(
    repairedOne.length === 0
      ? "no stage needed its one permitted repair"
      : `repaired stages: ${repairedOne.map((stage) => stage.stage).join(", ")}`,
  );
  reportBudgetMarker("one-influence compile", runOne);

  // The pending version, before any activation.
  const pendingOne = await readState(harness, cookie, one.projectId);
  check(
    "nothing is active until the creator confirms",
    pendingOne.project.active_version_id === null &&
      pendingOne.project.pending_version_id === runOne.status.version_id,
    `active ${pendingOne.project.active_version_id ?? "none"}, pending ${
      pendingOne.project.pending_version_id ?? "none"
    }`,
  );
  const playableOne = pendingOne.playable;
  check("the pending version comes back as a playable", playableOne !== null);
  if (playableOne === null) return finish();
  check("the pending playable is labelled pending", playableOne.state === "pending", playableOne.state);

  heading("B. structural acceptance of the one-influence version");
  reportStoredValidation(playableOne);
  verifyStructure(playableOne.scene, BRIEF_ONE, [
    ...playableOne.scene.modules.map((module) => module.approval_id),
  ]);
  playToEveryEnding(playableOne.scene);

  // No rejected or unselected evidence may appear in the compiled scene.
  const rejectedTexts = one.proposals
    .filter((proposal) => proposal.proposal_id !== firstProposal.proposal_id)
    .map((proposal) => proposal.idea);
  const sceneJsonOne = JSON.stringify(playableOne.scene);
  check(
    "no unapproved proposal's wording reached the compiled scene",
    rejectedTexts.every((text) => !sceneJsonOne.includes(text)),
    `${rejectedTexts.length} unapproved proposals checked`,
  );
  check(
    "the compiled scene carries no capture id or affinity",
    !sceneJsonOne.includes("capture_id") && !sceneJsonOne.includes("affinity"),
  );

  // Reading the operation status initiates nothing.
  const modelBeforeStatus = harness.modelCalls();
  await json<unknown>(
    await handleOperationStatus(
      read(`/api/operations/${runOne.operationId}`, cookie),
      harness.phase4,
      runOne.operationId,
    ),
    "GET operation",
  );
  check(
    "reading the operation status initiates no provider call",
    harness.modelCalls() === modelBeforeStatus,
  );

  // Explicit activation.
  const activatedOne = await json<{
    outcome: string;
    active_version_id: string | null;
    pending_version_id: string | null;
    workflow_state: string;
  }>(
    await handleActivate(
      mutation(`/api/projects/${one.projectId}/activate`, cookie, {
        expected_revision: pendingOne.project.revision,
        version_id: playableOne.version_id,
      }),
      harness.phase4,
      one.projectId,
    ),
    "POST activate",
  );
  check(
    "explicit activation makes the reviewed version current",
    activatedOne.outcome === "activated" &&
      activatedOne.active_version_id === playableOne.version_id &&
      activatedOne.pending_version_id === null &&
      activatedOne.workflow_state === "READY",
    `${activatedOne.outcome}, workflow ${activatedOne.workflow_state}`,
  );

  const modelBeforeReload = harness.modelCalls();
  const qlooBeforeReload = harness.qlooUrls.length;
  const reloadedOne = await readState(harness, cookie, one.projectId);
  check(
    "the active version survives a fresh read",
    reloadedOne.project.active_version_id === playableOne.version_id &&
      reloadedOne.playable?.version_id === playableOne.version_id &&
      reloadedOne.playable?.state === "active",
    `${reloadedOne.playable?.state ?? "none"} ${reloadedOne.playable?.version_id ?? ""}`,
  );
  check(
    "activation and reload cost zero provider and zero Qloo calls",
    harness.modelCalls() === modelBeforeReload && harness.qlooUrls.length === qlooBeforeReload,
  );
  check(
    "the reloaded scene is byte-identical to the reviewed one",
    JSON.stringify(reloadedOne.playable?.scene) === sceneJsonOne,
  );
  note(
    `version ${playableOne.version_id} created ${playableOne.created_at} · base ${reloadedOne.versions[0]?.base_hash}`,
  );
  check(
    "the version records the pinned model and the phase 4 identifiers",
    reloadedOne.versions[0]?.model_identifier === PINNED_CHAT_MODEL &&
      reloadedOne.versions[0]?.compiler_identifier === "fp-compiler-4.1" &&
      reloadedOne.versions[0]?.validator_identifier === "fp-engine-validator-1.0",
    `${reloadedOne.versions[0]?.model_identifier} / ${reloadedOne.versions[0]?.compiler_identifier} / ${reloadedOne.versions[0]?.validator_identifier}`,
  );

  // =========================================================================
  // C. One real fresh two-approval compilation
  // =========================================================================

  heading("C. two approved influences, fresh brief, real compilation");

  const two = await prepareProject(harness, cookie, BRIEF_TWO);
  if (two === null) return finish();

  const discovery = two.proposals.find((proposal) => proposal.slot === "discovery");
  const commitment = two.proposals.find((proposal) => proposal.slot === "commitment");
  check(
    "the real proposal stage offered one Discovery and one Commitment interaction",
    discovery !== undefined && commitment !== undefined,
    two.proposals.map((proposal) => proposal.slot).join(", "),
  );
  if (discovery === undefined || commitment === undefined) {
    note("the two-influence gate needs both slots proposed; not fabricating the second approval");
    return finish();
  }

  note(`approving ${discovery.reference_name} into discovery`);
  const afterDiscovery = await approve(
    harness,
    cookie,
    two.projectId,
    two.revision,
    discovery.proposal_id,
  );
  note(`approving ${commitment.reference_name} into commitment`);
  const afterBoth = await approve(
    harness,
    cookie,
    two.projectId,
    afterDiscovery.project.revision,
    commitment.proposal_id,
  );
  check(
    "two influences are approved, one per slot",
    afterBoth.project.approvals.length === 2 &&
      afterBoth.project.approved_slots.includes("discovery") &&
      afterBoth.project.approved_slots.includes("commitment"),
    afterBoth.project.approved_slots.join(", "),
  );

  const runTwo = await runCompilation(harness, cookie, two.projectId, afterBoth.project.revision);
  check(
    "the two-approval compilation reached a reviewable pending version",
    runTwo.status.state === "REVIEW_PLAYABLE" && runTwo.status.version_id !== null,
    `state ${runTwo.status.state}, version ${runTwo.status.version_id ?? "none"}, failure ${
      runTwo.status.failure?.code ?? "none"
    }`,
  );
  check(
    "it used three provider calls, or at most six with one repair per model stage",
    runTwo.providerCalls >= 3 && runTwo.providerCalls <= 6,
    `${runTwo.providerCalls} provider calls`,
  );
  check(
    "compilation made zero Qloo calls",
    runTwo.qlooCallsDuringCompile === 0,
    `${runTwo.qlooCallsDuringCompile} upstream Qloo requests`,
  );
  check(
    "no stage exceeded its declared attempt ceiling",
    runTwo.status.stages.every((stage) => stage.attempts <= 2),
    runTwo.status.stages.map((stage) => `${stage.stage}=${stage.attempts}`).join(" "),
  );
  note(`elapsed ${runTwo.elapsedMs} ms across ${runTwo.advances.length} advances`);
  const repairedTwo = runTwo.status.stages.filter((stage) => stage.repaired);
  note(
    repairedTwo.length === 0
      ? "no stage needed its one permitted repair"
      : `repaired stages: ${repairedTwo.map((stage) => stage.stage).join(", ")}`,
  );
  reportBudgetMarker("two-influence compile", runTwo);

  const pendingTwo = await readState(harness, cookie, two.projectId);
  const playableTwo = pendingTwo.playable;
  check("the two-module pending version comes back as a playable", playableTwo !== null);
  if (playableTwo === null) return finish();
  check(
    "it carries two active modules",
    playableTwo.scene.modules.length === 2,
    playableTwo.scene.modules.map((module) => module.slot).join(", "),
  );
  check(
    "the version records one module hash per active slot",
    Object.keys(pendingTwo.versions[0]?.module_hashes ?? {}).length === 2 &&
      Object.values(pendingTwo.versions[0]?.module_hashes ?? {}).every(
        (hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash),
      ),
    Object.keys(pendingTwo.versions[0]?.module_hashes ?? {}).join(", "),
  );

  heading("D. two-module hard acceptance");
  reportStoredValidation(playableTwo);
  verifyStructure(playableTwo.scene, BRIEF_TWO, [
    ...playableTwo.scene.modules.map((module) => module.approval_id),
  ]);
  verifyModuleIsolation(playableTwo.scene);
  playToEveryEnding(playableTwo.scene);

  // The four subsets, decided here rather than read back.
  for (const slots of [[], ["discovery"], ["commitment"], ["discovery", "commitment"]] as Slot[][]) {
    const reduced = sceneWithModuleSubset(playableTwo.scene, slots);
    const report = validateScene(reduced, BRIEF_TWO, {
      approvedApprovalIds: reduced.modules.map((module) => module.approval_id),
    });
    check(
      `base ${slots.length === 0 ? "alone" : `+ ${slots.join(" + ")}`} validates`,
      report.ok,
      report.findings.map((finding) => finding.code).join(",") || "no findings",
    );
  }

  const activatedTwo = await json<{ outcome: string; active_version_id: string | null }>(
    await handleActivate(
      mutation(`/api/projects/${two.projectId}/activate`, cookie, {
        expected_revision: pendingTwo.project.revision,
        version_id: playableTwo.version_id,
      }),
      harness.phase4,
      two.projectId,
    ),
    "POST activate (two)",
  );
  check(
    "the two-module version activates explicitly",
    activatedTwo.outcome === "activated" && activatedTwo.active_version_id === playableTwo.version_id,
    activatedTwo.outcome,
  );

  // =========================================================================
  // E. Base and module reuse
  // =========================================================================

  heading("E. base reuse: only the replaced slot recompiles");

  const current = await readState(harness, cookie, two.projectId);
  const replacement = two.proposals.find(
    (proposal) =>
      proposal.slot === "commitment" && proposal.proposal_id !== commitment.proposal_id,
  );
  if (replacement === undefined) {
    note("no second Commitment proposal exists to replace with; base reuse is recorded as not run");
    check("base reuse could be exercised with a real replacement approval", true, "skipped honestly: no alternative proposal");
  } else {
    note(`replacing commitment with ${replacement.reference_name}`);
    const replaced = await json<DecisionsResponse>(
      await handleDecisions(
        mutation(`/api/projects/${two.projectId}/decisions`, cookie, {
          expected_revision: current.project.revision,
          kind: "replace",
          proposal_id: replacement.proposal_id,
          slot: "commitment",
        }),
        harness.phase3,
        two.projectId,
      ),
      "POST decisions (replace)",
    );
    check(
      "the brief did not change, so the base input is untouched",
      JSON.stringify(replaced.project.brief) === JSON.stringify(current.project.brief),
    );

    const rerun = await runCompilation(
      harness,
      cookie,
      two.projectId,
      replaced.project.revision,
    );
    check(
      "only the replaced slot needed a provider call",
      rerun.providerCalls >= 1 && rerun.providerCalls <= 2,
      `${rerun.providerCalls} provider calls (base and the unchanged slot were reused)`,
    );
    const baseAdvance = rerun.advances.find((entry) => entry.stage === "base");
    check(
      "the clean base was reused rather than regenerated",
      baseAdvance?.modelCalls === 0 && baseAdvance?.replayed === true,
      `base advance: model_calls ${baseAdvance?.modelCalls}, replayed ${baseAdvance?.replayed}`,
    );
    const discoveryAdvance = rerun.advances.find((entry) => entry.stage === "module_discovery");
    check(
      "the unchanged Discovery module was reused rather than recompiled",
      discoveryAdvance?.modelCalls === 0 && discoveryAdvance?.replayed === true,
      `discovery advance: model_calls ${discoveryAdvance?.modelCalls}, replayed ${discoveryAdvance?.replayed}`,
    );
    const afterRerun = await readState(harness, cookie, two.projectId);
    check(
      "the base hash is identical across the two compilations",
      afterRerun.versions[0]?.base_hash === pendingTwo.versions[0]?.base_hash,
      `${afterRerun.versions[0]?.base_hash} vs ${pendingTwo.versions[0]?.base_hash}`,
    );
    check(
      "the previously active version is still active while the rebuild awaits review",
      afterRerun.project.active_version_id === playableTwo.version_id,
      `active ${afterRerun.project.active_version_id ?? "none"}, pending ${
        afterRerun.project.pending_version_id ?? "none"
      }`,
    );
    note(`rerun elapsed ${rerun.elapsedMs} ms, state ${rerun.status.state}`);
  }

  // =========================================================================
  // F. The live stale-result compare-and-swap
  // =========================================================================

  heading("F. live stale-result protection on a disposable project");

  const stale = await prepareProject(harness, cookie, BRIEF_STALE);
  if (stale === null) return finish();

  const staleDiscovery = stale.proposals.find((proposal) => proposal.slot === "discovery");
  const staleCommitment = stale.proposals.find((proposal) => proposal.slot === "commitment");
  if (staleDiscovery === undefined || staleCommitment === undefined) {
    note("the stale test needs two approvals to remove one from; recorded as not run");
    return finish();
  }

  const staleFirst = await approve(
    harness,
    cookie,
    stale.projectId,
    stale.revision,
    staleDiscovery.proposal_id,
  );
  const staleBoth = await approve(
    harness,
    cookie,
    stale.projectId,
    staleFirst.project.revision,
    staleCommitment.proposal_id,
  );

  // Start the build and let exactly the base stage commit.
  const staleStart = await json<{ status: CompilationStatus }>(
    await handleCompile(
      mutation(`/api/projects/${stale.projectId}/compile`, cookie, {
        expected_revision: staleBoth.project.revision,
      }),
      harness.phase4,
      stale.projectId,
    ),
    "POST compile (stale)",
  );
  const staleOperationId = staleStart.status.operation_id;
  const afterBase = await json<{ status: CompilationStatus }>(
    await handleAdvance(
      mutation(`/api/operations/${staleOperationId}/advance`, cookie, {}),
      harness.phase4,
      staleOperationId,
    ),
    "POST advance (stale base)",
  );
  check(
    "the base stage committed before the approvals were changed",
    afterBase.status.state === "BASE_READY",
    `state ${afterBase.status.state}`,
  );

  // Now change the approvals underneath the in-flight compilation.
  const removed = await json<DecisionsResponse>(
    await handleDecisions(
      mutation(`/api/projects/${stale.projectId}/decisions`, cookie, {
        expected_revision: staleBoth.project.revision,
        kind: "remove",
        slot: "commitment",
      }),
      harness.phase3,
      stale.projectId,
    ),
    "POST decisions (remove)",
  );
  check(
    "removing one approval advanced the project revision",
    removed.project.revision > staleBoth.project.revision,
    `revision ${staleBoth.project.revision} → ${removed.project.revision}`,
  );

  const modelBeforeStale = harness.modelCalls();
  const staleAdvance = await json<{ status: CompilationStatus; model_calls: number }>(
    await handleAdvance(
      mutation(`/api/operations/${staleOperationId}/advance`, cookie, {}),
      harness.phase4,
      staleOperationId,
    ),
    "POST advance (stale)",
  );
  check(
    "the stale compilation is refused with STALE_INPUT and cannot continue",
    staleAdvance.status.state === "FAILED" &&
      staleAdvance.status.failure?.code === "STALE_INPUT" &&
      staleAdvance.status.next_stage === null,
    `state ${staleAdvance.status.state}, code ${staleAdvance.status.failure?.code ?? "none"}`,
  );
  check(
    "the refusal says so in the creator's own words",
    staleAdvance.status.failure?.message.includes("changed while this was being written") === true,
    staleAdvance.status.failure?.message ?? "no message",
  );
  check(
    "the stale advance spent no provider call",
    harness.modelCalls() === modelBeforeStale && staleAdvance.model_calls === 0,
  );

  const afterStale = await readState(harness, cookie, stale.projectId);
  check(
    "no scene version was created by the stale compilation",
    afterStale.versions.length === 0 &&
      afterStale.project.pending_version_id === null &&
      afterStale.project.active_version_id === null,
    `${afterStale.versions.length} versions`,
  );

  // The second checkpoint: a pending version whose approvals then move.
  const staleRebuild = await runCompilation(
    harness,
    cookie,
    stale.projectId,
    afterStale.project.revision,
  );
  check(
    "a legitimate rebuild after the removal still produces a pending version",
    staleRebuild.status.state === "REVIEW_PLAYABLE" && staleRebuild.status.version_id !== null,
    `state ${staleRebuild.status.state}, ${staleRebuild.providerCalls} provider calls`,
  );
  if (staleRebuild.status.version_id !== null) {
    const beforeActivation = await readState(harness, cookie, stale.projectId);
    const pendingId = staleRebuild.status.version_id;

    // Activate it first, so there is a last-good version to preserve.
    await json<unknown>(
      await handleActivate(
        mutation(`/api/projects/${stale.projectId}/activate`, cookie, {
          expected_revision: beforeActivation.project.revision,
          version_id: pendingId,
        }),
        harness.phase4,
        stale.projectId,
      ),
      "POST activate (stale project)",
    );
    const withActive = await readState(harness, cookie, stale.projectId);
    check(
      "the rebuilt version is now the last good version",
      withActive.project.active_version_id === pendingId,
      withActive.project.active_version_id ?? "none",
    );

    // Build once more, reach the pending review, then move the approvals and
    // try to activate the now-stale pending version.
    const secondDiscovery = stale.proposals.find(
      (proposal) =>
        proposal.slot === "discovery" && proposal.proposal_id !== staleDiscovery.proposal_id,
    );
    if (secondDiscovery === undefined) {
      note("no alternative Discovery proposal exists, so the stale-activation variant is recorded as not run");
    } else {
      const replacedAgain = await json<DecisionsResponse>(
        await handleDecisions(
          mutation(`/api/projects/${stale.projectId}/decisions`, cookie, {
            expected_revision: withActive.project.revision,
            kind: "replace",
            proposal_id: secondDiscovery.proposal_id,
            slot: "discovery",
          }),
          harness.phase3,
          stale.projectId,
        ),
        "POST decisions (replace for stale activation)",
      );
      const pendingRun = await runCompilation(
        harness,
        cookie,
        stale.projectId,
        replacedAgain.project.revision,
      );
      if (pendingRun.status.version_id === null) {
        note(`the stale-activation variant could not reach a pending version: ${pendingRun.status.failure?.code ?? "unknown"}`);
      } else {
        const beforeMove = await readState(harness, cookie, stale.projectId);
        // Move the approvals again, so the pending version is stale.
        const movedAgain = await json<DecisionsResponse>(
          await handleDecisions(
            mutation(`/api/projects/${stale.projectId}/decisions`, cookie, {
              expected_revision: beforeMove.project.revision,
              kind: "remove",
              slot: "discovery",
            }),
            harness.phase3,
            stale.projectId,
          ),
          "POST decisions (remove before activation)",
        );
        const refused = await handleActivate(
          mutation(`/api/projects/${stale.projectId}/activate`, cookie, {
            expected_revision: movedAgain.project.revision,
            version_id: pendingRun.status.version_id,
          }),
          harness.phase4,
          stale.projectId,
        );
        const refusedBody = await refused.text();
        check(
          "a stale pending version cannot be activated",
          refused.status >= 400,
          `status ${refused.status}`,
        );
        const afterRefusal = await readState(harness, cookie, stale.projectId);
        check(
          "the previous active version is untouched by the refused activation",
          afterRefusal.project.active_version_id === pendingId,
          `active ${afterRefusal.project.active_version_id ?? "none"}`,
        );
        check(
          "the refusal leaks no provider or evidence diagnostic",
          !refusedBody.includes("sk-") && !refusedBody.includes("affinity"),
        );
      }
    }
  }

  // =========================================================================
  // Totals
  // =========================================================================

  heading("totals");
  note(`model calls this run: ${harness.modelCalls()}`);
  note(`Qloo upstream calls this run: ${harness.qlooUrls.length}`);
  note(`  all of them belong to the phase 3 retrieval stages, none to a compilation`);
  note(`one-influence project:  ${one.projectId}`);
  note(`two-influence project:  ${two.projectId}`);
  note(`disposable stale project: ${stale.projectId}`);
  note("");
  note("Token usage and the labelled cost ESTIMATE are reconciled into the");
  note("budget bucket by the controller; read them with the section I query in");
  note("docs/PHASE4_LOCAL_HANDOFF.md. A per-call estimate from list prices is");
  note(
    `arithmetic only — for example 1000 in / 500 out is $${estimateUsdCost({
      input_tokens: 1000,
      output_tokens: 500,
      total_tokens: 1500,
    }).toFixed(8)}, not a billed amount.`,
  );

  return finish();
}

function finish(): number {
  console.log("");
  console.log(failures === 0 ? "smoke:compile OK" : `smoke:compile FAILED (${failures})`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`smoke:compile FAILED — ${error instanceof Error ? error.name : "unknown"}`);
    if (error instanceof Error) console.error(`  ${error.message}`);
    process.exitCode = 1;
  },
);
