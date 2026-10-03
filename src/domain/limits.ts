/**
 * Every numeric budget in one place, taken from specification section 4
 * ("Types and limits"). The validator and the Zod contracts both read these;
 * no limit is restated as a literal anywhere else.
 */

export const SLOTS = ["discovery", "commitment"] as const;
export const VERBS = ["inspect", "ask", "give", "withhold", "leave"] as const;
export const RESERVED_SPEAKER_IDS = ["player", "narrator"] as const;

export const ID_MAX = 64;

export const TEXT = {
  scene_title: 60,
  action_label: 90,
  variable_label: 90,
  dialogue: 600,
  ending_title: 60,
  ending_text: 1200,
  gate_blocked_text: 160,
  approved_interpretation: 700,
  proposed_interpretation: 500,
  narrative_total: 12_000,
} as const;

export const WORLD_TEXT = {
  player_role: 60,
  room_name: 120,
  room_description: 120,
  character_name: 40,
  character_role: 100,
  object_name: 60,
  object_description: 180,
  premise_min: 40,
  premise_max: 600,
  forbidden_phrase: 32,
  forbidden_count: 5,
  artist_query_min: 2,
  artist_query_max: 80,
} as const;

export const BUDGET = {
  core_variables: 6,
  module_variables: 3,
  total_variables: 12,
  core_actions: 10,
  module_actions: 4,
  total_actions: 18,
  core_dialogue: 12,
  module_dialogue: 6,
  module_gates: 3,
  module_on_actions: 2,
  endings: 3,
  branches_per_action: 3,
  effects_per_branch: 12,
  condition_clauses: 4,
  atoms_per_clause: 4,
  modules: 2,
  ending_copy_overrides: 3,
  serialized_bytes: 96 * 1024,
} as const;

/**
 * Graph analysis bounds. The nonterminal state bound is 2^12 because the flag
 * budget is twelve; depth is twelve progressing steps plus one terminal step.
 */
export const ANALYSIS = {
  max_states: 1 << BUDGET.total_variables,
  max_depth: BUDGET.total_variables + 1,
  max_witness_pairs: 20_000,
  min_actions_to_ending: 3,
  graph_time_budget_ms: 5_000,
} as const;

/** The fixed attachment ports. Model or fixture output cannot add a port. */
export const FIXED_PORTS = {
  discovery: {
    gate_action_ids: ["core.give"],
    effect_action_ids: ["core.inspect"],
  },
  commitment: {
    gate_action_ids: ["core.ask_terms", "core.withhold"],
    effect_action_ids: ["core.ask_context"],
  },
} as const;

export const REQUIRED_CORE_ACTIONS = {
  "core.inspect": "inspect",
  "core.ask_context": "ask",
  "core.ask_terms": "ask",
  "core.give": "give",
  "core.withhold": "withhold",
  "core.leave": "leave",
} as const;

export const REQUIRED_ENDING_IDS = ["end.give", "end.keep", "end.leave"] as const;

/** Terminal verb to ending mapping, from specification section 4. */
export const TERMINAL_ENDING_BY_ACTION = {
  "core.give": "end.give",
  "core.withhold": "end.keep",
  "core.leave": "end.leave",
} as const;

/** `inspect` targets the object, `ask` the NPC, give/withhold the object, leave the room. */
export const VERB_TARGET_KIND = {
  inspect: "object",
  ask: "character",
  give: "object",
  withhold: "object",
  leave: "room",
} as const;
