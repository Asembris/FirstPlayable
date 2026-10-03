# FirstPlayable v2 — Authoritative Build Specification

**Status:** architecture freeze · **Specification:** 1.0 · **Date:** 3 October 2026  
**Delivery:** seven sequential Claude Code sessions, with binary exit gates.  
**Product:** a playable-pitch studio, not a general game generator.

> Choose the influences. Play the consequences.

## Decision in one paragraph

Build one Next.js/React/TypeScript application, with Zod contracts, a pure TypeScript scene engine shared by browser and server, Supabase Postgres persistence, Vercel Hobby hosting, and the Gemini Developer API free tier. Qloo retrieves movie and videogame candidates in parallel from one confirmed artist. A creator approves at most two concrete interaction ideas. The application composes independently owned influence modules onto a cultural-data-blind scene foundation. Removing an influence removes its module; editing it regenerates only that module. A change is called **mechanical** only when deterministic replay demonstrates a changed action, gate, state consequence, or reachable ending—not merely different wording.

This is a TypeScript backend intentionally, not a FastAPI service plus a second runtime. One engine and one deployment are worth more here than retaining Python. The user already works with React/TypeScript; the narrowly bounded controller does not need an agent framework.

## Evidence and authority

The uploaded product brief governs the product scope. The supplied experiments govern Qloo assumptions. Everything labeled **design decision**, including scene mechanics, limits, UI, and architecture, is a proposal frozen by this specification—not a finding from those experiments.

- **E1 — `FIRSTPLAYABLE.md`:** the previous automatic-grounding experiment failed its declared gate. The mismatched packet won six of nine B-versus-C votes, and five of nine scenes never closed an ending before the final choice. The report also discloses three briefs, same-family model evaluators, and no actual player evaluation. We do not rewrite that result into proof of creative superiority. See §§8–12 and the validation summary.
- **E2 — `CROSS_DOMAIN_STRUCTURE(2).md`:** first-hop artist neighborhoods were distinct; source persistence across a second hop was not a reusable primitive. See §§5, 11–13. This product performs no second hop.
- **E3 — `RECON(6).md`:** observed Qloo limits, request patterns, ambiguity, payload sizes, descriptive fields, and failure cases. The report's phrases about outperforming or being impossible to imitate with an LLM are its interpretation, not a controlled finding adopted by this plan.
- **E4 — `Texte collé(20261003-173324).txt`:** the locked FirstPlayable v2 brief and its twenty required planning sections.

The raw capture files referenced by the reports were **not attached**. Exact unshown JSON paths, entity IDs, and missing game descriptions must be captured or recovered during implementation, not fabricated here. The worked scene below is a **design fixture**, not a claim that a live compiler already generated it.

## 1. Freeze the exact MVP

### User and job

**User:** an individual narrative-game creator or game-jam writer with a scene premise, before a full production pipeline exists.

**Job:** turn a small object-centered dilemma into a browser-playable pitch, try an explicitly chosen cultural interpretation, and show a collaborator how changing that interpretation changes a player decision.

### Inputs

One compact form; advanced fields expand rather than becoming a dashboard.

| Field | Contract |
|---|---|
| Title | Optional, 1–60 characters; derive a working title when empty. |
| Premise | Required, 40–600 characters. One encounter about handing over or retaining an important object. |
| Room | Required name/description, at most 120 characters. |
| Player role | Required, at most 60 characters; first-person player, not a separately simulated character. |
| Other character | Exactly one NPC: name up to 40 characters, role up to 100. |
| Important object | Exactly one: name up to 60 characters, description up to 180. |
| Tone | `tense`, `intimate`, or `wry`; a creative direction, not a mechanically verified quality. |
| Cultural anchor | Artist query, 2–80 characters, followed by explicit identity confirmation. |
| Forbidden wording | Optional: up to five words/phrases, each up to 32 characters; literal wording constraint, not a semantic prohibition. |

The default form groups room, character, and object under “Keep these fixed.” Do not ask for personality profiles, taste scores, demographics, desired model, or engine settings.

**Fixed production constraints:** English text; one room; one first-person player plus one NPC, meaning two characters total; one important object; no combat; no inventory system; exactly three globally reachable endings; only `inspect`, `ask`, `give`, `withhold`, `leave`; no generated art, music, voice, code, or external gameplay calls. Aim for a 2–4 minute complete reading/playthrough. Duration is a human-playtest target, not something the validator can prove.

### Domains and influence workflow

Only artist → movies and artist → videogames, independently conditioned on the original artist ID. Retrieve ten per domain; display the first three usable candidates per domain. Preserve original ranks, including gaps. No reranking by an LLM, affinity blending, second hops, or paid enrichment.

A proposal contains a short source context and one proposed interaction. The creator can accept, reject, or edit it. There are **two independent influence slots**, named **Discovery** and **Commitment**. At most one approved interpretation per slot; at least one approved Qloo interpretation is required for a newly generated “Qloo-grounded” scene. Either domain can supply either slot. Do not force a weak videogame proposal merely to fill both domains.

### Scene, revision, and sharing

One object-centered encounter with a small deterministic action/state model. The creator can remove, edit, or replace one influence; make one ending's wording kinder; compare versions; replay; publish a read-only link; and download one offline HTML playable. The publish action previews exactly what will be public. A published link names one immutable version, never “whatever is latest.” No accounts, collaboration, comments, public gallery, or marketplace.

**Saved example:** one canonical pre-generated example, with its revision and model-selected comparator, served as static deployment assets. Clearly label it “Saved example · pre-generated.” “Try an edit” creates an independent session-owned project copy. Merely playing the example does not create a database record or consume upstream quota.

**Fresh path:** a separate, fully working “Create from your brief” action. Never quietly substitute the saved example for a failed fresh generation.

### Scope classes

**MUST HAVE:** the complete fresh and saved loops; verified Qloo identity and first-hop provenance; explicit approval; mechanically meaningful influences; shared runtime/validator; safe targeted revision; immutable versions; public playback; offline HTML export; honest failures; a lightweight comparison; keyboard and mobile usability.

**SHOULD HAVE, only after all must-haves pass:** a second visual paper/object skin, a one-click replay of the last action sequence, and a printable one-page pitch summary.

**DO NOT BUILD:** anything listed in §18. No extra domain is authorized by this freeze.

## 2. Primary user journey

| Step | User action and visible change | Backend/model/Qloo action | Persisted state |
|---|---|---|---|
| 1. Brief | Enter premise and fixed details; the stage shows a clean scene cover. | Validate text/size fields deterministically; establish anonymous owner session. | Project, frozen brief revision. |
| 2. Resolve | Search artist and confirm a name with disambiguating metadata. | One cached `/search`; no model-based identity substitution. | Confirmed artist ID and search snapshot. |
| 3. Retrieve | “Finding references” becomes two compact domain rows. | Two first-hop Qloo requests, parallel under a global limiter. | Immutable normalized reference captures and cache status. |
| 4. Candidates | See up to three movies and three games, with short supported context. | Local normalization and quality filtering; no extra API call. | Candidate IDs and skip reasons. |
| 5. Propose | Each usable card gains “Try this interaction.” | One structured model request over the brief and trimmed eligible evidence; at most one repair. | Proposal objects, including exact evidence IDs. |
| 6. Decide | Accept, reject, or edit; accepted slots appear as compact chips. | Validate and freeze creator decisions. Edited wording is previewed before approval. | Immutable decision revisions; increment project revision counter. |
| 7. Compile | “Writing the encounter,” then “Building Discovery/Commitment.” | Generate a brief-only base if absent. Independently compile each approved module. Each stage is a bounded request. | Operation stage outputs and frozen input hashes. |
| 8. Validate | “Checking choices”; successful scene replaces the cover. | Shared deterministic validator, module-subset checks, influence witnesses; bounded local repair only. | Validated immutable SceneVersion, validation report, and pending activation preview. |
| 9. Play | Preview and confirm the interaction; inspect, ask, decide; the scene changes locally. | No model, Qloo, or gameplay mutation request. | Local playthrough state, keyed by version ID. |
| 10. Revise | Open one influence and change its intended effect. | Freeze a new decision; use the existing evidence packet. | Decision revision and pending revision operation. |
| 11. Recompile | Previous scene remains playable beside a “Revision in progress” indicator. | Compile only the changed module; removal needs no model. Validate every supported module subset. | New version only on success; old version is untouched. |
| 12. Compare | Previous/current switch plus a plain-language mechanical difference. | Compute structural diff and a replay witness. No model needed for a difference label. | Diff and replay prefix attached to the new version. |
| 13. Publish | Review public title, scene, and optional provenance; publish or export. | Create immutable publication after revalidation; export trusted runtime plus inert JSON. | Publication → exact SceneVersion. |

A page refresh can resume a persisted operation at the last completed stage. It does not silently restart completed upstream calls. Changing the brief or artist after generation starts a new project branch with a new base; it is not presented as a tiny influence revision.

## 3. UI/UX specification

### Layout and visual language

Use an editorial, theatrical creative-tool aesthetic: an ink-colored stage, warm paper for the important object, restrained amber for actionable emphasis, and muted neutral panels. No neon AI gradients or graph backdrop. These are design choices, not generated imagery.

Desktop layout: a 56-pixel top bar, a collapsible 280-pixel brief panel, and the playable stage taking the rest. The influence drawer opens on the right at approximately 360 pixels and is closed during normal play. A small bottom strip shows version name, replay, compare, and publish. The first fold should show the object, the NPC's current line, and the available choices—not a stack of evidence cards.

Use a system serif for scene titles and narrative passages; system sans-serif for controls. Narrative text around 18 pixels with generous line spacing and a 60–70 character measure; control text no smaller than 14 pixels. Use an 8-pixel spacing rhythm, 24–32-pixel panel padding, subtle borders, and a calm hierarchy. No paid fonts or media assets. Use first-party CSS shapes and handwritten-looking layout treatment for the letter, not generated SVG from a model.

### Stage and interaction

The one object is the visual anchor: a tactile card that can open to reveal plain text. NPC dialogue appears in a readable block with a name tag. Choices are full-width, clear verbs, not tiny hotspot-only interactions. Show at most five currently available actions; use a readable scroll area if needed, never hide mandatory actions offscreen without indication.

A clicked choice updates the transcript and gently changes the object/character presentation. Effects are immediate; transitions last approximately 120–220 milliseconds. No forced typewriter effect, automatic scrolling that steals focus, flashing, autoplay audio, or timed decisions. Respect reduced-motion settings.

Unavailable actions can remain visible with a lock and an accessible explanation supplied by the validated scene. Do not expose hidden ending names during ordinary play. In comparison mode, explicitly show “Return is now unavailable” when that is the demonstrated change.

### Brief, influences, provenance, and revision

The brief panel shows premise and “Fixed” chips for room, character, object, and format. It does not show raw prompts.

Candidate cards show title, domain, one context sentence, and one interaction proposal. Put Accept / Edit / Dismiss immediately under the interaction—not under an affinity score. Reveal no more than six cards initially. Default accepted count is zero. Selection never implies approval.

Approved influences become two small chips. Clicking one opens a drawer with its approved wording, intended effect, and “Where this appears.” Provenance is one nested disclosure, not a separate dashboard (§13).

A revision preview says what is changing before it is applied. A resulting diff contains at most three default lines: interaction changed; outcome availability changed; fixed details preserved. A developer JSON diff stays out of the product.

### States

Empty stage: a designed scene cover and two choices, “Play saved example” and “Create your scene.” Empty references: explain the missing domain and keep the other domain usable. No artist match: preserve the form and ask for spelling or another explicit artist.

Loading: truthful stage labels and elapsed time, with cancel/back available. Do not invent percent completion or show an unvalidated partial scene as playable. During revision, keep the old version visible and playable.

API failure: a compact inline message, retry control where appropriate, and a path to the saved example. Preserve every approved decision. A repair failure never produces an endless spinner or overwrites a valid scene.

Share view: title, stage, replay, and optional source disclosure only. No owner controls or private brief notes. Phone layout: stage first, controls below it, brief/influences in accessible sheets; compare versions one at a time. Test at 390-pixel width and 1440-pixel desktop width.

