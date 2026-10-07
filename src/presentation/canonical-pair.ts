/**
 * The real Phase 6 canonical comparison pair, as stored.
 *
 * Every string the judge path shows about the saved example is read from the
 * three files recorded in docs/PHASE6_CANONICAL_PAIR.md: the With-Moon version
 * row, the Without-Moon version row (which carries the stored revision diff),
 * and the provenance capture. Nothing here was written by hand, and nothing is
 * fetched: the files are bundled, so the saved example plays with no database,
 * model, or Qloo call.
 *
 * The schemas below read only the fields the presentation uses. Identifiers,
 * hashes, and validator internals stay in the files; they never reach a
 * judge-facing string.
 */

import { z } from "zod";
import { parseScene } from "../domain/scene";
import type { Id, Scene } from "../domain/scene";
import provenanceJson from "../../docs/phase6-canonical-pair/provenance.json";
import withMoonJson from "../../docs/phase6-canonical-pair/with-moon.version.json";
import withoutMoonJson from "../../docs/phase6-canonical-pair/without-moon.version.json";

const ApprovalSnapshotSchema = z.object({
  domain: z.string(),
  reference_name: z.string(),
  proposed_idea: z.string(),
  approved_text: z.string(),
  intended_effect: z.string(),
  edited_by_creator: z.boolean(),
});

const WitnessSchema = z.object({
  kind: z.string(),
  action_id: z.string(),
  before: z.enum(["enabled", "locked", "hidden"]),
  after: z.enum(["enabled", "locked", "hidden"]),
  prefix: z.array(z.string()),
  mechanical: z.boolean(),
  pairs_explored: z.number(),
});

const WithVersionSchema = z.object({
  approval_snapshot: z.array(ApprovalSnapshotSchema).length(1),
  validation_summary: z.object({
    witnesses: z.array(WitnessSchema),
    reachable_endings: z.array(z.string()),
  }),
  scene: z.unknown(),
});

const WithoutVersionSchema = z.object({
  validation_summary: z.object({ reachable_endings: z.array(z.string()) }),
  revision_diff: z.object({
    changed_by: z.string(),
    label: z.string(),
    replay: z.object({
      prefix: z.array(z.string()),
      changed_action_ids: z.array(z.string()),
      prefix_legal_in_before: z.boolean(),
      prefix_legal_in_after: z.boolean(),
    }),
  }),
  scene: z.unknown(),
});

const ProvenanceFileSchema = z.object({
  capture: z.object({ artist_entity_id: z.string() }),
  decision: z.object({
    proposal_snapshot: z.object({
      proposal: z.object({ intended_interaction: z.string() }),
    }),
  }),
  reference: z.object({
    name: z.string(),
    year: z.number(),
    original_rank: z.number(),
    disambiguation: z.string(),
  }),
  evidence: z.array(z.object({ kind: z.string(), text: z.string() })),
});

export type Availability = "enabled" | "locked" | "hidden";

/**
 * The confirmed artist of the saved example. The provenance file stores only
 * the artist's Qloo entity id; the name is the one recorded for that id in
 * docs/PHASE6_CANONICAL_PAIR.md (the stored Radiohead search capture). It is
 * keyed by the id, so a record with any other artist refuses to load rather
 * than showing the wrong name.
 */
const RECORDED_ARTISTS: Readonly<Record<string, string>> = {
  "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C": "Radiohead",
};

/** The four causal layers, as stored. */
export type CausalRecord = {
  /** The artist the creator confirmed, whose Qloo neighbours were retrieved. */
  readonly artist: { readonly name: string };
  /** Qloo returned this reference. */
  readonly source: {
    readonly name: string;
    /** "film", from the stored proposal domain. */
    readonly kind: string;
    readonly year: number;
    /** The stored disambiguation without its leading year: "Duncan Jones". */
    readonly maker: string;
    readonly rank: number;
    readonly theme: string | null;
    readonly tone: string | null;
  };
  /** FirstPlayable proposed this. */
  readonly proposed: {
    readonly idea: string;
    readonly interaction: string;
  };
  /** The creator edited (or accepted) and approved this. */
  readonly decision: {
    readonly approvedText: string;
    readonly intendedEffect: string;
    readonly editedByCreator: boolean;
  };
  /** The scene's own check observed this. */
  readonly witness: {
    readonly actionId: Id;
    /** Availability without the influence. */
    readonly without: Availability;
    /** Availability with the influence. */
    readonly with: Availability;
    readonly prefix: readonly Id[];
    readonly pairsExplored: number;
  } | null;
  readonly reachableEndings: { readonly with: number; readonly without: number };
};

