/**
 * The bounded foreground decision: which confirmed comp in one domain leads
 * for one audience.
 *
 * Pure, and deliberately thin. The call is read straight off
 * `rankForAudience`'s `top` status, so it can never disagree with the ranking
 * the page shows:
 *
 *   * `clear`  -> **clear_lead**: one comp leads every other scored comp by at
 *     least {@link AUDITION_CLOSE_THRESHOLD}.
 *   * `close`  -> **too_close**: the comps within the threshold of the top
 *     value, and no leader.
 *   * `single` / `none`, or no confirmed comps in the domain ->
 *     **insufficient_evidence**.
 *
 * Only comps of the requested domain are ever considered: the input is one
 * domain's view, so a movie affinity is never set against a videogame one.
 * The model that recorded the question supplies none of this.
 */

import { AUDITION_CLOSE_THRESHOLD, type DecisionRequest } from "./audition";
import type { ConfirmedEntityView, DomainAuditionView } from "./audition-view";
import type { QlooDomain } from "./qloo";

type Named = { entity_id: string; name: string };

export type DecisionOutcome =
  | { status: "clear_lead"; lead: Named }
  | { status: "too_close"; close: Named[] }
  | { status: "insufficient_evidence"; reason: "no_comps" | "single_comp" | "no_scores" };

export type DecisionResult = {
  action: "foreground_comp";
  domain: QlooDomain;
  audience_entity_id: string;
  audience_name: string;
  threshold: number;
  outcome: DecisionOutcome;
  /** Confirmed comps Qloo returned no score for. They take no part in the call. */
  not_scored: Named[];
};

export function decideForeground(
  request: DecisionRequest,
  view: DomainAuditionView | null,
  audience: ConfirmedEntityView,
): DecisionResult {
  const base = {
    action: request.action,
    domain: request.domain,
    audience_entity_id: audience.entity_id,
    audience_name: audience.name,
    threshold: AUDITION_CLOSE_THRESHOLD,
  };
  if (view === null) {
    return { ...base, outcome: { status: "insufficient_evidence", reason: "no_comps" }, not_scored: [] };
  }
  if (view.domain !== request.domain) throw new Error("Decision domain mismatch");
  const ranking = view.comparison.rankings.find((r) => r.audience_entity_id === audience.entity_id);
  if (ranking === undefined) throw new Error("Decision audience mismatch");
  const name = (id: string): Named => ({ entity_id: id, name: ranking.ordered.find((row) => row.entity_id === id)!.name });
  const { status, leaders } = ranking.top;
  const outcome: DecisionOutcome =
    status === "clear" ? { status: "clear_lead", lead: name(leaders[0]!) }
    : status === "close" ? { status: "too_close", close: leaders.map(name) }
    : { status: "insufficient_evidence", reason: status === "single" ? "single_comp" : "no_scores" };
  return { ...base, outcome, not_scored: ranking.unscored };
}

const NOUN: Record<QlooDomain, string> = { movie: "movie", videogame: "game" };

export function decisionQuestion(result: Pick<DecisionResult, "domain" | "audience_name">): string {
  return `Which ${NOUN[result.domain]} comp should I foreground for ${result.audience_name} fans?`;
}

/** The exact answer the page shows. A fixed template, never model text. */
export function decisionAnswer(result: DecisionResult): string {
  const noun = NOUN[result.domain];
  const { outcome } = result;
  switch (outcome.status) {
    case "clear_lead":
      return `For this audience signal, ${outcome.lead.name} is the clear lead among your confirmed ${noun} comps.`;
    case "too_close":
      return `These top ${noun} comps are too close for this tool to call: ${outcome.close.map((c) => c.name).join(", ")}.`;
    case "insufficient_evidence":
      return outcome.reason === "no_comps"
        ? `You have no confirmed ${noun} comps, so this tool makes no call.`
        : outcome.reason === "single_comp"
          ? `Only one confirmed ${noun} comp has a Qloo score for this audience, so there is nothing to call it against.`
          : `Qloo returned no scores for your confirmed ${noun} comps for this audience, so this tool makes no call.`;
  }
}