## 4. Authoritative scene schema

### Central representation

Store a frozen **CoreScene** plus zero to two **InfluenceModules**. The runtime composes these directly. Do not flatten them into an anonymously generated blob and then attempt to infer ownership afterward.

The world has one room, one NPC, a first-person player role, and one object. The base is generated from the brief alone and cannot read artist names, Qloo packets, proposals, approvals, or previously composed scenes.

Two fixed attachment ports keep modules small:

| Slot | May add its own variables/actions/dialogue | May gate these base actions | May attach own effects/dialogue after these base actions |
|---|---|---|---|
| `discovery` | Yes, within budget | `core.give` | `core.inspect` |
| `commitment` | Yes, within budget | `core.ask_terms`, `core.withhold` | `core.ask_context` |

Both slots may inspect core flags, but neither may read the other slot's state, actions, dialogue, or approval. A module cannot mutate base variables, replace base dialogue, change the world, add characters/objects, or alter another slot. It may introduce up to four new `inspect`/`ask` actions and gate the assigned terminal choice. Module actions do not terminate the scene directly.

The base always contains `core.inspect`, `core.ask_context`, `core.ask_terms`, `core.give`, `core.withhold`, and `core.leave`. Terminal verbs map respectively to `end.give`, `end.keep`, `end.leave`. The first two actions establish object/request understanding. `core.ask_terms` expresses an explicit commitment that closes the “keep” option. The foundation must make this commitment intelligible in the story. It can add up to four brief-driven interaction actions within its remaining flag budget; it is not allowed to solve cultural interpretation before approval.

This intentionally constrains the encounter to an object handover dilemma. It is not an expandable quest engine.

### Types and limits

Use strict Zod objects with unknown keys rejected; derive TypeScript types from the schemas. Export provider-facing JSON Schema from the same Zod shapes, with a tested transformation for unsupported provider features. Do not maintain a second handwritten validation schema. Zod documents JSON Schema conversion, and Gemini documents structured output plus subsequent application validation [W4, W9].

```ts
type Id = string; // 1..64 ASCII chars: /^[a-z][a-z0-9_.-]*$/
type Slot = "discovery" | "commitment";
type Verb = "inspect" | "ask" | "give" | "withhold" | "leave";
type Atom = { var_id: Id; equals: boolean };
type Condition =
  | { kind: "always" }
  | { kind: "never" }
  | { kind: "any"; clauses: Atom[][] }; // OR of AND clauses; at most 4x4

type Effect = { op: "set_true"; var_id: Id };
type StateVariable = { id: Id; label: string; initial: false; visible: boolean };
type Target = { kind: "room" | "character" | "object"; id: Id };
type DialogueNode = { id: Id; speaker_id: Id; text: string };
type ActionBranch = {
  when: Condition; effects: Effect[];
  dialogue_id: Id | null; ending_id: Id | null;
};
type Action = {
  id: Id; verb: Verb; label: string; target: Target;
  when: Condition; branches: ActionBranch[];
};
type Ending = { id: Id; title: string; text: string };
type Room = { id: Id; name: string; description: string };
type Character = { id: Id; name: string; role: string };
type ImportantObject = { id: Id; name: string; description: string };
type CoreScene = {
  variables: StateVariable[]; actions: Action[];
  dialogue: DialogueNode[]; endings: Ending[];
};
type Gate = {
  id: Id; action_id: Id; when: Condition; blocked_text: string;
};
type OnAction = {
  id: Id; action_id: Id; when: Condition;
  effects: Effect[]; dialogue_id: Id | null;
};
type InfluenceModule = {
  slot: Slot; approval_id: Id; variables: StateVariable[];
  actions: Action[]; dialogue: DialogueNode[];
  gates: Gate[]; on_actions: OnAction[];
};
type Port = { gate_action_ids: Id[]; effect_action_ids: Id[] };
type InfluenceReference = {
  approval_id: Id; reference_id: Id;
  source_kind: "qloo" | "model_selected" | "design_fixture";
  approved_text: string; intended_effect: string;
};
type Provenance = { approval_id: Id; mechanic_ids: Id[] };
type EndingCopyOverride = {
  ending_id: Id; text: string; creator_edit_id: Id;
};
type Scene = {
  schema_version: "1.0"; scene_id: Id; title: string;
  world: {
    player_role: string; room: Room;
    characters: [Character]; object: ImportantObject;
  };
  core: CoreScene; ports: Record<Slot, Port>;
  modules: InfluenceModule[]; ending_copy_overrides: EndingCopyOverride[];
  influences: InfluenceReference[]; provenance: Provenance[];
};
```

**Identifier resolution:** `player` and `narrator` are reserved speaker IDs, not additional NPCs. A dialogue speaker must be one of those or the sole declared NPC ID. Reject world/entity IDs that collide with the reserved speakers. World IDs and declared action/state/dialogue/gate/hook/ending IDs are unique in their appropriate registry; references must resolve to the correct kind, not merely a matching string. Core definitions use `core.*`, endings use the three fixed `end.*` IDs, and module definitions use their exact slot prefix. Scene/approval/reference record IDs are opaque application IDs, not executable definitions. The two port maps must equal the fixed table above; model output cannot add a new attachment port.

Application reference IDs are not Qloo UUIDs. Real Qloo identity lives in the persisted source packet and is checked server-side. The server—not the model—assigns scene IDs, approval IDs, source kinds, publication metadata, hashes, and provenance bindings. No scene can self-authorize an approval by including a plausible ID.

**Budgets:** core ≤6 booleans, each module ≤3; total ≤12. Core ≤10 actions, each module ≤4, total ≤18. Core ≤12 dialogue nodes, each module ≤6. At most three gates and two on-action attachments per module. Exactly three endings; at most three nonoverlapping branches per action. All text fields have individual caps: action label 90 characters, dialogue 600, ending text 1,200, gate explanation 160. Total narrative text ≤12,000 Unicode code points; serialized scene ≤96 KiB UTF-8. Strings contain plain text only. Proposed interpretation ≤500 characters; approved interpretation ≤700.

### Condition/effect semantics

Conditions are data, never expression strings. `any` requires one to four clauses, each containing one to four atoms; use `always`/`never` for constants. Reject duplicate or contradictory atoms in a clause. `set_true` is the **only effect**. There are no counters, floats, timers, inventory quantities, random numbers, toggles, decrement operations, recursive dialogue transitions, templates, scripts, or executable URLs.

All flags begin false. Evaluate action visibility, every gate, branch choice, and on-action conditions against the **pre-action state**. An available action must select exactly one branch. Then apply the union of permitted `set_true` effects atomically. Show the branch dialogue, followed by matching owned on-action dialogue in fixed slot order. Finally show an ending if the branch names one. Ending text overrides replace only that ending's text.

Every enabled nonterminal action must set at least one previously false flag. Therefore a run cannot have more than twelve nonterminal transitions plus a terminal action. Re-reading previous dialogue is a UI operation, not another game action. Gates can depend on a flag being false: an irreversible disclosure can permanently close an ending even though flags only move forward.

### Representative JSON

This intentionally short, hand-authored **design fixture** demonstrates the schema and revision mechanism; it is not the final 2–4 minute demo copy. Its `design_fixture` source label must remain until replaced by captured Qloo evidence and a real recorded approval. The full fixture is valid JSON, with no placeholder Qloo UUID or invented API metadata.

```json

{
  "schema_version": "1.0",
  "scene_id": "fixture_second_copy_v1",
  "title": "The Second Copy",
  "world": {
    "player_role": "Station attendant",
    "room": {
      "id": "counter",
      "name": "Lost-property counter",
      "description": "The station is closing. You have one letter left to return."
    },
    "characters": [
      {
        "id": "nia",
        "name": "Nia",
        "role": "Visitor asking for her letter"
      }
    ],
    "object": {
      "id": "letter",
      "name": "Sealed letter",
      "description": "One envelope, left behind earlier today."
    }
  },
  "core": {
    "variables": [
      {
        "id": "core.inspected",
        "label": "Letter inspected",
        "initial": false,
        "visible": false
      },
      {
        "id": "core.context",
        "label": "Request understood",
        "initial": false,
        "visible": false
      },
      {
        "id": "core.promised",
        "label": "Return promised",
        "initial": false,
        "visible": false
      }
    ],
    "actions": [
      {
        "id": "core.inspect",
        "verb": "inspect",
        "label": "Inspect the letter",
        "target": {
          "kind": "object",
          "id": "letter"
        },
        "when": {
          "kind": "any",
          "clauses": [
            [
              {
                "var_id": "core.inspected",
                "equals": false
              }
            ]
          ]
        },
        "branches": [
          {
            "when": {
              "kind": "always"
            },
            "effects": [
              {
                "op": "set_true",
                "var_id": "core.inspected"
              }
            ],
            "dialogue_id": "core.inspect_text",
            "ending_id": null
          }
        ]
      },
      {
        "id": "core.ask_context",
        "verb": "ask",
        "label": "Ask why she came back",
        "target": {
          "kind": "character",
          "id": "nia"
        },
        "when": {
          "kind": "any",
          "clauses": [
            [
              {
                "var_id": "core.context",
                "equals": false
              }
            ]
          ]
        },
        "branches": [
          {
            "when": {
              "kind": "always"
            },
            "effects": [
              {
                "op": "set_true",
                "var_id": "core.context"
              }
            ],
            "dialogue_id": "core.context_text",
            "ending_id": null
          }
        ]
      },
      {
        "id": "core.ask_terms",
        "verb": "ask",
        "label": "Promise to return it",
        "target": {
          "kind": "character",
          "id": "nia"
        },
        "when": {
          "kind": "any",
          "clauses": [
            [
              {
                "var_id": "core.inspected",
                "equals": true
              },
              {
                "var_id": "core.context",
                "equals": true
              },
              {
                "var_id": "core.promised",
                "equals": false
              }
            ]
          ]
        },
        "branches": [
          {
            "when": {
              "kind": "always"
            },
            "effects": [
              {
                "op": "set_true",
                "var_id": "core.promised"
              }
            ],
            "dialogue_id": "core.promise_text",
            "ending_id": null
          }
        ]
      },
      {
        "id": "core.give",
        "verb": "give",
        "label": "Return the letter",
        "target": {
          "kind": "object",
          "id": "letter"
        },
        "when": {
          "kind": "any",
          "clauses": [
            [
              {
                "var_id": "core.inspected",
                "equals": true
              },
              {
                "var_id": "core.context",
                "equals": true
              }
            ]
          ]
        },
        "branches": [
          {
            "when": {
              "kind": "always"
            },
            "effects": [],
            "dialogue_id": null,
            "ending_id": "end.give"
          }
        ]
      },
      {
        "id": "core.withhold",
        "verb": "withhold",
        "label": "Keep the letter",
        "target": {
          "kind": "object",
          "id": "letter"
        },
        "when": {
          "kind": "any",
          "clauses": [
            [
              {
                "var_id": "core.inspected",
                "equals": true
              },
              {
                "var_id": "core.context",
                "equals": true
              },
              {
                "var_id": "core.promised",
                "equals": false
              }
            ]
          ]
        },
        "branches": [
          {
            "when": {
              "kind": "always"
            },
            "effects": [],
            "dialogue_id": null,
            "ending_id": "end.keep"
          }
        ]
      },
      {
        "id": "core.leave",
        "verb": "leave",
        "label": "Walk away",
        "target": {
          "kind": "room",
          "id": "counter"
        },
        "when": {
          "kind": "any",
          "clauses": [
            [
              {
                "var_id": "core.inspected",
                "equals": true
              },
              {
                "var_id": "core.context",
                "equals": true
              }
            ]
          ]
        },
        "branches": [
          {
            "when": {
              "kind": "always"
            },
            "effects": [],
            "dialogue_id": null,
            "ending_id": "end.leave"
          }
        ]
      }
    ],
    "dialogue": [
      {
        "id": "core.inspect_text",
        "speaker_id": "narrator",
        "text": "The envelope is still sealed. Nia watches your hands rather than your face."
      },
      {
        "id": "core.context_text",
        "speaker_id": "nia",
        "text": "I left it here on purpose. That does not mean I stopped wanting it back."
      },
      {
        "id": "core.promise_text",
        "speaker_id": "player",
        "text": "All right. I will return it. Keeping it is no longer an honest option."
      }
    ],
    "endings": [
      {
        "id": "end.give",
        "title": "Returned",
        "text": "Nia takes the letter without opening it. The decision is hers again."
      },
      {
        "id": "end.keep",
        "title": "Held",
        "text": "You keep the letter. Nia leaves you responsible for a story you cannot read."
      },
      {
        "id": "end.leave",
        "title": "Unanswered",
        "text": "You step away from the counter. Neither of you has agreed to the other person’s ending."
      }
    ]
  },
  "ports": {
    "discovery": {
      "gate_action_ids": [
        "core.give"
      ],
      "effect_action_ids": [
        "core.inspect"
      ]
    },
    "commitment": {
      "gate_action_ids": [
        "core.ask_terms",
        "core.withhold"
      ],
      "effect_action_ids": [
        "core.ask_context"
      ]
    }
  },
  "modules": [
    {
      "slot": "discovery",
      "approval_id": "approval_discovery_v1",
      "variables": [
        {
          "id": "discovery.found",
          "label": "Contradiction noticed",
          "initial": false,
          "visible": false
        },
        {
          "id": "discovery.disclosed",
          "label": "Contradiction discussed",
          "initial": false,
          "visible": false
        }
      ],
      "actions": [
        {
          "id": "discovery.ask_identity",
          "verb": "ask",
          "label": "Ask about the two names",
          "target": {
            "kind": "character",
            "id": "nia"
          },
          "when": {
            "kind": "any",
            "clauses": [
              [
                {
                  "var_id": "discovery.found",
                  "equals": true
                },
                {
                  "var_id": "discovery.disclosed",
                  "equals": false
                }
              ]
            ]
          },
          "branches": [
            {
              "when": {
                "kind": "always"
              },
              "effects": [
                {
                  "op": "set_true",
                  "var_id": "discovery.disclosed"
                }
              ],
              "dialogue_id": "discovery.discuss_text",
              "ending_id": null
            }
          ]
        }
      ],
      "dialogue": [
        {
          "id": "discovery.inspect_text",
          "speaker_id": "narrator",
          "text": "Under the address, a second name has been pressed into the paper. Both signatures look like Nia’s."
        },
        {
          "id": "discovery.discuss_text",
          "speaker_id": "nia",
          "text": "They are both mine. Ask which promise I can keep now, not which name came first."
        }
      ],
      "gates": [
        {
          "id": "discovery.return_gate",
          "action_id": "core.give",
          "when": {
            "kind": "any",
            "clauses": [
              [
                {
                  "var_id": "discovery.disclosed",
                  "equals": true
                }
              ]
            ]
          },
          "blocked_text": "Discuss the two names before returning the letter."
        }
      ],
      "on_actions": [
        {
          "id": "discovery.inspect_hook",
          "action_id": "core.inspect",
          "when": {
            "kind": "always"
          },
          "effects": [
            {
              "op": "set_true",
              "var_id": "discovery.found"
            }
          ],
          "dialogue_id": "discovery.inspect_text"
        }
      ]
    }
  ],
  "ending_copy_overrides": [],
  "influences": [
    {
      "approval_id": "approval_discovery_v1",
      "reference_id": "fixture_moon",
      "source_kind": "design_fixture",
      "approved_text": "Inspection reveals an identity contradiction. Discussing it is required before returning the letter.",
      "intended_effect": "Inspection unlocks a question; that question unlocks the return action."
    }
  ],
  "provenance": [
    {
      "approval_id": "approval_discovery_v1",
      "mechanic_ids": [
        "discovery.ask_identity",
        "discovery.return_gate",
        "discovery.inspect_hook"
      ]
    }
  ]
}

```

