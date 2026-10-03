/**
 * Brief constraints (specification section 1, "Inputs").
 *
 * The brief is the frozen creator input. The scene foundation is generated
 * from it alone; the validator compares the scene's world against it. Phase 1
 * authors the brief by hand, so `cultural_anchor_query` is present for shape
 * completeness but is null in every Phase 1 fixture: no artist has been
 * resolved, and nothing here has been retrieved from any service.
 */

import { z } from "zod";
import { boundedText, IdSchema } from "./scene";
import { WORLD_TEXT } from "./limits";
import { codePointLength } from "./text";

export const ToneSchema = z.enum(["tense", "intimate", "wry"]);

export const BriefSchema = z
  .strictObject({
    title: boundedText(60).nullable(),
    premise: boundedText(WORLD_TEXT.premise_max, WORLD_TEXT.premise_min),
    player_role: boundedText(WORLD_TEXT.player_role),
    room: z.strictObject({
      id: IdSchema,
      name: boundedText(WORLD_TEXT.room_name),
      description: boundedText(WORLD_TEXT.room_description),
    }),
    character: z.strictObject({
      id: IdSchema,
      name: boundedText(WORLD_TEXT.character_name),
      role: boundedText(WORLD_TEXT.character_role),
    }),
    object: z.strictObject({
      id: IdSchema,
      name: boundedText(WORLD_TEXT.object_name),
      description: boundedText(WORLD_TEXT.object_description),
    }),
    tone: ToneSchema,
    /** Artist query text only. Identity confirmation arrives in phase 3. */
    cultural_anchor_query: z
      .string()
      .refine(
        (value) =>
          codePointLength(value) >= WORLD_TEXT.artist_query_min &&
          codePointLength(value) <= WORLD_TEXT.artist_query_max,
        {
          message: `must be ${WORLD_TEXT.artist_query_min}-${WORLD_TEXT.artist_query_max} code points`,
        },
      )
      .nullable(),
    forbidden_wording: z
      .array(boundedText(WORLD_TEXT.forbidden_phrase))
      .max(WORLD_TEXT.forbidden_count),
  })
  .refine(
    (brief) =>
      new Set([brief.room.id, brief.character.id, brief.object.id]).size === 3,
    { message: "room, character, and object ids must differ" },
  );

export type Brief = z.infer<typeof BriefSchema>;
export type Tone = z.infer<typeof ToneSchema>;

export function parseBrief(input: unknown): Brief {
  return BriefSchema.parse(input);
}

/** Working title derivation when the creator left the title empty. */
export function workingTitle(brief: Brief): string {
  if (brief.title !== null) return brief.title;
  const words = brief.premise.trim().split(/\s+/u).slice(0, 6).join(" ");
  const derived = words.replace(/[.,;:!?]+$/u, "");
  return codePointLength(derived) > 60 ? [...derived].slice(0, 60).join("") : derived;
}