export type CanonicalPair = {
  /** The version that includes the approved influence. */
  readonly withScene: Scene;
  /** The same scene with that influence removed. */
  readonly withoutScene: Scene;
  /** The influence's display name, from the approval snapshot: "Moon". */
  readonly influenceName: string;
  /** The stored comparison point, `revision_diff.replay.prefix`. */
  readonly recordedPrefix: readonly Id[];
  /** The stored diff's own changed set, kept for verification only. */
  readonly storedChangedActionIds: readonly Id[];
  readonly causal: CausalRecord;
};

const DOMAIN_NOUNS: Readonly<Record<string, string>> = {
  movie: "film",
  game: "game",
};

function makerOf(disambiguation: string, year: number): string {
  const prefix = `${year}, `;
  return disambiguation.startsWith(prefix)
    ? disambiguation.slice(prefix.length)
    : disambiguation;
}

export function buildCanonicalPair(
  withRaw: unknown,
  withoutRaw: unknown,
  provenanceRaw: unknown,
): CanonicalPair {
  const withVersion = WithVersionSchema.parse(withRaw);
  const withoutVersion = WithoutVersionSchema.parse(withoutRaw);
  const provenance = ProvenanceFileSchema.parse(provenanceRaw);
  const approval = withVersion.approval_snapshot[0] as z.infer<typeof ApprovalSnapshotSchema>;
  const witness = withVersion.validation_summary.witnesses.find((entry) => entry.mechanical);
  const artistName = RECORDED_ARTISTS[provenance.capture.artist_entity_id];
  if (artistName === undefined) {
    throw new Error("canonical pair: the provenance capture's artist is not the recorded one");
  }
  const evidence = (kind: string): string | null =>
    provenance.evidence.find((entry) => entry.kind === kind)?.text ?? null;

  return {
    withScene: parseScene(withVersion.scene),
    withoutScene: parseScene(withoutVersion.scene),
    influenceName: approval.reference_name,
    recordedPrefix: withoutVersion.revision_diff.replay.prefix,
    storedChangedActionIds: withoutVersion.revision_diff.replay.changed_action_ids,
    causal: {
      artist: { name: artistName },
      source: {
        name: provenance.reference.name,
        kind: DOMAIN_NOUNS[approval.domain] ?? approval.domain,
        year: provenance.reference.year,
        maker: makerOf(provenance.reference.disambiguation, provenance.reference.year),
        rank: provenance.reference.original_rank,
        theme: evidence("theme"),
        tone: evidence("tone"),
      },
      proposed: {
        idea: approval.proposed_idea,
        interaction: provenance.decision.proposal_snapshot.proposal.intended_interaction,
      },
      decision: {
        approvedText: approval.approved_text,
        intendedEffect: approval.intended_effect,
        editedByCreator: approval.edited_by_creator,
      },
      witness:
        witness === undefined
          ? null
          : {
              actionId: witness.action_id,
              // A witness reads "before" as without the influence and "after"
              // as with it.
              without: witness.before,
              with: witness.after,
              prefix: witness.prefix,
              pairsExplored: witness.pairs_explored,
            },
      reachableEndings: {
        with: withVersion.validation_summary.reachable_endings.length,
        without: withoutVersion.validation_summary.reachable_endings.length,
      },
    },
  };
}

/** Parsed once at module load, so a malformed record can never reach the page. */
export const CANONICAL_PAIR: CanonicalPair = buildCanonicalPair(
  withMoonJson,
  withoutMoonJson,
  provenanceJson,
);