A small offline reference calculation performed while preparing this specification found five reachable nonterminal states in the base, eight in the shown version, and eight in its revised version. All three endings are reachable in each. The revised version changes the gate on `core.give` to require `discovery.disclosed == false` and changes only the module's explanation/dialogue and its new approval record. After the identical prefix `inspect → ask context → ask about the two names`, return is available in the original and unavailable in the revision; the core is unchanged. This checks the proposed example's logic, **not** an implemented TypeScript application or live compiler.

## 5. Deterministic validation

Use the same pure functions in browser, Node tests, server acceptance, and HTML export:

```ts
parseScene(input: unknown): Scene
initialState(scene: Scene): State
availableActions(scene: Scene, state: State): AvailableAction[]
step(scene: Scene, state: State, actionId: Id): StepResult
validateScene(scene: Scene, brief: Brief): ValidationReport
composeScene(core: CoreScene, modules: InfluenceModule[]): ComposedView
compareVersions(before: Scene, after: Scene): RevisionDiff
```

`validateScene` is pure gameplay/schema validation and has no database dependency. A separate server-side `validateCompilation(scene, brief, approvalSnapshot)` wrapper checks authority against an explicit frozen snapshot and then calls that same pure validator. Hand-authored fixture tests require no database; they cannot mint a production Qloo badge. `composeScene` returns an effective view of core/modules; world, fixed ports, and permitted creator copy overrides remain in the enclosing Scene. In particular, composition never mutates either input.

Browser loading performs shape checks before rendering; server publication additionally requires the full validation report for the exact scene/schema/validator hash. A Web Worker may run the same graph analysis in the editor so it does not freeze the UI. It is not a second engine.

### Layer A — schema and authority

Reject unknown fields, invalid IDs/enums, excessive sizes, wrong types, extra world entities, malformed conditions, non-`set_true` effects, and invalid speaker/action targets. `inspect` targets the object; `ask` targets the NPC; `give`/`withhold` target the object; `leave` targets the room. Every reference resolves. Namespace ownership is checked, not trusted from model-provided prose.

Compare world names/roles/object/room against the frozen brief. Enforce exact entity counts, action vocabulary, ending IDs, and forbidden literal wording. Literal matching uses Unicode normalization and case-insensitive complete word/phrase matching; do not claim a ban on a word proves absence of its concept. Counts and named structured fields are hard constraints; narrative faithfulness remains a human check.

Require one authoritative approved decision for each module, correct source provenance, and unique slot assignment. Fixture and model-selected sources cannot receive a Qloo-grounded production badge. The allowlist is loaded from the database snapshot, never from the client or the generated Scene itself.

### Layer B — graph/gameplay

Represent state as a stable ordered bitset of at most twelve flags. Exhaustively explore **reachable** states. The theoretical nonterminal bound is 2^12 = 4,096; terminals are outcomes, not flags. Include every legal player action and every resulting state. Dialogue history is not part of the graph and cannot affect conditions.

Check:

1. Exactly one branch applies to every reachable enabled action. Every nonterminal edge adds a true flag; any no-progress edge fails. Every ending has a reachable path and every declared action/branch is usable somewhere. Permanently dead critical or decorative branches fail rather than silently disappearing.
2. Every reachable nonterminal state has a legal continuation to an ending. Compute the reachable-ending set `E(s)` by reverse traversal of the acyclic state graph. Being globally reachable is not enough if another path can soft-lock.
3. At least one **nonterminal choice** reduces the reachable ending set: for an edge `s → s'`, `E(s')` is a strict subset of `E(s)`. This rejects the old pattern in which all endings remain available until the last menu. A terminal choice does not satisfy this test.
4. At least one nonterminal action also changes a later legal action or ending reachability, rather than only unused flags or narration. Each approved module must have an executed binding and a mechanical witness when present versus absent.
5. Every ending requires at least three actions from the initial state. Runtime depth is at most thirteen actions; presentation duration is separately playtested.
6. No unattached variables, unresolvable IDs, forbidden writes, cross-slot reads, unbounded transitions, or unused claimed provenance bindings.

Validate the base and **every subset of active modules**: base alone, each module alone, and both together where applicable. There are at most four subsets. This makes later removal safe and catches interactions even though module ownership is separate.

The validator must never silently stop exploration and report success. On time/resource budget exhaustion—set a five-second graph-analysis ceiling per candidate operation—return `VALIDATION_RESOURCE_LIMIT`. Profile this ceiling in deployment; changing it cannot change the finite-state contract. Bound the witness search too; an unproven mechanical witness is a failed mechanical acceptance, not presumed success.

### Mechanical witnesses

First compare a version with the same version minus one module. Replay a common legal action prefix in both. Report the first changed legal action set, reachable-ending set, or downstream state-dependent branch. An introduced action may be the first divergence; it must itself lead to a downstream interaction/end consequence, not just extra prose. Use a bounded paired-state traversal when a simple prefix comparison is insufficient. At twelve flags per scene, cap paired-state exploration at 20,000 pairs and stop explicitly on overflow.

For edited modules, compare old/new under their identical untouched foundation and other modules. Strip narrative strings and source labels before computing a mechanical signature. A renamed flag or arbitrary ID is not sufficient proof: require an observable action/end consequence in replay.

### Layer C — creative quality

The validator does **not** prove good writing, faithful artistic interpretation, kindness, originality, emotional impact, 2–4 minute duration, or superiority over a baseline. Review these manually. Do not add an “AI creativity score.” A readable but structurally invalid scene cannot publish; a structurally valid but weak scene still needs editorial work.

## 6. Qloo integration layer

### Typed surface

```ts
resolveArtist(query: string): Promise<ArtistSearchSnapshot>
getMovieReferences(artistId: QlooUuid): Promise<ReferenceCapture>
getVideogameReferences(artistId: QlooUuid): Promise<ReferenceCapture>
```

No general-purpose Qloo proxy and no caller-supplied URL or parameter object. A supporting entity-detail endpoint is **not** required in the MVP: the confirmed search snapshot verifies artist identity, and the insights response supplies reference identity/context. If an actual payload lacks needed context, skip that candidate instead of adding speculative enrichment.

### Exact request patterns

```http
GET https://hackathon.api.qloo.com/search?query=<encoded artist>&types=urn:entity:artist&take=5
X-Api-Key: <server secret>

GET https://hackathon.api.qloo.com/v2/insights?filter.type=urn:entity:movie&signal.interests.entities=<confirmed artist UUID>&take=10
X-Api-Key: <server secret>

GET https://hackathon.api.qloo.com/v2/insights?filter.type=urn:entity:videogame&signal.interests.entities=<same confirmed artist UUID>&take=10
X-Api-Key: <server secret>
```

These are the shapes supported by the supplied live reports [E2 §§2–5; E3 §§1–3]. Do not add trends, popularity floors, explainability, tags, audiences, weights, arbitrary filters, or pagination to this path. The general recon used popularity floors for tag-only queries; that is not justification for inventing a floor for this entity-only path.

### Normalization and usable evidence

Normalize search `types[]` separately from insights type/subtype, and search `tag_id` separately from insights tag `id`. Preserve identity, name, domain, original rank, retrieval timestamp, request fingerprint, returned affinity if present, and observed source-field names. Ignore unknown harmless upstream fields; fail on a malformed required identity or incompatible response envelope.

For movies, allow supported short description, plot/theme context, tone/style context, and relevant keywords. For videogames, allow only descriptions/tags actually returned; do not create a rich summary from model memory to hide thin metadata. Each evidence item has an ID, its raw observed field path, bounded original text, and a hash. The reports name logical fields but not every exact JSON nesting path: phase 3 must pin those mappings from a real capture.

A reference is usable if it has a valid Qloo UUID, correct domain, nonempty name, and at least one relevant descriptive field or interpretable tag group. A year may be null. Deduplicate by entity ID. Do not require a year or movie-style plot synopsis for a game. Identity-only rows may be displayed as unavailable for interpretation, but cannot drive an approval.

Trim each candidate to a maximum of approximately 1,200 characters of source context; up to six eligible candidates enter proposal context. Retain field boundaries and evidence IDs. Never send full raw responses, hundreds of tags, images, demographic fields, long marketing/audience claims, headers, or affinity scores to the compiler. Raw affinity is private diagnostic information, not creativity quality or an endorsement.

