/**
 * Authoritative scene contract (specification section 4).
 *
 * These strict Zod schemas are the single runtime contract; every TypeScript
 * type in the engine is derived from them. Unknown keys are rejected
 * everywhere. Conditions are structured data: there is no expression string,
 * no executable string, and no effect other than `set_true`.
 *
 * `parseScene` covers shape, enumerations, local consistency, and every size
 * budget. Cross-cutting authority questions — namespace ownership, reference
 * resolution, port attachment, brief conformance — belong to
 * `validateScene` in `src/engine/validate.ts`, which reports them as readable
 * findings rather than as parse errors.
 */

import { z } from "zod";
import {
  BUDGET,
  ID_MAX,
  SLOTS,
  TEXT,
  VERBS,
  VERB_TARGET_KIND,
} from "./limits";
import { codePointLength, isPlainText } from "./text";

/* ------------------------------------------------------------------ atoms */

const ID_PATTERN = /^[a-z][a-z0-9_.-]*$/;

export const IdSchema = z
  .string()
  .min(1)
  .max(ID_MAX)
  .regex(ID_PATTERN, "must match /^[a-z][a-z0-9_.-]*$/ and use ASCII only");

/** Plain text bounded by code points, as the specification states its caps. */
export function boundedText(max: number, min = 1): z.ZodType<string> {
  return z
    .string()
    .refine((value) => codePointLength(value) >= min, {
      message: `must be at least ${min} code point(s)`,
    })
    .refine((value) => codePointLength(value) <= max, {
      message: `must be at most ${max} code point(s)`,
    })
    .refine(isPlainText, {
      message: "must be plain text without control characters",
    });
}

export const SlotSchema = z.enum(SLOTS);
export const VerbSchema = z.enum(VERBS);

export const AtomSchema = z.strictObject({
  var_id: IdSchema,
  equals: z.boolean(),
});

const AnyConditionSchema = z.strictObject({
  kind: z.literal("any"),
  clauses: z
    .array(z.array(AtomSchema).min(1).max(BUDGET.atoms_per_clause))
    .min(1)
    .max(BUDGET.condition_clauses),
});

export const ConditionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("always") }),
    z.strictObject({ kind: z.literal("never") }),
    AnyConditionSchema,
  ])
  .refine(
    (condition) => {
      if (condition.kind !== "any") return true;
      return condition.clauses.every((clause) => {
        const seen = new Map<string, boolean>();
        for (const atom of clause) {
          const previous = seen.get(atom.var_id);
          // Duplicate (same polarity) and contradictory (opposite polarity)
          // atoms in one AND clause are both rejected.
          if (previous !== undefined) return false;
          seen.set(atom.var_id, atom.equals);
        }
        return true;
      });
    },
    { message: "a clause cannot repeat or contradict a variable" },
  );

export const EffectSchema = z.strictObject({
  op: z.literal("set_true"),
  var_id: IdSchema,
});

export const StateVariableSchema = z.strictObject({
  id: IdSchema,
  label: boundedText(TEXT.variable_label),
  initial: z.literal(false),
  visible: z.boolean(),
});

export const TargetSchema = z.strictObject({
  kind: z.enum(["room", "character", "object"]),
  id: IdSchema,
});

export const DialogueNodeSchema = z.strictObject({
  id: IdSchema,
  speaker_id: IdSchema,
  text: boundedText(TEXT.dialogue),
});

export const ActionBranchSchema = z.strictObject({
  when: ConditionSchema,
  effects: z.array(EffectSchema).max(BUDGET.effects_per_branch),
  dialogue_id: IdSchema.nullable(),
  ending_id: IdSchema.nullable(),
});

export const ActionSchema = z
  .strictObject({
    id: IdSchema,
    verb: VerbSchema,
    label: boundedText(TEXT.action_label),
    target: TargetSchema,
    when: ConditionSchema,
    branches: z
      .array(ActionBranchSchema)
      .min(1)
      .max(BUDGET.branches_per_action),
  })
  .refine((action) => VERB_TARGET_KIND[action.verb] === action.target.kind, {
    message: "verb and target kind must match the fixed action grammar",
    path: ["target", "kind"],
  });

