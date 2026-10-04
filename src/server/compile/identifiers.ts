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
 * It is deliberately **unchanged** by both Phase 4 amendments, while the three
 * identifiers above moved twice. That is the claim "the validator was not
 * weakened to accommodate generated output", recorded where a stored version
 * can be read back and checked against it.
 */
export const VALIDATOR_IDENTIFIER = "fp-engine-validator-1.0";