**Metadata is source-provided context, not independently verified fact.** Prefer UI wording “Qloo describes…” or “Retrieved context” over “Qloo proves…”. If no evidence supports a proposed abstraction, the creator may author their own idea, but it must be labeled creator-authored and cannot masquerade as Qloo-supported evidence.

### Identity and silent-failure defense

Always require the creator to select/confirm a returned artist. Do not silently choose the top result, auto-correct spelling into a different artist, or invent a UUID. Present available short description and external identity hints as disambiguation, not as extra taste inference.

The adapter emits only the three frozen request shapes. Check returned domains, UUIDs, response success/error shapes, and the returned query echo where present. If the echo contradicts the confirmed anchor or requested domain, fail. Absence of an echo is not itself proof of failure; preserve the exact outbound request and flag echo unavailability. HTTP 200 cannot prove every parameter was applied. Contract tests and pinned payloads are the defenses; do not advertise detection of every silently ignored parameter.

### Timeouts, retries, caching, and quota

Use verified TLS. Never carry over the Windows antivirus workaround by disabling verification. Normal deployed Node HTTPS verification stays on. API key lives only in the server environment.

Use an 8-second artist-search timeout, 25-second insights timeout, and bounded response-body reads, maximum 3 MiB per response. Permit **one** retry for connection failure, 429, or 5xx; respect `Retry-After` when it fits a 60-second stage budget. Never retry 400/401/403 or malformed successful output automatically. Apply small jitter to transient retries. Retries consume quota.

A database-backed reservation function spaces all Qloo launches by at least 250 milliseconds, with at most two active request leases. This is a conservative four-launches-per-second policy, globally across serverless instances. Do not rely on a per-process semaphore. Do not hold a database transaction during network I/O. Concurrent local research using the same key is outside this limiter; stop those scripts during the demo.

Cache keys: normalized query + artist type + search schema version; or API host + confirmed artist UUID + output domain + exact parameters + normalizer version. Search TTL 24 hours; empty search TTL 10 minutes; first-hop TTL seven days. A frozen scene references its original immutable capture even after the lookup TTL expires. A stale fallback may use that exact artist/domain capture up to 30 days old **only with an explicit stale-data label and creator consent**. Never relabel stale data as live or substitute another artist.

Expected uncached creation: **three Qloo calls**, one search and two first hops. At most six including the one retry on each. Further searches are separately visible user actions with their own quota reservations. Revisions, replay, publishing, baseline playback, and module removal use **zero Qloo calls** unless the creator explicitly starts a new cultural context.

Store returned remaining-quota headers where available; treat local counters conservatively when headers are missing. Keep a configurable reserve for judging. The observed 10,000-call rolling window includes errors [E3 §1]; do not assume a calendar-month reset or unlimited hackathon usage.

## 7. Influence pipeline and isolation

### Records

| Stage | Required fields and meaning |
|---|---|
| `QlooReference` | Application reference ID; real entity UUID/name/domain; original anchor UUID; original rank; capture ID/time; evidence items with field paths and hashes; missing-field flags. No preference-truth claim. |
| `ProposedInterpretation` | Proposal ID; reference ID; selected evidence IDs; slot; at most 500-character idea; concrete intended interaction; relevance explanation explicitly marked model interpretation. |
| `CreatorDecision` | Project/revision; proposal snapshot; `accept`, `reject`, or `edit`; final text; selected slot; timestamp. No default acceptance. |
| `ApprovedInfluence` | Immutable approval ID; source reference/evidence IDs; frozen approved text and intended effect; slot; authoritative current status. Creator editing changes the interpretation, never the stored Qloo evidence. |
| `SceneMechanic` | Independently owned module; actual action/gate/effect bindings; validator-generated replay witness; approved-influence ID. |

Proposals may abstract an interaction from the evidence. They may not assert that Qloo itself recommended the mechanic, invent reference attributes, infer the user's true taste, or copy characters/dialogue/settings from a reference.

### Context firewall

Implement separate payload builders with unit tests:

```ts
buildBasePayload(brief)                  // only brief; no culture
buildProposalPayload(brief, references) // proposed ideas, never executable
buildModulePayload(base, approval)      // one immutable approval + its selected evidence
```

No mutable chat transcript, previous provider-interaction ID, shared agent memory, or full-project prompt is allowed. A module compiler receives the brief-only base and **only its own approved evidence/interpretation**. It does not receive rejected proposals, unselected reference titles, the artist query, or the other module. The server constructs payloads from its own frozen database snapshot, not from a client-supplied `approved=true` flag.

Before compilation, pending and rejected proposals are excluded. After compilation, rejecting an influence removes its module, its source/provenance bindings, and any module-owned presentation text. Recomposition starts from the clean base; it is not a request to “forget” something inside an already contaminated scene. Earlier versions remain available as labeled historical versions, not as the current approved output.

This enforces **dataflow and ownership isolation**. It cannot prove a language model will never independently invent a semantically similar idea from the brief or its training. Do not promise that stronger guarantee. Influence removal restores the clean base representation and removes that module's executable contribution; it does not erase historical artifacts or human memory.

### Approval semantics

Editing a proposal opens an editable interpretation and intended-effect field. Clicking “Preview interpretation” may use one bounded structured call to clarify it; this is not approval. The creator must click “Approve this interaction” on the final preview. Accepting a second proposal for an occupied slot is an explicit replacement with a visible before/after, never a hidden merge.

The authoritative compilation input includes the project revision counter, brief hash, base hash, and approved IDs. On completion, a compare-and-swap check ensures those values still match. A stale result can be retained as an operation artifact, but cannot become the active/published version. The validator can verify the executed mechanical change and source binding, not perfect semantic faithfulness to free-form approval wording. Before activation, show the compiled interaction summary with a replay preview and require the creator to confirm it reflects the approved idea; declining preserves the previous version. This confirmation never broadens the original approval or silently changes its text.

## 8. Model and orchestration strategy

### Provider and bounded controller

Use **Gemini Developer API, `gemini-3.8-flash`**, one model for proposal, base, module, copy-only ending revision, and repair. Its current official pricing lists free-tier input/output; structured JSON output is documented [W3, W4]. This is a selected provider/model, not a tested quality guarantee. Run an account/model/schema smoke test in phase 2 and record the actual available quota. No paid fallback, no credit-card upgrade, and no silent switch to another provider.

Use the official `@google/genai` SDK behind one small `generateStructured<T>()` adapter. Follow its current documented structured-output interface; do not hardcode an obsolete API example from memory. Supply a JSON schema, enforce response size, parse JSON, then Zod-validate and run application checks. Provider-level schema compliance does not establish gameplay validity. Disable hidden SDK retry loops; the application owns retry budgets. Send independent calls without prior conversation handles.

Free-tier prompts/output may be used to improve Google's products [W3]. State this before fresh creation and prohibit confidential/client material in the demo form. This is a public creative prototype, not a confidentiality-preserving studio tool.

### State machine

```text
DRAFT → ANCHOR_CONFIRMED → REFERENCES_READY → PROPOSALS_READY
      → AWAITING_APPROVAL → BASE_READY → MODULES_READY
      → VALIDATING → REVIEW_PLAYABLE → READY → REVISION_PENDING → REVIEW_PLAYABLE → READY
                                      ↘ FAILED (previous READY preserved)
```

There is no model call for brief parsing, domain choice, approval checking, cache choice, validation, diffing, or publication. The domains are fixed. “Planning” is the approved interaction contract plus the module's structured action/state plan, not another autonomous agent.

**Model stages:** one batch proposal call; one brief-only core call per frozen brief; one independent module call per approved slot; one module call for a genuine interpretation revision; optional single-target ending-copy call. A structural repair sees the same allowed context, failed draft, and concise deterministic errors. It cannot retrieve more references, alter the brief, add approvals, or change another module.

### Limits and execution lifetime

First creation with two influences normally costs four model calls: proposals + core + two modules. Each model stage permits one structural/content-contract repair, so the full worst case is eight calls. With one influence it is three normal calls, six at the repair ceiling. Removal costs zero; an edited module costs one generation plus at most one repair. Clarifying a user-edited proposal is a separately counted call before approval.

Use at most 45,000 characters of context per stage and 32,000 characters of returned model text; smaller caps for proposals and modules. Individual provider call timeout: 60 seconds. An operation-stage request has a 75-second application deadline. Reject truncation/refusal as a failed stage; do not parse the partial text as a scene. A retry of a transport failure and a repair both count against that stage's two-attempt ceiling. Do not stack separate invisible retry budgets.

**No detached serverless jobs.** A persisted operation advances through one model stage per `POST /api/operations/:id/advance`. The browser requests the next stage after the previous one commits. A database lease prevents duplicate work; an idempotency key identifies each stage. The route can stream small status events, but must finish within its bounded invocation. A closed browser does not imply continued background generation. Reopening resumes committed stages; an interrupted ambiguous provider request is explicitly marked for retry and conservatively counted as consumed.

The controller, not the browser, chooses the next valid stage. Do not expose arbitrary tools or a user-specified state transition. A failure returns a stable code and preserves approvals. When an attempt budget is exhausted, stop and show the last valid scene, not a degraded unvalidated replacement.

## 9. Revision semantics

The revision unit is a **whole small influence module**, not a whole scene and not arbitrary JSON Patch. This is the smallest reliable boundary that preserves ownership without inventing a dependency engine.

| Request | Implementation | What must remain identical |
|---|---|---|
| Reject an influence | Remove its module and bindings; revalidate/recompose; no model/Qloo call. | Base, world, other modules, other approvals. |
| Edit interpretation | New immutable approval; compile only that slot against the clean base. | Base/world/other module hashes. |
| Replace influence | Explicit replacement approval using an existing reference capture; compile that slot. | Unrelated definitions and accepted slots. |
| Make an ending kinder | Select one ending; generate a text-only `EndingCopyOverride`; preview/apply explicitly. | Every variable, condition, effect, action, and other ending text. |
| Preserve characters/location | They are frozen structured world fields outside module output. | Exact IDs/names/roles/object/room values. |
| Change premise or artist | New project branch and explicit fresh compilation. | Old project remains available; no false “small revision” claim. |

“Kinder” is a writing judgment. Label this **wording change**, not mechanical change. It can never rewrite a gate or make an ending reachable. Copy overrides cannot carry Qloo provenance merely because the scene has Qloo influences. The ending-copy payload contains only the frozen brief, that ending's base/current creator-edited wording, and the explicit wording request. It never receives influence modules, cultural evidence, rejected ideas, or a whole composed transcript. Thus a copy operation cannot become an unowned path for retained cultural-module text after rejection.

Compose a new version only from the immutable base, current approved modules, and explicit creator ending-copy overrides. Compare canonical serialization hashes for every untouched owned object. Validate the revised version and all removal subsets before activation.

**Play state:** start a new run after revision. Do not migrate old flags into a changed module. Preserve the previous version and its local playthrough separately. “Replay the same choices” re-executes stored action IDs from initial state in the new version; stop at the first unavailable action with a readable explanation. Do not copy raw state snapshots across schema/version boundaries.

**RevisionDiff:** `before_version_id`, `after_version_id`, `changed_slot`, added/removed action IDs, changed gate/effect bindings, affected endings, unchanged core/world/module hashes, `mechanical_change` boolean, a replay prefix with before/after observations, and copy-only changes separately. Generate summary sentences from these fields deterministically.

If an edit changes only prose, show “Wording changed; interaction unchanged.” Do not fabricate a mechanical success. A creator can keep a copy-only edit, but the canonical submission loop must demonstrate a real gate/consequence change.


## 10. Architecture and exact stack

### Selected implementation