export const EndingSchema = z.strictObject({
  id: IdSchema,
  title: boundedText(TEXT.ending_title),
  text: boundedText(TEXT.ending_text),
});

export const RoomSchema = z.strictObject({
  id: IdSchema,
  name: boundedText(120),
  description: boundedText(120),
});

export const CharacterSchema = z.strictObject({
  id: IdSchema,
  name: boundedText(40),
  role: boundedText(100),
});

export const ImportantObjectSchema = z.strictObject({
  id: IdSchema,
  name: boundedText(60),
  description: boundedText(180),
});

export const CoreSceneSchema = z.strictObject({
  variables: z.array(StateVariableSchema).max(BUDGET.core_variables),
  actions: z.array(ActionSchema).min(1).max(BUDGET.core_actions),
  dialogue: z.array(DialogueNodeSchema).max(BUDGET.core_dialogue),
  endings: z.array(EndingSchema).length(BUDGET.endings),
});

export const GateSchema = z.strictObject({
  id: IdSchema,
  action_id: IdSchema,
  when: ConditionSchema,
  blocked_text: boundedText(TEXT.gate_blocked_text),
});

export const OnActionSchema = z.strictObject({
  id: IdSchema,
  action_id: IdSchema,
  when: ConditionSchema,
  effects: z.array(EffectSchema).max(BUDGET.effects_per_branch),
  dialogue_id: IdSchema.nullable(),
});

export const InfluenceModuleSchema = z.strictObject({
  slot: SlotSchema,
  approval_id: IdSchema,
  variables: z.array(StateVariableSchema).max(BUDGET.module_variables),
  actions: z.array(ActionSchema).max(BUDGET.module_actions),
  dialogue: z.array(DialogueNodeSchema).max(BUDGET.module_dialogue),
  gates: z.array(GateSchema).max(BUDGET.module_gates),
  on_actions: z.array(OnActionSchema).max(BUDGET.module_on_actions),
});

export const PortSchema = z.strictObject({
  gate_action_ids: z.array(IdSchema).max(BUDGET.core_actions),
  effect_action_ids: z.array(IdSchema).max(BUDGET.core_actions),
});

export const InfluenceReferenceSchema = z.strictObject({
  approval_id: IdSchema,
  reference_id: IdSchema,
  source_kind: z.enum(["qloo", "model_selected", "design_fixture"]),
  approved_text: boundedText(TEXT.approved_interpretation),
  intended_effect: boundedText(TEXT.proposed_interpretation),
});

export const ProvenanceSchema = z.strictObject({
  approval_id: IdSchema,
  mechanic_ids: z.array(IdSchema).min(1).max(16),
});

export const EndingCopyOverrideSchema = z.strictObject({
  ending_id: IdSchema,
  text: boundedText(TEXT.ending_text),
  creator_edit_id: IdSchema,
});

export const WorldSchema = z.strictObject({
  player_role: boundedText(60),
  room: RoomSchema,
  /** Exactly one NPC. A tuple, so a second character is a type error. */
  characters: z.tuple([CharacterSchema]),
  object: ImportantObjectSchema,
});

const SceneShapeSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  scene_id: IdSchema,
  title: boundedText(TEXT.scene_title),
  world: WorldSchema,
  core: CoreSceneSchema,
  ports: z.strictObject({ discovery: PortSchema, commitment: PortSchema }),
  modules: z.array(InfluenceModuleSchema).max(BUDGET.modules),
  ending_copy_overrides: z
    .array(EndingCopyOverrideSchema)
    .max(BUDGET.ending_copy_overrides),
  influences: z.array(InfluenceReferenceSchema).max(BUDGET.modules),
  provenance: z.array(ProvenanceSchema).max(BUDGET.modules),
});

type SceneShape = z.infer<typeof SceneShapeSchema>;

