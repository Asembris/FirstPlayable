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

/** The compiler: payload builders, assembler, and stage controller. */
export const COMPILER_IDENTIFIER = "fp-compiler-4.0";

/** The fixed instruction blocks in `instructions.ts`. */
export const PROMPT_IDENTIFIER = "fp-prompts-4.0";

/** The model-facing output contracts in `src/domain/compile.ts`. */
export const SCHEMA_IDENTIFIER = "fp-model-schema-4.0";

/**
 * The deterministic validator this application accepted a candidate with.
 *
 * It names the Phase 1 engine, because Phase 4 adds no second validator: the
 * same `validateScene`, `validateSceneSubsets`, and `findMechanicalWitness`
 * decide every candidate.
 */
export const VALIDATOR_IDENTIFIER = "fp-engine-validator-1.0";