| Layer | Decision | Reason |
|---|---|---|
| Application | Next.js App Router, React, TypeScript, Node route handlers | One repository and deployment; the same language and engine on both sides. |
| Contracts | Zod, TypeScript types inferred from Zod, exported JSON Schema | One authoritative runtime contract, not matching-but-different Python and JS engines. |
| Presentation | CSS Modules/global design tokens, system sans/serif, CSS-created room/object artwork | No purchased assets, runtime image generation, external font dependency, or graphics engine. |
| Runtime/validator | Pure TypeScript, no React/server dependencies inside the engine | Browser, server, tests, and offline export execute the same transition rules. |
| Database | Supabase free Postgres; SQL migrations; server-only `@supabase/supabase-js` | Small persistent relational records and atomic RPCs without an ORM or separate database server. |
| Hosting | Vercel Hobby, Node runtime for API routes | One noncommercial hackathon deployment; bounded request-based orchestration. |
| Model | Gemini Developer API, `gemini-3.8-flash`, official `@google/genai` | Currently documented free structured generation; one provider, not a routing framework. |
| Qloo | Typed adapter using native `fetch` | Three operations, exact parameter allowlist, explicit cache and quota behavior. |
| Cache | Normalized Qloo captures and TTL indexes in Postgres; static example assets | No Redis, vector database, or additional deployment. |
| Public play | Read-only version snapshot on the same application; static canonical example | Playback is client-side after the initial scene load. |
| Testing | Vitest for pure/server logic; Playwright for browser behavior | Test the actual shared engine and public route, not a parallel test implementation. |

Use current compatible stable package releases at phase 1, pin exact versions in `package-lock.json`, and record the Node version in `.nvmrc`/`engines`. Do not guess patch versions in this document or install prerelease frameworks for novelty. Next.js route handlers and Zod JSON Schema support are documented [W9, W10].

### Deployment facts versus deployment gates

Official documentation checked on **3 October 2026** supports this cost route, but does not prove this user's accounts are configured or approved:

- **Vercel:** Hobby is free for personal, noncommercial use, with finite allowances [W1]. Its documented Fluid Compute Node function maximum is 300 seconds; our route deadline is 75 seconds [W2]. Confirm that the submitted personal hackathon prototype fits those terms. No paid upgrade is authorized.
- **Supabase:** the free plan lists a 500 MB database and 5 GB egress, and may pause a project after one week of inactivity [W6]. Do not promise permanent uptime. The static canonical example is deliberately independent of database availability.
- **Gemini:** the selected model currently lists free input/output. Free-tier content can be used to improve Google products [W3]. Actual account RPM/TPM/RPD must be read in AI Studio; Google documents project-specific rate limits rather than a universal allowance [W5]. Keep billing disabled and prohibit confidential source material.
- **Qloo:** the supplied report verifies this particular key's operational quotas, not its expiry date or rights to redistribute all metadata [E3]. Verify hackathon-key validity through judging and permission for the proposed minimal evidence cache/public excerpts before publishing. Store short necessary context, not a mirror of Qloo's catalog.

**Phase-2 go/no-go record:** account eligibility, working zero-billing deployment, model name/schema smoke-test result, actual quotas, database access, and owner-visible budget configuration. **Phase-7 record:** Qloo key validity/terms, remaining allowances, demo and share access through judging, tested recovery from a paused database. Missing confirmation is an explicit release blocker, not a reason to silently enable billing or call a mock a working fresh path.

Do not use a Docker Space as the assumed free Python host: current Hugging Face documentation requires a paid plan to create Docker/Gradio Spaces even when CPU Basic runtime has no hourly charge [W11]. This is why the chosen architecture does not depend on that route.

### Text architecture diagram

```text
Browser: brief / influence approval / player / version comparison
       │ same-origin, session-owned API requests
       ▼
Next.js Node routes
  ├── bounded operation controller ──► Gemini structured generation
  ├── typed Qloo adapter ────────────► search + two first-hop requests
  ├── ownership + budget + publish checks
  └── shared TS composer / validator
       │
       ▼
Supabase Postgres
  projects · captures · decisions · versions · publications
  sessions · operations · atomic budget reservations

Validated Scene JSON ──► shared TS browser engine ──► local gameplay
                                      └───────────► offline HTML export
Static saved example / revision / comparator ──────► same browser engine
```

There is no model or Qloo arrow from gameplay. Reading an uncached public share initially needs the application/database; playing an already loaded share does not. Static example playback needs neither database nor upstream inference.

### Repository boundary

```text
src/app/                         pages and bounded API route handlers
src/components/studio/           brief, influences, version strip, provenance
src/components/player/           trusted renderer and action controls
src/domain/                      scene, brief, influence, operation Zod schemas
src/engine/                      pure interpreter, composer, validator, diff
src/server/qloo/                 client, normalization, captures, limiter
src/server/model/                SDK adapter and isolated payload builders
src/server/workflow/             stage controller and revision commands
src/server/db/                   owner-scoped repositories and atomic RPC calls
src/server/security/             sessions, origin checks, budgets, error redaction
src/export/                      trusted offline player bundler/template
fixtures/                        design fixtures and redacted adapter fixtures
public/examples/                 published, verified saved example assets
supabase/migrations/             database schema and atomic functions
scripts/                        fixture checks and explicit opt-in live smoke tests
tests/                          contract, runtime, isolation, API, browser tests
docs/                           this specification, phase evidence, release notes
```

Preserve existing `recon/` and `probes/` work. Do not delete raw local captures or rewrite historical experiment conclusions. Gitignore secrets and sensitive raw responses.

## 11. Persistence model and API boundary

### Eight small tables

| Table | Essential fields | Persistence rule |
|---|---|---|
| `sessions` | ID, hash of random owner cookie, created/last-seen/expiry times | Anonymous ownership; 60-day expiry, refreshed by real owner activity. Never expose the hash or cookie. |
| `projects` | ID, owner session ID, frozen brief/world, confirmed anchor, revision counter, reference pointers, active approval IDs, clean-base JSON/hash, active version, workflow state | Mutable current pointers; every consequential edit increments the revision counter. |
| `qloo_captures` | ID, kind, request fingerprint, normalized query/artist/domain, normalized results/evidence, time, cache expiry, quota diagnostics, normalizer version | Immutable capture contents. An expired lookup is not deletion of evidence linked to a version. |
| `influence_decisions` | ID, project, decision kind, slot, proposal snapshot, selected evidence IDs, creator text, timestamp, predecessor ID | Append-only decisions. Current approval is a project pointer, not mutation of historical approved text. |
| `scene_versions` | ID, project, parent, input hashes, effective scene, base/module hashes, validation summary/witnesses, revision diff, model/prompt/schema identifiers | Immutable, validated versions only. Failed candidate JSON remains a short-lived operation artifact. |
| `publications` | ID, owner/project, immutable scene-version ID, read-token hash, whitelisted public snapshot, created/revoked times | One link = one version. Revocation does not delete its private source version. |
| `operations` | ID, project, input revision/hash, stage, status, attempts, idempotency key, lease deadline, bounded outputs/errors | Resumable checkpoints, not a general job queue or tracing warehouse. |
| `budget_buckets` | Scope/key, window, reserved calls/tokens, launch schedule, active request leases | Atomic safety counters; TTL cleanup for expired windows/leases. |

Brief, anchor, and current proposal drafts can be JSONB fields on the project; do not create one table per schema type. Scene versions contain their own approved provenance snapshots so historical views do not silently change with today's approvals.

Use database transactions/RPCs for stage reservation and commit, revision compare-and-swap, quota reservation, and publication. A completion may activate only when owner, project revision, base hash, and approval IDs still match. Client retries with the same idempotency key must return the same committed result without another model call.

**Retention:** preserve published snapshots, linked evidence, and validated history through judging. Do not apply cache expiry to historical scene evidence. Expire abandoned operation drafts after seven days; expire unused lookup captures after 30 days if no scene references them. Do not delete a published snapshot just because its owner's session expires. Losing the owner cookie loses editing access; state this before creation. Account recovery and cross-device ownership are out of scope. Owner-requested deletion/revocation is supported; general long-term archival is not promised.

### Minimal route contract

All mutating routes validate Origin, session ownership, body size, Zod input, and idempotency where relevant. Route names below are the frozen public surface; internal functions may be split for testing.

| Method/path | Behavior |
|---|---|
| `POST /api/session` | Establish the anonymous owner cookie; no upstream request. |
| `POST /api/projects` | Create a valid frozen brief or explicitly clone the saved example. |
| `GET /api/projects/:id` | Owner-only studio state, excluding secrets/provider diagnostics. |
| `POST /api/projects/:id/artist-search` | Cached typed artist search. |
| `PUT /api/projects/:id/anchor` | Confirm one result from the associated search snapshot. |
| `POST /api/projects/:id/references` | Get/cache the two allowed first hops for that confirmed anchor. |
| `POST /api/projects/:id/proposals` | Create a bounded proposal operation, not an arbitrary prompt request. |
| `POST /api/projects/:id/decisions` | Append an explicit accept/reject/edit decision; preview is not approval. |
| `POST /api/projects/:id/compile` | Freeze current approved inputs and create a compilation operation. |
| `POST /api/projects/:id/activate` | Creator confirms a validated preview matches the approved idea; compare-and-swap current version. |
| `POST /api/projects/:id/revisions` | Typed remove/edit/replace/ending-copy command; enforce preservation rules. |
| `POST /api/operations/:id/advance` | Perform the next permitted stage, at most one provider attempt per invocation. |
| `GET /api/operations/:id` | Owner-only checkpoint/status. No polling request initiates work. |
| `POST /api/projects/:id/publish` | Publish a selected valid immutable version after explicit preview. |
| `DELETE /api/publications/:id` | Owner-only revocation. |
| `GET /api/public/:token` | Whitelisted read-only snapshot; no project/private history. |
| `GET /api/projects/:id/export?version=<id>` | Owner-only self-contained HTML export of a validated version. |

The page `/play/:token` loads the public snapshot; `/example` loads static verified assets. A public viewer cannot edit the creator's project, discover other versions, retrieve rejected ideas, or turn a read token into an owner capability.

Return errors as `{ code, message, retryable, last_good_version_id, request_id }`. A missing foreign project and a nonexistent project produce the same public-facing response. Never return raw provider headers, SQL errors, prompt dumps, or API keys.

## 12. Security, resource control, and reliability

### Secrets and ownership

Keep `QLOO_API_KEY`, `GEMINI_API_KEY`, and the Supabase service credential in server-only environment variables. Never use `NEXT_PUBLIC_` for them. The browser does not connect to Supabase directly. Enable row-level security with deny-by-default client access; the service-role repository must still enforce owner scoping on every query. Test cross-session access rather than assuming RLS protects service-role calls.

Set an opaque cryptographically random owner cookie with `Secure`, `HttpOnly`, and `SameSite=Lax`; hash its secret value in storage. Use same-origin mutation checks and JSON content types. A read share token is separately generated with at least 128 bits of entropy, hashed for lookup, and carries no owner authority. Explain: “Anyone with this link can play this version.” Use `noindex` on shares; this is not a confidentiality guarantee.

Unpublished projects are not public, but free-provider processing is not a promise of confidentiality. Do not collect personal profiling data, payments, copyrighted source uploads, or confidential client scripts in this MVP.

### Application budgets

Body cap: 16 KiB for creator command requests. Only trusted server output can produce a larger scene snapshot within the 96 KiB scene limit. Reject oversized or recursively nested JSON before expensive validation. Limit field lengths, proposal counts, model context/output, state-space size, and outgoing response reads as specified earlier.

Default anonymous-session allowances: five projects/day, two complete fresh compilations/day, eight influence/copy revisions/day, and twenty explicit artist searches/day. Count failed attempts and replayed requests consistently. Limit one active generation operation per project and two active provider calls globally. Add shared per-IP burst limits; do not treat IP as identity or block a university's entire network merely because one session hits a limit.

At phase 2, set the global model rate to the **lower** of the account's verified allowance with a 20% reserve and the application's intended cap. Do the same for TPM/RPD, reserving conservatively before a call and reconciling reported usage afterward. Do not manufacture a fixed universal free quota. The default global daily model-call cap is 40, reduced when the verified allowance is lower. Owner development/tests consume the same real allowance; report them separately in the budget screen. A full-generation operation is admitted only if its maximum remaining attempt budget fits the daily reserve.

For Qloo, reserve 500 of the observed remaining monthly calls for judging once that many remain; halt anonymous fresh retrieval before crossing that reserve. This is a local safety decision, not a new claim about the API's quota. Keep the administrator budget view out of the public scene and exclude it from the main creative UI.