function narrativeCodePoints(scene: SceneShape): number {
  const parts: string[] = [
    scene.title,
    scene.world.player_role,
    scene.world.room.name,
    scene.world.room.description,
    scene.world.characters[0].name,
    scene.world.characters[0].role,
    scene.world.object.name,
    scene.world.object.description,
  ];
  for (const node of scene.core.dialogue) parts.push(node.text);
  for (const action of scene.core.actions) parts.push(action.label);
  for (const variable of scene.core.variables) parts.push(variable.label);
  for (const ending of scene.core.endings) parts.push(ending.title, ending.text);
  for (const override of scene.ending_copy_overrides) parts.push(override.text);
  for (const influence of scene.influences) {
    parts.push(influence.approved_text, influence.intended_effect);
  }
  for (const module of scene.modules) {
    for (const node of module.dialogue) parts.push(node.text);
    for (const action of module.actions) parts.push(action.label);
    for (const variable of module.variables) parts.push(variable.label);
    for (const gate of module.gates) parts.push(gate.blocked_text);
  }
  return parts.reduce((total, part) => total + codePointLength(part), 0);
}

export const SceneSchema = SceneShapeSchema.refine(
  (scene) =>
    scene.core.variables.length +
      scene.modules.reduce((n, module) => n + module.variables.length, 0) <=
    BUDGET.total_variables,
  { message: `total state variables must be at most ${BUDGET.total_variables}` },
)
  .refine(
    (scene) =>
      scene.core.actions.length +
        scene.modules.reduce((n, module) => n + module.actions.length, 0) <=
      BUDGET.total_actions,
    { message: `total actions must be at most ${BUDGET.total_actions}` },
  )
  .refine(
    (scene) => new Set(scene.modules.map((m) => m.slot)).size === scene.modules.length,
    { message: "at most one module per influence slot" },
  )
  .refine((scene) => narrativeCodePoints(scene) <= TEXT.narrative_total, {
    message: `total narrative text must be at most ${TEXT.narrative_total} code points`,
  })
  .refine(
    (scene) =>
      new TextEncoder().encode(JSON.stringify(scene)).byteLength <=
      BUDGET.serialized_bytes,
    { message: `serialized scene must be at most ${BUDGET.serialized_bytes} bytes` },
  );

/* ------------------------------------------------------------------ types */

export type Id = z.infer<typeof IdSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type Verb = z.infer<typeof VerbSchema>;
export type Atom = z.infer<typeof AtomSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type StateVariable = z.infer<typeof StateVariableSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type DialogueNode = z.infer<typeof DialogueNodeSchema>;
export type ActionBranch = z.infer<typeof ActionBranchSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Ending = z.infer<typeof EndingSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Character = z.infer<typeof CharacterSchema>;
export type ImportantObject = z.infer<typeof ImportantObjectSchema>;
export type CoreScene = z.infer<typeof CoreSceneSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type OnAction = z.infer<typeof OnActionSchema>;
export type InfluenceModule = z.infer<typeof InfluenceModuleSchema>;
export type Port = z.infer<typeof PortSchema>;
export type InfluenceReference = z.infer<typeof InfluenceReferenceSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type EndingCopyOverride = z.infer<typeof EndingCopyOverrideSchema>;
export type World = z.infer<typeof WorldSchema>;
export type Scene = z.infer<typeof SceneSchema>;

/* ------------------------------------------------------------------ parse */

export class SceneParseError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    super(`scene failed schema validation:\n${formatIssues(issues)}`);
    this.name = "SceneParseError";
    this.issues = issues;
  }
}

export function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  ${path}: ${issue.message}`;
    })
    .join("\n");
}

/** Throwing parse, used where an invalid scene must not reach the player. */
export function parseScene(input: unknown): Scene {
  const result = SceneSchema.safeParse(input);
  if (!result.success) throw new SceneParseError(result.error.issues);
  return result.data;
}

/** Non-throwing parse, used by the validator and by shape checks in the UI. */
export function safeParseScene(
  input: unknown,
): { ok: true; scene: Scene } | { ok: false; issues: readonly z.core.$ZodIssue[] } {
  const result = SceneSchema.safeParse(input);
  return result.success
    ? { ok: true, scene: result.data }
    : { ok: false, issues: result.error.issues };
}
