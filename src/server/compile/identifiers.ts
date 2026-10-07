/**
 * The identifiers a scene version records about how it was produced
 * (specification section 11, `scene_versions`).
 *
 * These are version strings, not configuration: changing a prompt, a
 * model-facing schema, the assembler, or the validator changes the identifier
 * in the same commit, so a stored version always says which of each produced
 * it. A compilation's idempotency key is derived from them too, which is what
 * makes "the same frozen inputs replay rather than regenerate" survive a
 * deployment that changes a prompt.
 */

/**
 * The compiler: payload builders, the deterministic base skeleton, the
 * assembler, and the stage controller.
 *
 * `4.1` was the Phase 4 recovery amendment: the clean base's mechanics moved
 * from model output to `base.ts`. `4.2` is the module amendment that followed
 * it, for the same reason and on the same evidence: a module's wiring —
 * identifiers, conditions, effects, branches, ports, and the flag's initial
 * value — moved out of model output and into `materializeMechanic` in
 * `assemble.ts`, leaving the module's genuine mechanical choices and its copy.
 */
export const COMPILER_IDENTIFIER = "fp-compiler-4.2";

/** The fixed instruction blocks in `instructions.ts`. */
export const PROMPT_IDENTIFIER = "fp-prompts-4.2";

/** The model-facing output contracts in `src/domain/compile.ts`. */
export const SCHEMA_IDENTIFIER = "fp-model-schema-4.2";

/**
 * The deterministic validator this application accepted a candidate with.
 *
 * It names the Phase 1 engine, because Phase 4 adds no second validator: the
 * same `validateScene`, `validateSceneSubsets`, and `findMechanicalWitness`
 * decide every candidate.
 *
 * It was deliberately **unchanged** by both Phase 4 amendments. `1.1` is the
 * consequential dilemma, and it is recorded here because it is a real change:
 * the validator gained the dilemma's structural and graph checks
 * (`src/engine/dilemma.ts`), and it grants exactly one exemption from the fixed
 * port table — a gate on a terminal action that a commitment module declares as
 * a dilemma stake. A module that declares no dilemma is judged by precisely the
 * rules of `1.0`, which is why every version stored before this still
 * revalidates unchanged.
 */
export const VALIDATOR_IDENTIFIER = "fp-engine-validator-1.1";

/**
 * The ending-copy prompt and its model-facing contract.
 *
 * Deliberately *separate* identifiers rather than a bump of the three above.
 * A compilation's idempotency key is derived from the compiler, prompt, and
 * schema identifiers, so bumping them would change every module stage's input
 * hash and force every project's existing, accepted modules to be compiled
 * again — which is precisely the "do not regenerate unrelated work" rule
 * Phase 5 exists to honour. Adding an ending-copy prompt changes nothing about
 * how a module is compiled, so it changes nothing about how one is keyed.
 */
export const COPY_PROMPT_IDENTIFIER = "fp-copy-prompts-5.0";
export const COPY_SCHEMA_IDENTIFIER = "fp-copy-schema-5.0";