On insufficient capacity, return an honest cooldown or exhausted-budget state with the last valid scene and saved example still usable. Do not open an unbounded waiting queue, start paid billing, or display a fake generation animation.

### Untrusted model/metadata handling

Qloo text and creator text are data, never system instructions. The model receives no credentials and no autonomous browsing or code-execution tools. Never follow URLs contained in Qloo/model text. Model JSON can propose only the allowed data structures. Reject extra fields, executable expression strings, unknown verbs, forged approvals, foreign IDs, unsupported schema versions, and altered immutable fields.

Render narrative text using React's normal escaping or `textContent`. No `dangerouslySetInnerHTML`, arbitrary Markdown HTML, `eval`, `Function`, model SVG, or model-produced script/template. CSP must prohibit untrusted script sources. Instrument outgoing requests in tests to catch accidental provider or Qloo calls during play.

### Export and share safety

The export consists of a **build-time trusted player bundle**, trusted styles, and inert validated scene data. Escape `<`, `>`, `&`, and Unicode line separators in serialized JSON, or encode the data as base64 decoded by the trusted loader. The scene can never terminate a script element or introduce markup. Use a compatible restrictive CSP for the known bundled script/style; no CDNs or external assets. The exported file must run from `file://` with the network blocked and cannot contain server credentials, ownership cookies, private proposals, or rejected references.

Public views expose only approved public source excerpts and current version metadata. Validate schema/version again at load, fail safely on corrupt data, and show “This playable could not be loaded” rather than execute an approximate version. Share revocation is honored after at most a five-minute response-cache window. Previously downloaded HTML or copied content cannot be remotely revoked; tell the creator that before export/publication.

### Failure behavior

| Condition | What the creator sees | Backend behavior |
|---|---|---|
| Artist unresolved | “No matching artist. Try the exact spelling.” | No invented identity, no downstream retrieval. Preserve brief. |
| Ambiguous artist | Explicit candidate confirmation | Never silently choose a different artist. |
| Qloo timeout | Retry action; optionally consent to a matching dated cached capture | One bounded automatic retry; no mislabeled live data. |
| Movie list empty | Movie row reports no usable context; games may continue | Allow generation with at least one supported approved game influence. |
| Game list empty/thin | Game row reports no usable context; movies may continue | No model-created game metadata. |
| Both domains unusable | “No supported influences available for this artist.” | Do not generate a scene advertised as Qloo-grounded. Offer another confirmed artist or saved example. |
| Model refuses/fails/returns truncated data | Stage-specific failure with retry budget and retained inputs | No invalid partial scene; no unapproved provider fallback. |
| Scene or module invalid | “This draft did not pass the interaction checks.” | At most one permitted repair using the same isolated inputs. |
| Repair exhausted | Last valid version stays playable; approval can be edited or removed | Stop the operation; do not silently replace the entire scene or relax validation. |
| Approval changed during generation | “Your choices changed; this older result was not applied.” | Compare-and-swap rejects activation of stale output. |
| Database unavailable/paused | Saved example remains available; fresh/save/share status is honest | No ephemeral disk pretending to be persistent storage. |
| Public token invalid/revoked | Clean unavailable screen | Do not reveal the owner's project or identity. |
| All influences removed | “No active Qloo influence” above the preserved base | Keep it playable/exportable; remove the active grounding badge. Historical versions remain labeled. |

## 13. Provenance UX

The main stage has at most two small approved-influence chips. Clicking one opens a contextual drawer, not a separate analytics screen. Four stacked lines expose the chain:

**Qloo retrieved** — reference title/domain, short source-provided context, original artist, capture date, and cached/live-at-retrieval label. Expand to see the evidence field and original response rank; do not present an affinity percentage as creative confidence.

**FirstPlayable proposed** — one sentence explaining the creative abstraction. It is explicitly a model interpretation, not a Qloo assertion.

**Creator approved** — exact frozen wording, with an “Edited by you” indicator when applicable. The current approval is distinguished from historical approvals.

**Scene changed** — an engine-generated explanation of the affected action or ending, plus “Replay this difference.” Example: “Asking about the second name now closes Return the letter.” This sentence comes from the verified version diff, not a model claiming its own success.

A subtle marker on an affected action can open this same drawer. Do not put source tags on every line of dialogue. Source lists, raw IDs, ranks, and field paths belong behind a second disclosure. The public share includes the approved chain only; private rejected proposals and diagnostic request metadata are never included.

A provenance chain is an inspectable record of retrieval, interpretation, decision, and implementation. It is not proof that the resulting mechanic could only have been invented with Qloo.

## 14. Lightweight baseline comparison

There are **two distinct comparisons**, with distinct claims.

### A. The product's main comparison: one influence changed or removed

This is available for normal versions. Keep the foundation and unrelated modules identical; replay a common action sequence. The engine reports changed action availability or endings. Removal uses no model/Qloo calls. This answers **“What executable contribution did this approved influence make here?”** It is an intervention on this implementation, not an evaluation of Qloo's predictive or creative superiority.

Do not call the clean foundation a fair creative competitor. It deliberately lacks approved cultural modules and is an ablation, labeled “Without this influence.”

### B. One canonical model-selected comparison

Prepare this once for the saved example, outside the fresh-generation critical path. It uses the same frozen brief, same artist, same clean foundation, same model, same schema, same renderer, same one-influence approval budget, same output caps, and same repair ceiling as the canonical Qloo example.

An independent, no-Qloo call selects up to three films and three games and proposes candidate interpretations. It receives the brief and artist but no Qloo results, previous scenes, approved Qloo interpretation, or comparison target. Any recalled descriptive context is labeled **model-supplied, not Qloo-verified**. Do not pretend it was retrieved or fact-checked. The creator applies the same written criterion on both sides: a supported-within-its-labeled-packet idea, expressible in the Discovery port, that changes a player interaction and does not break the brief. Record the selection and approval rather than substituting an intentionally weak idea.

Compile that approved interpretation through the identical independent module path. Keep the first valid output under the same repair discipline. Do not forbid overlap with Qloo's references, repeatedly regenerate until Qloo looks better, or hide a baseline that happens to be more appealing. If both produce the same mechanic, say so; the creator-edit comparison remains the product's main demonstration.

Cache the comparator under a fingerprint of brief/base/model/prompt/schema/approval versions. Render side by side only when space permits; otherwise use equally styled tabs. Let the judge play and compare. No numeric quality score, winner badge, significance claim, or manufactured benchmark result.

**Permitted claim:** Qloo supplied these actual reference candidates, the creator approved this interpretation, and this version contains this observable consequence. **Not permitted:** Qloo objectively made a better game, established taste truth, or supplied an idea an LLM could not invent.

## 15. Canonical saved example — “The Second Copy”

### Observed Qloo evidence

Use **Radiohead**, verified artist UUID `70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C` [E2 §4]. The supplied reports observed these first three movie references: **Children of Men**, **Being John Malkovich**, **Moon**; and these first three games: **Mass Effect 2**, **Dragon Age: Origins**, **Mass Effect** [E1 §4; E2 §5].

The FirstPlayable report specifically records that the Moon packet describes a protagonist who discovers a duplicate of himself [E1 §10]. That is the source context for the proposed interpretation below. The reports do not provide all six reference UUIDs or complete game-context payloads. Recover the existing raw captures from the user's repository or make the two real first-hop calls in phase 3. Never fabricate those IDs, timestamps, or field paths.

Only **Moon → Discovery** is approved by default. The other movie/game candidates are genuinely retrieved and inspectable, but unapproved and excluded from compilation. This is intentional: one strong approved influence is better than pretending thin game metadata supports a second one.

### Proposed original brief

> At a station's lost-property counter, just before closing, Nia asks you to return the sealed letter she left earlier. You are the attendant. Decide what to ask, whether to promise its return, and whether to give it back, retain it, or leave the decision for tomorrow.

World: one counter/room, one NPC Nia, one letter. The player is the attendant. Tone: intimate tension. No combat, supernatural claim, extra object, inventory, or generated art. The visual focus is the letter, the quiet counter, and the visitor's words—not film imagery.

### Approved interpretation v1

> Borrow the idea of a contradictory identity, not the film's plot. Inspecting the letter reveals two names. Before returning it, ask Nia about that contradiction.

This is a **proposed creator-approved abstraction**, not something Qloo itself stated about how to design the game.

| Action | State/consequence |
|---|---|
| Inspect the letter | `core.inspected = true`; owned hook sets `discovery.found = true`; show two names. |
| Ask why she returned | `core.context = true`; the request becomes clear. |
| Ask about the second name | `discovery.disclosed = true`; return gate opens in v1. |
| Promise its return | `core.promised = true`; retaining it closes in the unchanged foundation. |
| Return the letter | `end.give`: she takes it; one specific dialogue outcome. |
| Keep it until tomorrow | `end.keep`, only without the explicit return promise. |
| Leave the decision | `end.leave`: neither side forces resolution tonight. |

All three endings are reachable, but a promise can genuinely foreclose one before the final menu. There is no claim that every player must visit every action.

### One explicit influence revision

Change only the approved Discovery interpretation:

> Inspecting the letter still reveals the contradiction privately. Raising it with Nia makes her refuse the letter. You can return it before that question, but not afterward.

Recompile only Discovery. Preserve the room, character, object, foundation, other approvals, and ending-copy overrides exactly. The central gate changes from `discovery.disclosed == true` to `discovery.disclosed == false`. The module's own explanation/dialogue updates to make the refusal intelligible.

**Visible same-choices comparison:** inspect → ask why she returned → ask about the second name.

| After that exact prefix | v1 | v2 |
|---|---|---|
| Return the letter | Available | Closed |
| Keep until tomorrow | Available if no promise | Available if no promise |
| Leave the decision | Available | Available |
| Meaning of disclosure | A prerequisite to handing over | An irreversible reason handover is refused |

In v2, returning remains globally reachable by doing it before disclosure. The revision does not accidentally delete an ending from the entire scene.

### What has and has not been checked here

The short JSON fixture in §4 and its revised gate were checked with a small Python reference traversal during preparation of this specification. The clean base had five reachable nonterminal states; each influenced variant had eight. All three endings were reachable in all three forms. The same three-action prefix enabled `core.give` in v1 and disabled it in v2, while the serialized foundation remained identical.

That is a **hand-designed logic check**, not evidence that the production TypeScript validator, model compiler, live Qloo adapter, UI, or deployment exists or has passed. Phase 1 must independently run these checks using the actual shared TypeScript engine. Phase 6 must expand/edit the narrative into a human-tested 2–4 minute experience without changing the demonstrated semantics.

### Saved versus fresh behavior

Bundle verified v1, verified v2, and the honestly constructed model-selected comparator as versioned static assets. Label all as pre-generated. Applying the exact saved revision may load its matching cached version instantly, labeled “Saved revision.” Any other edit goes through the real controller; it cannot be answered by the cached preset while claiming fresh generation.

A guided “Replay the same choices” executes the listed actions through the engine from initial state. It does not inject flags or show a scripted video posing as a game. Fresh creation with another premise and an explicitly confirmed supported artist must also work before submission.

## 16. Technical acceptance tests

Keep tests focused on trust boundaries and observable product behavior, not impressive counts.

| Test group | Exact acceptance criterion |
|---|---|
| Schema | Unknown keys, unsupported verbs, expression strings, invalid IDs/types, oversized JSON, over-budget flags/actions, and malformed conditions are rejected. Valid fixture parses identically in Node and browser. |
| Transition semantics | Pre-state evaluation, unique branch selection, atomic `set_true`, gate conjunction, hook ordering, and termination match one shared implementation. Repeating an action cannot create a no-progress loop. |
| Reachability | Exhaustive traversal finds all three endings; every reachable state can reach one; a nonterminal choice strictly reduces available endings; dead branches and overflow fail explicitly. |
| Module subsets | The base, each single module, and both modules pass all core gameplay invariants. Removal cannot create an unresolved reference or soft-lock. |
| Mechanical witness | Canonical same-prefix replay makes `core.give` available in v1 and unavailable in v2. A prose-only or renamed-flag modification is not falsely declared mechanical. |
| Context isolation | Insert distinct sentinel strings into rejected/unselected proposals and another slot. Outgoing core/module payloads contain only their permitted inputs. No previous provider conversation handle is sent. |
| Rejection | Reject before compile: no rejected evidence enters the compiler. Reject after compile: every owned variable/action/gate/hook/dialogue/provenance binding disappears from the active composition, with untouched hashes unchanged. |
| Revision | Edit Discovery: world/core/Commitment hashes are identical; v1 remains playable; state restarts safely. Ending-copy edit changes only one override and is labeled nonmechanical. |
| Concurrency | Change an approval while a mocked provider request is pending: stale result cannot activate. Double-submit an idempotent stage: at most one upstream attempt is made. |
| Qloo parsing | Pinned search/movie/game captures normalize correctly. Wrong type/UUID, empty context, duplicate IDs, partial rows, error-shaped 200s, and a contradictory query echo are handled without invented evidence. |
| Qloo caching/budget | Repeating a supported cached retrieval causes zero upstream calls. Fresh normal path makes one search plus two first hops. Retries stay within six calls. Global reservations prevent more than four launches per second across simulated instances. |
| Structured model boundary | Truncated JSON, refusal, foreign approval IDs, cross-slot writes, prompt-injection text, and invalid output schemas never reach the player. Attempt ceiling stops the controller. |
| Ownership/share | Session B cannot read/edit/publish A's private project. A public token reads only its immutable approved snapshot. Revocation works within the stated cache window. |
| XSS/export | Strings containing `</script>`, HTML event handlers, or URLs render as text. Offline HTML runs from disk with all requests blocked; no credentials/private drafts appear in its bytes. |
| Playback | After initial load, a complete playthrough, reset, and replay cause zero Qloo/model calls and no gameplay server writes. Static example also loads without Supabase. |
| UI/failure | Keyboard-only completion and influence editing work; focus is visible; 390px and 1440px widths have no clipped critical actions. Timeout/exhaustion preserves the last valid version and shows a real recovery action. |

Add an explicit **live** smoke suite that is opt-in and never runs automatically on each commit. Before release, successfully create and play three fresh briefs using Radiohead, Taylor Swift, and Metallica, each with at least one real approved influence, within the declared attempt budgets. This is a release smoke test, not a statistically meaningful model-quality estimate. Record every failure and fix; do not report only selected successes.

Also perform one real arbitrary interpretation edit—not just the saved preset—and one remove operation on the deployed app. All resulting accepted versions must satisfy the same preservation and reachability checks. A mocked integration suite alone does not establish fresh creation works.

## 17. Seven hard, focused build phases

Each phase is a fresh Claude Code session. Read this specification, inspect the existing repository, preserve earlier research, and work on one dedicated build branch. Do not start the next phase until the binary exit gate passes. Keep `docs/BUILD_STATUS.md` with completed phase, commands/results, known failures, and the next authorized phase. Do not add features merely because an agent finishes early.

### Phase 1 — Shared scene contract, engine, and offline vertical slice

**Goal:** make one hand-authored scene and its revised influence genuinely playable and provably valid without any external service.

**Exact deliverables:** repository skeleton and lockfile; `docs/FIRSTPLAYABLE_V2_BUILD_SPEC.md`; `src/domain/scene.ts` and brief constraints; `src/engine/{interpreter,compose,validate,diff}.ts`; the design fixture and edited variant; a minimal `/example` player with inspect/ask/give/withhold/leave, dialogue, endings, reset, and version switch. The same pure engine serves UI and tests. Add a script that extracts/checks fixtures and an initial `BUILD_STATUS.md`.

**Acceptance criteria:** one command starts the local player; all three endings are reachable; the same three choices open return in v1 and close it in v2; base hashes match; removal restores the base; every subset validates; invalid scenes fail with readable errors. No network key or account is required. No arbitrary JavaScript generated from content is executed.

**Tests:** strict parsing; exact action semantics; exhaustive reachability and ending closure; no-progress action rejection; owned-state restrictions; mechanical versus text-only diff; one browser play/reset/version-switch test.

**Do NOT do:** Qloo calls, model integration, Supabase, auth, production deployment, influence proposal generation, fancy motion, the comparison baseline, new schema features, or a rewrite of research reports.

**Exit artifact:** an offline local playable vertical slice, green `typecheck`, `test`, `test:e2e`, and `build`, plus a short test-result record. It need not be visually final, but must be usable and structurally correct.

### Phase 2 — Persistent shell and zero-paid deployment preflight

**Goal:** establish trustworthy project ownership, persistence, budgets, and the actual deployment path before building generation on assumptions.

**Exact deliverables:** SQL migrations for §11; server-only repositories; anonymous session/origin checks; atomic operation/approval/budget RPCs; owner-only project routes; minimal studio shell; private admin budget configuration; first Vercel/Supabase deployment. Add the small Gemini adapter and one opt-in schema smoke command, not the full compiler. Record verified free-tier/account/model details in `docs/DEPLOYMENT_PREFLIGHT.md` without secrets.

**Acceptance criteria:** a project survives reload/redeployment; another session cannot access it; owner cookie is not in JS; shared budget reservations and idempotency work; the deployed static example remains playable with database access disabled; a real account/model structured-output smoke call succeeds without billing enabled.

**Tests:** cross-session access; missing-Origin/oversized mutation rejection; atomic duplicate-stage reservation; quota exhaustion; database outage UI; secret scan of built public assets.

**Do NOT do:** social login, accounts/recovery, queues, Redis, a general agent platform, full provider benchmarking, or paid upgrades. A failed preflight blocks later integration until resolved explicitly.

**Exit artifact:** deployed persistent shell with functioning saved player, documented account gates, and one verified structured-output call.

### Phase 3 — Real Qloo references and explicit influence approval

**Goal:** retrieve authentic supported context and let the creator approve a concrete interaction without contaminating the future compiler.

**Exact deliverables:** three-operation Qloo adapter; strict normalization from real redacted captures; global rate reservations; cache behavior; artist-confirmation UI; compact movie/game cards; structured proposal stage; explicit approve/reject/edit controls; immutable approval records; payload-builder isolation tests; source/proposal/approval drawer.

**Acceptance criteria:** a confirmed artist produces real first-hop references in both supported domains when covered; unknown artists fail honestly; no API key reaches the browser; context comes only from captured fields; zero approvals are selected by default; rejected ideas are absent from module payload previews; game gaps are not silently enriched. Cache hits make no upstream call. Canonical Moon identity/context is recovered, not invented.

**Tests:** supplied/pinned response shapes; malformed/partial/empty domains; timeout/429 retry budget; same-artist cache; global limiter; disambiguation; approval transitions; injection/sentinel exclusions. One opt-in real retrieval smoke run, with call count recorded.

**Do NOT do:** extra domains, multi-hop calls, taste percentages, generated game descriptions, core compilation, or a dashboard of raw responses.

**Exit artifact:** deployed studio where a fresh brief can obtain real references and freeze one or two valid approvals, with an inspectable provenance chain.

### Phase 4 — Bounded compilation and fresh playable generation

**Goal:** turn those explicit approvals into validated, independent executable modules on a clean base.

**Exact deliverables:** brief-only core prompt/schema; one module prompt/schema per slot; persisted stage controller; independent model calls; input hashes and compare-and-swap; deterministic semantic validation; subset validation; mechanical witnesses; bounded repair; last-good-version behavior; saved immutable SceneVersion.

**Acceptance criteria:** a fresh brief with one approved influence produces a playable scene through real Qloo and model calls; two-slot composition also works; no pending/rejected/other-slot evidence enters a module prompt; each active module has a mechanical witness; all supported removal subsets are valid; a stale result cannot activate; repair never exceeds its declared attempt ceiling.

**Tests:** real engine plus mocked provider branches for success/refusal/invalid/repair exhaustion; approval change during execution; context payloads; subset conflicts; cache reuse; exact upstream attempt counts. One recorded real fresh end-to-end run.

**Do NOT do:** a planner/researcher/critic crew, arbitrary whole-scene patches, unrestricted conditions, generated code, paid fallback, or hiding compiler failure with the saved example.

**Exit artifact:** a fresh scene that plays without upstream calls after generation, with truthful failure and retry behavior.

### Phase 5 — Targeted revision, immutable sharing, and offline export

**Goal:** make the central “change one idea, replay the consequence” loop reliable and shareable.

**Exact deliverables:** remove/edit/replace commands; ending-copy override; module-only recompilation; hash-preservation diff; common-choice replay; previous/current version controls; publication preview and version-pinned read tokens; revoke; public player; trusted offline HTML export.

**Acceptance criteria:** removal costs zero model/Qloo calls; a real edit changes one module only; unrelated hashes match; v1 remains playable; public viewer cannot mutate/read private state; exported HTML works offline; published/exported data excludes rejected proposals and secrets. Mechanical and wording-only changes receive different labels.

**Tests:** identity and hash preservation; same-prefix divergence; foreign-session publication; immutable version link; revocation; offline network block; script-breakout strings; corrupt scene load; public playback with provider calls forbidden.

**Do NOT do:** collaboration, public gallery, account recovery, arbitrary JSON Patch, state migration between versions, or editable public owner links.

**Exit artifact:** a deployed fresh scene that can be revised, compared, published, and exported safely.

### Phase 6 — Creative-tool polish and canonical judge experience

**Goal:** make the playable artifact—not the plumbing—the immediately understandable hero.

**Exact deliverables:** §3 visual system; room/object composition; compact brief and influence drawer; responsive actions; keyboard/focus/reduced-motion states; human-edited canonical copy; actual saved v1/v2 captures/approvals; one fair model-selected comparator; transparent saved-versus-live labels; the 60-second path. Finalize `docs/DEMO_SCRIPT.md` and sample publication.

**Acceptance criteria:** the first screen explains the product in one sentence and offers immediate play; the stage dominates at desktop/mobile widths; three people unfamiliar with the implementation can identify the brief and describe the changed interaction without reading architecture notes; canonical full play is approximately 2–4 minutes in manual tests; the saved gate revision is unmistakable. A real arbitrary edit and fresh path remain available, not replaced by staged buttons.

**Tests:** focused browser journey, keyboard completion, responsive critical controls, reduced motion, canonical source labels, parity of comparator presentation, static example with all upstream services disabled.

**Do NOT do:** 3D, generated sound/voice/art, larger branching stories, third influence slot, extra benchmark rounds, or new concepts. Do not repeatedly weaken or reroll the comparator to manufacture a win.

**Exit artifact:** polished deployed demo with truthful cached examples, one observable influence revision, and a fair optional comparison.

### Phase 7 — Release hardening and submission evidence

**Goal:** submit a publicly accessible working product with tested live and degraded paths, accurate claims, and no secrets.

**Exact deliverables:** final live smoke record; security/budget/error tests; database/key/quota checks through judging; clean public README, environment template, setup commands, license, limitations, and architecture explanation; deployed URLs; submission copy; short demo recording; `docs/RELEASE_CHECKLIST.md` with exact commit/deployment identifiers.

**Acceptance criteria:** all §16 checks pass; three recorded fresh-brief/artist runs and one arbitrary edit complete within fixed budgets; static example and offline export play with upstream access blocked; no secret in repo/history/build/export; public share works in a new browser; no stuck loading state after timeout; Qloo access and evidence-publication permissions are confirmed; remaining free quotas are sufficient for the documented judge path. No paid service is silently required.

**Tests:** full CI; deployed happy path; deployed cold/database-unavailable path; provider/Qloo timeout and quota exhaustion; public route privacy; first-load and mobile usability; README clean-checkout instructions.

**Do NOT do:** late architecture migration, new capabilities, claims that the original experiment passed, unsupported win probabilities, or replacing measured failures with a promotional narrative.

**Exit artifact:** public source and licensed repository, functional deployed application, shareable playable, demo recording, and an honest completed release checklist.

## 18. Explicit non-goals

**Product:** no alternative ideation, general-purpose game platform, open world, RPG system, combat, multiplayer, inventory, quests, long campaigns, procedural maps, marketplace, collaboration, comments, public gallery, game IDE, or drag-and-drop engine editor.

**Culture:** no third domain, second-hop source-persistence assumption, culture graph, preference inference, demographic profiling, trending prediction, heatmap, local operational discovery, podcast opportunity discovery, affinity-as-quality score, or “Qloo proves aesthetic compatibility” claim.

**Architecture:** no multi-agent crew, LangGraph/LangChain requirement, MCP layer, RAG, embeddings, vector database, Redis, queue workers, microservices, a separate FastAPI service, separate Python/JS gameplay logic, complex event sourcing, or enterprise audit infrastructure. The bounded controller and eight tables are enough.

**Generation:** no arbitrary generated JavaScript/HTML/SVG, model tool execution, generated audio/music/voice/art, uncontrolled code sandbox, unbounded repairs, hidden retries, paid model fallback, or generic conversation memory shared across the approval boundary.

**Validation:** no creativity scores, inferred preference truth, promised emotional quality, fake statistical significance, benchmark marathons, or guarantees that no LLM could independently invent a similar mechanic.

**Scope creep in revisions:** no changes to unrelated world/core definitions, automatic whole-scene rewrites, cross-slot mutable state, automatic profile expansion, or fresh Qloo calls for ordinary play and edits.

## 19. Judge-first success and the final 60-second path

### Submission gate

A first-time visitor must understand **“choose a cultural influence, play the consequence”** within 15 seconds. They must open a saved playable immediately, make a meaningful choice, see a changed option/consequence, inspect one four-layer provenance chain, apply or author a revision, and replay a different interaction. The public fresh-generation route must also be functional, although it is not required to complete inside the 60-second guided tour.

The scene must remain the largest visual element. No required reading of graphs, scores, trace logs, architecture diagrams, or lengthy onboarding. A failure must produce a finished, actionable error state rather than a forever spinner. This is a failure-handling requirement, not a promise that third-party services never fail.

**Practical acceptance:** keyboard completion; no critical overflow at 390px; a new browser opens the share; cached example can load without database/provider/Qloo; no secret or private rejected idea appears in a public response; at least one nonterminal action closes an ending; the same-prefix revision witness is real. Record observed load times rather than inventing a guaranteed performance figure.

### Sixty-second judge path

| Elapsed | What the judge does | What it establishes |
|---|---|---|
| 0–10 seconds | Open landing page, read the one-line promise, press “Play saved example.” | Immediate product comprehension; transparent pre-generated asset. |
| 10–25 seconds | Inspect the letter and ask about the second name, with the necessary context action visible. | A real stateful interaction; return becomes available. |
| 25–35 seconds | Open the Moon chip and see retrieved context → proposed idea → creator approval → gate. | The contribution is inspectable without dominating the game. |
| 35–45 seconds | Choose the explicitly labeled saved revision: disclosure now makes Nia refuse it. | A precise creator decision, not a whole-scene reroll. |
| 45–55 seconds | Replay the same three choices through the engine. | Return is now closed; room, character, object, and other choices are preserved. |
| 55–60 seconds | Open the read-only playable/share affordance and see “Create from your brief.” | The output is usable outside the editor; fresh creation is a separate real path. |

For a returning user or judge who selects arbitrary text, run the real generation path with honest stage status. Never make an arbitrary edit appear to finish instantly by mapping it silently to the saved preset.

### Current public submission requirements

The official 2026 rules currently require an agentic application using Qloo, a functional demo, publicly accessible source with an open-source license, English submission materials, and free judge access during evaluation [W7]. Explain the bounded controller's retrieval, approval wait, compilation, validation, and revision execution; do not claim that a large multi-agent architecture is required.

The rules list a submission deadline of **30 October 2026 at 11:45 p.m. Eastern Time**, with judging through **16 November 2026 at 11:45 p.m. Eastern Time** [W7]. Recheck the official page before submitting and keep the app, data, and keys accessible through judging. The 60-second walkthrough in this plan is a design recommendation, not a claim that the rules mandate exactly that video length.

## 20. Final architecture decision and implementation authority

This document chooses one product, one runtime, one provider, one deployment route, two cultural domains, two influence slots, and seven sequential phases. The minimum supported creative format is an object-handover dilemma, not arbitrary game creation. Schema restrictions are deliberate product boundaries, not unfinished general-engine features.

The largest **technical risk** is reliable generation of modules that are both mechanically meaningful and valid across every supported subset while staying inside a small repair/free-quota budget. Mitigate with a frozen foundation, independent ownership, small boolean state spaces, explicit ports, and hard validation. Measure the real success/failure rate during phase 4; do not weaken the checks merely to improve a promotional number.

The largest **product risk** is that the references and approvals feel like extra work for a generic interactive story. Mitigate with one strong default influence, compact approvals, excellent writing, and the visible before/after consequence. Qloo's retrieval provenance plus a causal software intervention is defensible; exceptional creative value still requires actual users and a persuasive artifact. This freeze is a build decision, not a claim of proven creative superiority or guaranteed prizes.

No implementation agent may quietly alter the domain set, ownership model, action grammar, code-execution prohibition, approval requirement, or budget ceilings. A genuine contradiction or provider availability problem goes into `docs/BUILD_STATUS.md` with evidence and a narrow proposed amendment; it must not trigger new product ideation or an unreported architecture replacement.

## Source register

### Supplied evidence

- **E1:** `FIRSTPLAYABLE.md`, run dated 3 October 2026; especially §§4, 6–12.
- **E2:** `CROSS_DOMAIN_STRUCTURE(2).md`, run dated 3 October 2026; especially §§4–5, 11–13.
- **E3:** `RECON(6).md`, reconnaissance dated 3 October 2026; especially §§1–3, 6.
- **E4:** `Texte collé(20261003-173324).txt`, the locked product and twenty-part requested blueprint.

### Official web verification — checked 3 October 2026

URLs below identify the checked sources for deployment/SDK/rules claims. They are not evidence that the user's own accounts, private key, or deployment have been tested.

- **W1:** Vercel, Hobby plan — `https://vercel.com/docs/plans/hobby`
- **W2:** Vercel, function limits — `https://vercel.com/docs/functions/limitations`
- **W3:** Google, Gemini Developer API pricing — `https://ai.google.dev/gemini-api/docs/pricing`
- **W4:** Google, structured output — `https://ai.google.dev/gemini-api/docs/structured-output`
- **W5:** Google, Gemini API rate limits — `https://ai.google.dev/gemini-api/docs/rate-limits`
- **W6:** Supabase, pricing/free-plan limits — `https://supabase.com/pricing`
- **W7:** Qloo Agentic Hackathon, official rules — `https://qloo.devpost.com/rules`
- **W8:** Qloo, hackathon developer guide — `https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide`
- **W9:** Zod, JSON Schema conversion — `https://zod.dev/json-schema`
- **W10:** Next.js, route handlers — `https://nextjs.org/docs/app/getting-started/route-handlers`
- **W11:** Hugging Face, Spaces overview — `https://huggingface.co/docs/hub/spaces-overview`

**Conflict handling:** W8 currently shows `urn:entity:video_game` and says POST fails. The supplied same-day live recon reports `urn:entity:videogame` working, `video_game` failing, and flat POST succeeding. This plan intentionally uses the observed working GET form with **`videogame`**. Phase 3 must smoke-test that exact form against the provided key. Do not silently replace live-observed behavior with the contradictory guide or imply the conflict has been resolved externally.

# LOCKED BUILD PLAN

**Product thesis:** FirstPlayable turns an explicitly chosen Qloo-discovered reference into a small playable interaction whose consequence the creator can revise and inspect.

**MVP scope:** one room, one player and one NPC, one object, three reachable endings, five verbs, movies and videogames from one confirmed artist, at most two approved influence modules, targeted revisions, immutable sharing, offline export, and one truthful saved example/comparator.

**Stack:** Next.js + React + TypeScript + Zod; pure shared TypeScript engine; Supabase Postgres; Vercel Hobby; Gemini Developer API `gemini-3.8-flash`; a three-operation Qloo adapter. No paid fallback.

**Architecture:** brief-only immutable foundation + independently compiled creator-approved modules + deterministic subset validation + local playback. One bounded controller; no shared cultural prompt history across the approval boundary.

**Phases:** seven. Execute **Phase 1: shared scene contract, engine, and offline vertical slice** first.

**Largest technical risk:** model-generated modules fail meaningful-consequence/subset-validity checks within the bounded repair and free-quota budgets.

**Largest product risk:** a creator sees generic story generation with reference paperwork rather than a useful playable creative decision. The canonical before/after interaction and writing quality must carry the experience.

# CLAUDE CODE PHASE 1 HANDOFF

```text
You are implementing Phase 1 only of the locked FirstPlayable v2 build.

Read docs/FIRSTPLAYABLE_V2_BUILD_SPEC.md in full. If it is not yet in the repo,
copy the supplied FIRSTPLAYABLE_V2_BUILD_SPEC.md there without changing its
content. The product is locked. Do not ideate, add domains, or reopen the
previous experiment verdict.

Inspect the repository and git status first. Preserve recon/, probes/, raw
local captures, and all previous reports. Do not discard existing uncommitted
work. Work on a dedicated feat/firstplayable-v2 branch when safe; document an
existing branch instead of overwriting it. Never print or commit secrets.

Goal: a local offline playable with a single shared typed engine and validator.
No Qloo, model, Supabase, authentication, or deployment in this phase.

Build:
1. Minimal Next.js/React/TypeScript scaffold with strict typing, compatible
   pinned dependencies, package-lock.json, and documented Node version.
2. Authoritative strict Zod contracts from specification section 4. Preserve
   all ownership, size, condition, and action limits. Derive TS types from Zod.
3. Pure shared interpreter, composer, deterministic validator, and mechanical
   diff under src/engine/. No eval, Function, generated JS, arbitrary expression
   strings, or separate test/runtime implementations.
4. Hand-authored design fixtures for The Second Copy: clean base, Discovery v1,
   Discovery v2. Use the supplied representative JSON. Keep design_fixture
   provenance; do not invent Qloo IDs or claim live retrieval.
5. Minimal /example player with the object, NPC dialogue, available actions,
   all endings, reset, and v1/v2/base switch. Gameplay is entirely local.
6. Focused Vitest and Playwright tests, fixture-check script, README commands,
   and docs/BUILD_STATUS.md recording actual results and known limitations.

Required semantics:
- One room, one NPC plus player, one object, exactly three endings, five verbs.
- At most twelve initially-false booleans; only set_true effects.
- All conditions/gates/hooks evaluate against pre-action state; exactly one
  branch applies; effects commit atomically; every nonterminal step progresses.
- Exhaustively check reachable states, all endings, no soft-lock/no-progress
  path, and a nonterminal choice that really removes an available ending.
- Modules cannot modify core/another module or read another module's flags.
- Validate base and every active-module subset. Reject resource overflow.
- No rejected/source references can authorize themselves through scene JSON;
  model/provider/database authority is not being implemented in Phase 1.

Binary exit checks:
- The base and both Discovery variants pass the actual TS validator.
- All three endings are reachable; removing Discovery restores the exact base.
- Replay core.inspect, core.ask_context, discovery.ask_identity:
  core.give is available in v1 and unavailable in v2.
- World/core hashes are identical between variants.
- Prose-only changes are not labeled mechanical.
- Invalid references, foreign writes, dead endings, loops, and excessive state
  budgets fail with explicit errors.
- The browser can play, reset, and switch versions with no upstream requests.
- npm run typecheck, npm test, npm run test:e2e, and npm run build pass.

Do not add polish beyond a clean readable player, model calls, database work,
sharing, export, the model-selected comparator, or later-phase features. Reuse
existing runtime code only after proving it obeys the new shared contracts.

At completion, report changed files, exact commands/results, the fixture's
reachability and same-prefix observations, remaining limitations, and the git
commit. Commit only the verified Phase 1 work; do not push unless authorized.
Stop after Phase 1. Do not claim later-phase functionality exists.
```
